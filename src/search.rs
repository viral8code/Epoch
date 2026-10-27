//! Searching the workspace: the file list for quick open, and find/replace across files. Walks
//! respect `.gitignore`, skip large and binary files, and stop at fixed limits.

use crate::bail;
use crate::error::AppResult;
use crate::state::AppState;
use crate::workspace::display;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, State};

const MAX_FILES: usize = 100_000;
const MAX_SEARCH_FILE: u64 = 8 * 1024 * 1024;
const MAX_MATCHES: usize = 20_000;

#[derive(Default)]
pub struct SearchManager {
    generation: AtomicU64,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Query {
    pattern: String,
    #[serde(default)]
    regex: bool,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    whole_word: bool,
    /// Glob such as `*.rw`; empty means every file.
    #[serde(default)]
    include: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Match {
    line: usize,
    /// UTF-16 columns (1-based), as the editor counts them.
    column: usize,
    end_column: usize,
    preview: String,
}

fn compile(query: &Query) -> AppResult<Regex> {
    if query.pattern.is_empty() || query.pattern.len() > 1000 {
        bail!("検索語が空か、長すぎます");
    }
    let mut pattern = if query.regex {
        query.pattern.clone()
    } else {
        regex::escape(&query.pattern)
    };
    if query.whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!query.case_sensitive)
        .multi_line(true)
        .size_limit(8 * 1024 * 1024)
        .dfa_size_limit(8 * 1024 * 1024)
        .build()
        .map_err(|e| format!("正規表現が正しくありません: {e}").into())
}

fn walker(root: &Path, include: &str) -> AppResult<ignore::Walk> {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(true)
        .follow_links(false)
        .git_ignore(true)
        .git_global(false)
        .require_git(false);
    let mut overrides = ignore::overrides::OverrideBuilder::new(root);
    overrides
        .add("!.rewind/")
        .and_then(|o| o.add("!target/"))
        .map_err(|e| e.to_string())?;
    for glob in include.split(',').map(str::trim).filter(|g| !g.is_empty()) {
        overrides.add(glob).map_err(|e| format!("{glob}: {e}"))?;
    }
    builder.overrides(overrides.build().map_err(|e| e.to_string())?);
    Ok(builder.build())
}

fn files(root: &Path, include: &str) -> AppResult<impl Iterator<Item = PathBuf> + use<>> {
    Ok(walker(root, include)?
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_some_and(|t| t.is_file()))
        .map(ignore::DirEntry::into_path)
        .take(MAX_FILES))
}

fn read_text(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_SEARCH_FILE {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    if body.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    String::from_utf8(body.to_vec()).ok()
}

fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// Relative paths of the workspace's files, for quick open.
#[tauri::command]
pub async fn list_workspace_files(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let root = state.workspace.require_root()?;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<Vec<String>> {
        Ok(files(&root, "")?
            .filter_map(|p| {
                p.strip_prefix(&root)
                    .ok()
                    .map(|r| r.to_string_lossy().into_owned())
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Starts a search; results stream as `search-result` events and end with `search-done`. A new
/// search cancels the previous one.
#[tauri::command]
pub fn search_start(app: AppHandle, state: State<'_, AppState>, query: Query) -> AppResult<u64> {
    let root = state.workspace.require_root()?;
    let regex = compile(&query)?;
    let generation = state.search.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let walk = files(&root, &query.include)?;
    std::thread::spawn(move || {
        use tauri::Manager;
        let current = || {
            app.try_state::<AppState>()
                .is_some_and(|s| s.search.generation.load(Ordering::SeqCst) == generation)
        };
        let (mut total, mut searched) = (0usize, 0usize);
        for path in walk {
            if total >= MAX_MATCHES || !current() {
                break;
            }
            let Some(text) = read_text(&path) else {
                continue;
            };
            searched += 1;
            let mut matches = Vec::new();
            for (index, line) in text.lines().enumerate() {
                for found in regex.find_iter(line) {
                    if found.start() == found.end() {
                        continue;
                    }
                    let column = utf16_len(&line[..found.start()]) + 1;
                    let preview: String = line.chars().take(400).collect();
                    matches.push(Match {
                        line: index + 1,
                        column,
                        end_column: column + utf16_len(found.as_str()),
                        preview,
                    });
                    total += 1;
                    if total >= MAX_MATCHES {
                        break;
                    }
                }
                if total >= MAX_MATCHES {
                    break;
                }
            }
            if !matches.is_empty() {
                let _ = app.emit(
                    "search-result",
                    json!({"generation": generation, "path": display(&path), "matches": matches}),
                );
            }
        }
        let _ = app.emit(
            "search-done",
            json!({"generation": generation, "total": total, "files": searched, "limited": total >= MAX_MATCHES}),
        );
    });
    Ok(generation)
}

#[tauri::command]
pub fn search_cancel(state: State<'_, AppState>) {
    state.search.generation.fetch_add(1, Ordering::SeqCst);
}

/// Replaces every match in the given files (which must be inside the workspace). Returns the
/// number of replacements. Files open in the editor are handled by the frontend instead.
#[tauri::command]
pub async fn search_replace(
    state: State<'_, AppState>,
    query: Query,
    replacement: String,
    paths: Vec<String>,
) -> AppResult<usize> {
    let regex = compile(&query)?;
    if paths.len() > MAX_FILES || replacement.len() > 100_000 {
        bail!("置換の対象が多すぎます");
    }
    let resolved = paths
        .iter()
        .map(|p| state.workspace.resolve_in_root(p))
        .collect::<AppResult<Vec<_>>>()?;
    let literal = !query.regex;
    tauri::async_runtime::spawn_blocking(move || -> AppResult<usize> {
        let mut count = 0;
        for path in resolved {
            let Ok(bytes) = std::fs::read(&path) else {
                continue;
            };
            let bom = bytes.starts_with(b"\xEF\xBB\xBF");
            let Some(text) = read_text(&path) else {
                continue;
            };
            let found = regex
                .find_iter(&text)
                .filter(|m| !m.as_str().is_empty())
                .count();
            if found == 0 {
                continue;
            }
            let replaced = if literal {
                regex.replace_all(&text, regex::NoExpand(&replacement))
            } else {
                regex.replace_all(&text, replacement.as_str())
            };
            let mut out = Vec::with_capacity(replaced.len() + 3);
            if bom {
                out.extend_from_slice(b"\xEF\xBB\xBF");
            }
            out.extend_from_slice(replaced.as_bytes());
            crate::files::atomic_write(&path, &out)?;
            count += found;
        }
        Ok(count)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn query(pattern: &str, regex: bool) -> Query {
        Query {
            pattern: pattern.into(),
            regex,
            case_sensitive: true,
            whole_word: false,
            include: String::new(),
        }
    }

    #[test]
    fn literal_patterns_are_escaped() {
        let r = compile(&query("a.b(", false)).unwrap();
        assert!(r.is_match("xa.b(y"));
        assert!(!r.is_match("axb("));
        assert!(compile(&query("(", true)).is_err());
        assert!(compile(&query("", false)).is_err());
    }

    #[test]
    fn columns_are_utf16() {
        assert_eq!(utf16_len("あ𝄞"), 3);
    }
}
