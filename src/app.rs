//! Application-level commands: start-up, workspaces, native dialogs, settings, the project
//! manifest and quitting.

use crate::bail;
use crate::error::AppResult;
use crate::settings::{self, Session, Settings};
use crate::state::AppState;
use crate::workspace::display;
use serde::Serialize;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    path: String,
    name: String,
    project: Value,
}

fn workspace_info(root: &Path) -> Workspace {
    Workspace {
        path: display(root),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| display(root)),
        project: read_manifest(root),
    }
}

/// The top-level `key = "value"` entries of `rewind.toml` the editor shows (language version,
/// entry file, effects). Tables and other syntax are left to the compiler.
fn read_manifest(root: &Path) -> Value {
    let path = root.join("rewind.toml");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Value::Null;
    };
    let mut manifest = serde_json::Map::new();
    for line in text.lines().take(10_000) {
        let line = line.trim();
        if line.starts_with('[') {
            break;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if matches!(
            key,
            "language" | "entry" | "effects" | "source_root" | "name" | "version"
        ) {
            let value = value.trim().trim_matches('"');
            manifest.insert(
                key.to_string(),
                Value::String(value.chars().take(500).collect()),
            );
        }
    }
    Value::Object(manifest)
}

fn remember_workspace(state: &AppState, root: &Path) {
    let mut settings = state.settings.lock().unwrap();
    let text = display(root);
    settings.recent_workspaces.retain(|p| p != &text);
    settings.recent_workspaces.insert(0, text);
    settings.recent_workspaces.truncate(12);
    let _ = settings::save_settings(&settings);
}

fn open_root(state: &AppState, path: &Path) -> AppResult<Workspace> {
    state.lsp.stop();
    state.dap.stop();
    let root = state.workspace.set_root(path)?;
    // The location check of `rewind` depends on the open folder.
    state.forget_toolchain();
    remember_workspace(state, &root);
    Ok(workspace_info(&root))
}

#[tauri::command]
pub fn app_init(state: State<'_, AppState>) -> Value {
    let settings = state.settings.lock().unwrap().clone();
    let toolchain = state.toolchain();
    json!({
        "settings": settings,
        "session": settings::load_session(),
        "toolchain": toolchain.as_ref().ok(),
        "toolchainError": toolchain.err().map(|e| e.0),
        "platform": std::env::consts::OS,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

#[tauri::command]
pub async fn open_workspace_dialog(state: State<'_, AppState>) -> AppResult<Option<Workspace>> {
    let picked = rfd::AsyncFileDialog::new()
        .set_title("フォルダーを開く")
        .pick_folder()
        .await;
    match picked {
        Some(folder) => open_root(&state, folder.path()).map(Some),
        None => Ok(None),
    }
}

/// Reopens a folder from the recent list or the last session. Other paths need the dialog, so a
/// compromised page cannot point the editor at an arbitrary folder.
#[tauri::command]
pub fn open_recent_workspace(state: State<'_, AppState>, path: String) -> AppResult<Workspace> {
    let known = state
        .settings
        .lock()
        .unwrap()
        .recent_workspaces
        .contains(&path)
        || settings::load_session().workspace.as_deref() == Some(path.as_str());
    if !known {
        bail!("最近使ったフォルダーではありません: {path}");
    }
    open_root(&state, &PathBuf::from(path))
}

#[tauri::command]
pub fn close_workspace(state: State<'_, AppState>) {
    state.lsp.stop();
    state.dap.stop();
    state.workspace.close();
    state.forget_toolchain();
}

#[tauri::command]
pub fn workspace_project(state: State<'_, AppState>) -> AppResult<Value> {
    Ok(read_manifest(&state.workspace.require_root()?))
}

#[tauri::command]
pub async fn open_file_dialog(state: State<'_, AppState>) -> AppResult<Vec<String>> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("ファイルを開く")
        .add_filter("REWIND", &["rw"])
        .add_filter("すべてのファイル", &["*"]);
    if let Some(root) = state.workspace.root() {
        dialog = dialog.set_directory(root);
    }
    let Some(files) = dialog.pick_files().await else {
        return Ok(Vec::new());
    };
    files
        .iter()
        .map(|f| state.workspace.grant(f.path()).map(|p| display(&p)))
        .collect()
}

#[tauri::command]
pub async fn save_file_dialog(
    state: State<'_, AppState>,
    suggested: String,
) -> AppResult<Option<String>> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("名前を付けて保存")
        .add_filter("REWIND", &["rw"])
        .add_filter("すべてのファイル", &["*"])
        .set_file_name(suggested.chars().take(255).collect::<String>());
    if let Some(root) = state.workspace.root() {
        dialog = dialog.set_directory(root);
    }
    let Some(file) = dialog.save_file().await else {
        return Ok(None);
    };
    // The dialog has already asked about overwriting; the grant makes the path writable.
    state
        .workspace
        .grant(file.path())
        .map(|p| Some(display(&p)))
}

#[tauri::command]
pub async fn open_trace_dialog(state: State<'_, AppState>) -> AppResult<Option<String>> {
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("記録（trace）を開く")
        .add_filter("REWIND trace", &["json"]);
    if let Some(root) = state.workspace.root() {
        dialog = dialog.set_directory(root);
    }
    let Some(file) = dialog.pick_file().await else {
        return Ok(None);
    };
    state
        .workspace
        .grant(file.path())
        .map(|p| Some(display(&p)))
}

#[tauri::command]
pub async fn pick_rewind_dialog() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("rewind の場所")
        .pick_file()
        .await
        .map(|f| display(f.path()))
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> AppResult<Value> {
    let mut settings = settings.sanitized();
    let changed_tool = {
        let mut current = state.settings.lock().unwrap();
        // The recent list is owned by the backend.
        settings.recent_workspaces = current.recent_workspaces.clone();
        let changed = current.rewind_path != settings.rewind_path;
        *current = settings.clone();
        changed
    };
    settings::save_settings(&settings)?;
    if changed_tool {
        state.forget_toolchain();
    }
    let toolchain = state.toolchain();
    Ok(json!({
        "settings": settings,
        "toolchain": toolchain.as_ref().ok(),
        "toolchainError": toolchain.err().map(|e| e.0),
    }))
}

#[tauri::command]
pub fn save_session(session: Session) -> AppResult<()> {
    settings::save_session(&session)
}

#[tauri::command]
pub fn toolchain_info(state: State<'_, AppState>) -> Value {
    state.forget_toolchain();
    let toolchain = state.toolchain();
    json!({"toolchain": toolchain.as_ref().ok(), "toolchainError": toolchain.err().map(|e| e.0)})
}

/// Quits after the frontend has dealt with unsaved files.
#[tauri::command]
pub fn app_exit(app: AppHandle, state: State<'_, AppState>) {
    state.shutdown();
    app.exit(0);
}
