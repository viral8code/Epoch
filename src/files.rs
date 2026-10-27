//! File commands. Reads are size-limited and must be UTF-8 text; writes go to a temporary file in
//! the same directory and are renamed over the target, so a crash never leaves half a file.

use crate::bail;
use crate::error::AppResult;
use crate::state::AppState;
use crate::workspace::{display, validate_file_name};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::State;

const MAX_TEXT_FILE: u64 = 32 * 1024 * 1024;
const MAX_DIR_ENTRIES: usize = 20_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_symlink: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    path: String,
    text: String,
    stamp: FileStamp,
    bom: bool,
    read_only: bool,
}

/// What the editor remembers about the file on disk, to notice changes made by other programs.
#[derive(Serialize, serde::Deserialize, PartialEq, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    modified_ms: u64,
    len: u64,
}

fn stamp_of(path: &Path) -> AppResult<FileStamp> {
    let meta = std::fs::metadata(path)?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64);
    Ok(FileStamp {
        modified_ms,
        len: meta.len(),
    })
}

/// Writes `bytes` to `path` through a temporary sibling file and a rename.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let dir = path.parent().ok_or("親フォルダーがありません")?;
    let name = path.file_name().ok_or("ファイル名がありません")?;
    let mut temp_name = std::ffi::OsString::from(".");
    temp_name.push(name);
    temp_name.push(format!(".epoch-{}-{}.tmp", std::process::id(), nonce()));
    let temp = dir.join(temp_name);
    let result = (|| -> AppResult<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = std::fs::metadata(path)
            && meta.permissions().readonly()
        {
            bail!("読み取り専用のファイルです: {}", display(path));
        }
        std::fs::rename(&temp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn nonce() -> u128 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let time = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    time ^ ((COUNTER.fetch_add(1, Ordering::Relaxed) as u128) << 64)
}

#[tauri::command]
pub fn list_dir(state: State<'_, AppState>, path: String) -> AppResult<Vec<DirEntry>> {
    let dir = state.workspace.resolve_in_root(&path)?;
    // Children are reported under the path the frontend asked for (not the canonical one), so
    // the tree keeps the names the user sees. Each child is re-resolved when it is used.
    let shown = PathBuf::from(&path);
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_symlink = file_type.is_symlink();
        let is_dir = if is_symlink {
            entry.path().is_dir()
        } else {
            file_type.is_dir()
        };
        entries.push(DirEntry {
            path: display(&shown.join(&name)),
            name,
            is_dir,
            is_symlink,
        });
        if entries.len() >= MAX_DIR_ENTRIES {
            break;
        }
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn read_text_file(state: State<'_, AppState>, path: String) -> AppResult<TextFile> {
    let resolved = state.workspace.resolve_existing(&path)?;
    let meta = std::fs::metadata(&resolved)?;
    if !meta.is_file() {
        bail!("ファイルではありません: {path}");
    }
    if meta.len() > MAX_TEXT_FILE {
        bail!(
            "ファイルが大きすぎます（{} MiB まで）: {path}",
            MAX_TEXT_FILE / 1024 / 1024
        );
    }
    let bytes = std::fs::read(&resolved)?;
    let (bom, body) = match bytes.strip_prefix(b"\xEF\xBB\xBF") {
        Some(rest) => (true, rest),
        None => (false, &bytes[..]),
    };
    if body.iter().take(8192).any(|b| *b == 0) {
        bail!("バイナリファイルは開けません: {path}");
    }
    let text = match std::str::from_utf8(body) {
        Ok(text) => text.to_owned(),
        Err(_) => bail!("UTF-8 ではないファイルは開けません: {path}"),
    };
    Ok(TextFile {
        path: display(&PathBuf::from(&path)),
        text,
        stamp: stamp_of(&resolved)?,
        bom,
        read_only: meta.permissions().readonly(),
    })
}

/// Saves a file. When `expected` is given and the file changed on disk since it was read, the
/// save is refused (unless `force`) so the editor can ask the user instead of overwriting.
#[tauri::command]
pub fn write_text_file(
    state: State<'_, AppState>,
    path: String,
    text: String,
    bom: bool,
    expected: Option<FileStamp>,
    force: bool,
) -> AppResult<FileStamp> {
    let resolved = state.workspace.resolve_for_write(&path)?;
    if resolved.is_dir() {
        bail!("フォルダーには書き込めません: {path}");
    }
    if !force
        && let Some(expected) = expected
        && let Ok(current) = stamp_of(&resolved)
        && current != expected
    {
        bail!("CONFLICT: ディスク上のファイルが別のプログラムで変更されています");
    }
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom {
        bytes.extend_from_slice(b"\xEF\xBB\xBF");
    }
    bytes.extend_from_slice(text.as_bytes());
    atomic_write(&resolved, &bytes)?;
    stamp_of(&resolved)
}

#[tauri::command]
pub fn file_stamp(state: State<'_, AppState>, path: String) -> AppResult<Option<FileStamp>> {
    match state.workspace.resolve_existing(&path) {
        Ok(resolved) => Ok(stamp_of(&resolved).ok()),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub fn create_file(state: State<'_, AppState>, dir: String, name: String) -> AppResult<String> {
    let target = state.workspace.resolve_new_child(&dir, &name)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map_err(|e| format!("{name}: {e}"))?;
    Ok(display(&PathBuf::from(&dir).join(&name)))
}

#[tauri::command]
pub fn create_dir(state: State<'_, AppState>, dir: String, name: String) -> AppResult<String> {
    let target = state.workspace.resolve_new_child(&dir, &name)?;
    std::fs::create_dir(&target).map_err(|e| format!("{name}: {e}"))?;
    Ok(display(&PathBuf::from(&dir).join(&name)))
}

#[tauri::command]
pub fn rename_path(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> AppResult<String> {
    validate_file_name(&new_name)?;
    let root = state.workspace.require_root()?;
    let shown = PathBuf::from(&path);
    // Resolve the parent, not the entry itself: renaming a symlink renames the link.
    let parent = shown.parent().ok_or("親フォルダーがありません")?;
    let parent_resolved = state.workspace.resolve_in_root(&display(parent))?;
    let name = shown.file_name().ok_or("名前がありません")?;
    let source = parent_resolved.join(name);
    if source == root {
        bail!("ワークスペースのフォルダー自体は変更できません");
    }
    let target = parent_resolved.join(&new_name);
    if target.exists() && !same_name_ignoring_case(&source, &target) {
        bail!("同じ名前がすでにあります: {new_name}");
    }
    std::fs::rename(&source, &target)?;
    Ok(display(&parent.join(&new_name)))
}

fn same_name_ignoring_case(a: &Path, b: &Path) -> bool {
    cfg!(windows) && a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}

/// Moves a file or folder to the system trash (never a permanent delete).
#[tauri::command]
pub fn delete_path(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let root = state.workspace.require_root()?;
    let shown = PathBuf::from(&path);
    let parent = shown.parent().ok_or("親フォルダーがありません")?;
    let parent_resolved = state.workspace.resolve_in_root(&display(parent))?;
    let target = parent_resolved.join(shown.file_name().ok_or("名前がありません")?);
    if target == root || !target.starts_with(&root) {
        bail!("このパスは削除できません: {path}");
    }
    trash::delete(&target).map_err(|e| format!("ごみ箱へ移せませんでした: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn reveal_path(state: State<'_, AppState>, path: String) -> AppResult<()> {
    let resolved = state.workspace.resolve_existing(&path)?;
    #[cfg(windows)]
    {
        let windows = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let explorer = PathBuf::from(windows).join("explorer.exe");
        let mut arg = std::ffi::OsString::from("/select,");
        arg.push(display(&resolved));
        crate::process::command(&explorer).arg(arg).spawn()?;
    }
    #[cfg(not(windows))]
    {
        let dir = if resolved.is_dir() {
            resolved
        } else {
            resolved.parent().map(Path::to_path_buf).unwrap_or(resolved)
        };
        let opener = which::which("xdg-open").map_err(|_| "xdg-open が見つかりません")?;
        crate::process::command(&opener).arg(dir).spawn()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_cleans_up() {
        let dir = std::env::temp_dir().join(format!("epoch-aw-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.rw");
        atomic_write(&file, b"one").unwrap();
        atomic_write(&file, b"two").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"two");
        let leftovers = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(leftovers, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
