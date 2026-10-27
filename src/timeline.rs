//! The checkpoint timeline of a recorded run: every `commit`, `revert`, `publish` and the other
//! history operations, in order, with the checkpoint names read from the source. This is the
//! view that only a REWIND editor has.

use crate::bail;
use crate::error::AppResult;
use crate::state::AppState;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use tauri::State;

const MAX_TRACE: u64 = 128 * 1024 * 1024;
const MAX_ROWS: usize = 20_000;
const OPERATIONS: &[&str] = &[
    "ApplicationEntry",
    "Commit",
    "Revert",
    "Resume",
    "Drop",
    "Publish",
    "Branch",
    "Spawn",
    "Await",
    "Halt",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    event: usize,
    operation: String,
    task: u64,
    source: String,
    line: u64,
    column: u64,
    /// The checkpoint named by `commit NAME;` / `revert NAME;` at that position, when present.
    name: Option<String>,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    rows: Vec<Row>,
    total_events: usize,
    limited: bool,
    result: Value,
    record_mode: Value,
}

static CHECKPOINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:commit|revert|resume|drop|branch)\s+([\p{L}_][\p{L}\p{N}_]*)").unwrap()
});

fn checkpoint_name(line: &str, column: u64) -> Option<String> {
    let start = line
        .char_indices()
        .nth(column.saturating_sub(1) as usize)
        .map_or(0, |(i, _)| i);
    CHECKPOINT
        .captures(&line[start..])
        .or_else(|| CHECKPOINT.captures(line))
        .map(|c| c[1].to_string())
}

fn source_lines<'a>(
    cache: &'a mut HashMap<String, Option<Vec<String>>>,
    root: &Path,
    source: &str,
) -> Option<&'a Vec<String>> {
    cache
        .entry(source.to_string())
        .or_insert_with(|| {
            let path: PathBuf = root.join(source);
            let canonical = std::fs::canonicalize(path).ok()?;
            // Sources named by the trace must stay inside the workspace.
            if !canonical.starts_with(root) {
                return None;
            }
            let text = std::fs::read_to_string(canonical).ok()?;
            Some(text.lines().map(str::to_string).collect())
        })
        .as_ref()
}

pub fn build(trace: &Value, root: &Path) -> AppResult<Timeline> {
    let Some(events) = trace["events"].as_array() else {
        bail!("記録に events がありません（--record-mode debug で記録してください）");
    };
    let mut cache = HashMap::new();
    let mut rows = Vec::new();
    for (index, event) in events.iter().enumerate() {
        let Some(operation) = event["operation"].as_str() else {
            continue;
        };
        if !OPERATIONS.contains(&operation) {
            continue;
        }
        if rows.len() >= MAX_ROWS {
            break;
        }
        let source = event["source"].as_str().unwrap_or("").to_string();
        let line = event["line"].as_u64().unwrap_or(0);
        let column = event["column"].as_u64().unwrap_or(0);
        let text = source_lines(&mut cache, root, &source)
            .and_then(|lines| lines.get(line.saturating_sub(1) as usize))
            .cloned()
            .unwrap_or_default();
        let name = if matches!(
            operation,
            "Commit" | "Revert" | "Resume" | "Drop" | "Branch"
        ) {
            checkpoint_name(&text, column)
        } else {
            None
        };
        rows.push(Row {
            event: index,
            operation: operation.to_string(),
            task: event["task"].as_u64().unwrap_or(0),
            source,
            line,
            column,
            name,
            text: text.trim().chars().take(200).collect(),
        });
    }
    Ok(Timeline {
        limited: rows.len() >= MAX_ROWS,
        rows,
        total_events: events.len(),
        result: trace["result"].clone(),
        record_mode: trace["record_mode"].clone(),
    })
}

#[tauri::command]
pub async fn load_timeline(
    state: State<'_, AppState>,
    trace: String,
    source_root: Option<String>,
) -> AppResult<Timeline> {
    let root = match source_root {
        Some(dir) => state.workspace.resolve_in_root(&dir)?,
        None => state.workspace.require_root()?,
    };
    let path = state.workspace.resolve_existing(&trace)?;
    tauri::async_runtime::spawn_blocking(move || {
        if std::fs::metadata(&path)?.len() > MAX_TRACE {
            bail!("記録が大きすぎます（128 MiB まで）");
        }
        let trace: Value = serde_json::from_slice(&std::fs::read(&path)?)?;
        build(&trace, &root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_checkpoints_from_source() {
        assert_eq!(
            checkpoint_name("    commit base;", 5).as_deref(),
            Some("base")
        );
        assert_eq!(
            checkpoint_name("x = 1; revert 保存;", 8).as_deref(),
            Some("保存")
        );
        assert_eq!(checkpoint_name("publish;", 1), None);
    }

    #[test]
    fn keeps_only_history_operations() {
        let trace = json!({"events": [
            {"operation": "Push", "line": 1, "column": 1, "source": "m.rw", "task": 0},
            {"operation": "Commit", "line": 2, "column": 5, "source": "m.rw", "task": 0},
            {"operation": "Revert", "line": 3, "column": 5, "source": "m.rw", "task": 0},
        ], "result": {"ok": 0}});
        let timeline = build(&trace, Path::new("/nonexistent")).unwrap();
        assert_eq!(timeline.rows.len(), 2);
        assert_eq!(timeline.rows[0].event, 1);
        assert_eq!(timeline.total_events, 3);
    }
}
