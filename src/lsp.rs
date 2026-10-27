//! The bridge to `rewind lsp`. The frontend asks for language features through `lsp_request`;
//! this module owns the JSON-RPC ids and forwards server notifications as `lsp-notification`
//! events. Only the methods the editor uses are let through.

use crate::bail;
use crate::error::AppResult;
use crate::rpc::FramedChild;
use crate::state::AppState;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

pub struct LspSession {
    io: Arc<FramedChild>,
    next_id: AtomicI64,
    pending: Pending,
    pub generation: u64,
}

#[derive(Default)]
pub struct LspManager {
    session: Mutex<Option<Arc<LspSession>>>,
    generation: AtomicU64,
}

const REQUESTS: &[&str] = &[
    "textDocument/hover",
    "textDocument/completion",
    "textDocument/definition",
    "textDocument/references",
    "textDocument/rename",
    "textDocument/prepareRename",
    "textDocument/signatureHelp",
    "textDocument/formatting",
    "textDocument/codeAction",
    "textDocument/documentSymbol",
    "textDocument/semanticTokens/full",
];
const NOTIFICATIONS: &[&str] = &[
    "textDocument/didOpen",
    "textDocument/didChange",
    "textDocument/didClose",
    "textDocument/didSave",
];

impl LspSession {
    async fn request(&self, method: &str, params: Value, timeout: Duration) -> AppResult<Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, sender);
        let sent = self
            .io
            .send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        if let Err(error) = sent {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(message.into()),
            Ok(Err(_)) => bail!("言語サーバーが終了しました"),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                bail!("言語サーバーが応答しません（{method}）")
            }
        }
    }

    fn notify(&self, method: &str, params: Value) -> AppResult<()> {
        self.io
            .send(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }
}

impl LspManager {
    fn current(&self) -> AppResult<Arc<LspSession>> {
        match self.session.lock().unwrap().clone() {
            Some(session) if session.io.is_alive() => Ok(session),
            _ => bail!("言語サーバーが動いていません"),
        }
    }

    pub fn stop(&self) {
        if let Some(session) = self.session.lock().unwrap().take() {
            let _ = session.notify("exit", Value::Null);
            session.io.kill();
        }
    }
}

fn handle_message(
    app: &AppHandle,
    pending: &Pending,
    io: &Mutex<Option<Arc<FramedChild>>>,
    generation: u64,
    message: Value,
) {
    let method = message.get("method").and_then(Value::as_str);
    match (method, message.get("id")) {
        (None, Some(id)) => {
            let Some(id) = id.as_i64() else { return };
            if let Some(sender) = pending.lock().unwrap().remove(&id) {
                let result = match message.get("error") {
                    Some(error) => Err(error["message"]
                        .as_str()
                        .unwrap_or("言語サーバーのエラー")
                        .to_string()),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = sender.send(result);
            }
        }
        (Some(method), None) => {
            let _ = app.emit(
                "lsp-notification",
                json!({"generation": generation, "method": method, "params": message["params"]}),
            );
        }
        (Some(_), Some(id)) => {
            // Requests from the server (configuration, capability registration): the editor
            // has nothing to offer, so it answers each with an empty result.
            if let Some(io) = io.lock().unwrap().as_ref() {
                let _ = io.send(&json!({"jsonrpc": "2.0", "id": id, "result": Value::Null}));
            }
        }
        (None, None) => {}
    }
}

/// Starts (or restarts) the language server for the open workspace and returns its capabilities.
#[tauri::command]
pub async fn lsp_start(app: AppHandle, state: State<'_, AppState>) -> AppResult<Value> {
    state.lsp.stop();
    let root = state.workspace.require_root()?;
    let toolchain = state.toolchain()?;
    let generation = state.lsp.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let pending: Pending = Arc::default();
    let io_slot: Arc<Mutex<Option<Arc<FramedChild>>>> = Arc::default();
    let root_text = crate::workspace::display(&root);
    let io = {
        let app = app.clone();
        let pending = pending.clone();
        let io_slot = io_slot.clone();
        let exit_app = app.clone();
        let exit_pending = pending.clone();
        let log_app = app.clone();
        FramedChild::spawn(
            &toolchain.executable,
            &["lsp", "--root", &root_text],
            &root,
            move |message| handle_message(&app, &pending, &io_slot, generation, message),
            move |line| {
                let _ = log_app.emit("lsp-log", json!({"generation": generation, "line": line}));
            },
            move || {
                for (_, sender) in exit_pending.lock().unwrap().drain() {
                    let _ = sender.send(Err("言語サーバーが終了しました".into()));
                }
                let _ = exit_app.emit("lsp-exit", json!({"generation": generation}));
            },
        )?
    };
    *io_slot.lock().unwrap() = Some(io.clone());
    let session = Arc::new(LspSession {
        io,
        next_id: AtomicI64::new(1),
        pending,
        generation,
    });
    let root_uri = url::Url::from_directory_path(&root_text)
        .map(|u| u.to_string())
        .unwrap_or_default();
    let init = session
        .request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "clientInfo": {"name": "Epoch", "version": env!("CARGO_PKG_VERSION")},
                "rootUri": root_uri,
                "capabilities": {
                    "textDocument": {
                        "synchronization": {"didSave": true},
                        "publishDiagnostics": {"relatedInformation": true},
                        "hover": {"contentFormat": ["markdown", "plaintext"]},
                        "completion": {"completionItem": {"snippetSupport": false}}
                    }
                },
                "workspaceFolders": [{"uri": root_uri, "name": root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()}]
            }),
            Duration::from_secs(30),
        )
        .await;
    let init = match init {
        Ok(init) => init,
        Err(error) => {
            session.io.kill();
            return Err(error);
        }
    };
    session.notify("initialized", json!({}))?;
    *state.lsp.session.lock().unwrap() = Some(session);
    Ok(
        json!({"generation": generation, "capabilities": init["capabilities"], "serverInfo": init["serverInfo"]}),
    )
}

#[tauri::command]
pub async fn lsp_request(
    state: State<'_, AppState>,
    method: String,
    params: Value,
) -> AppResult<Value> {
    if !REQUESTS.contains(&method.as_str()) {
        bail!("許可されていない要求です: {method}");
    }
    let session = state.lsp.current()?;
    session
        .request(&method, params, Duration::from_secs(20))
        .await
}

#[tauri::command]
pub fn lsp_notify(state: State<'_, AppState>, method: String, params: Value) -> AppResult<()> {
    if !NOTIFICATIONS.contains(&method.as_str()) {
        bail!("許可されていない通知です: {method}");
    }
    state.lsp.current()?.notify(&method, params)
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, AppState>) -> AppResult<()> {
    let session = state.lsp.session.lock().unwrap().clone();
    if let Some(session) = session {
        let _ = session
            .request("shutdown", Value::Null, Duration::from_secs(2))
            .await;
    }
    state.lsp.stop();
    Ok(())
}
