//! The bridge to `rewind dap`, REWIND's replay debugger. It steps through a recorded trace
//! forwards and backwards; nothing runs again and no external operation happens. Events go to
//! the frontend as `dap-event`.

use crate::bail;
use crate::error::AppResult;
use crate::rpc::FramedChild;
use crate::state::AppState;
use crate::workspace::display;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>;

struct DapSession {
    io: Arc<FramedChild>,
    seq: AtomicI64,
    pending: Pending,
}

#[derive(Default)]
pub struct DapManager {
    session: Mutex<Option<Arc<DapSession>>>,
    generation: AtomicU64,
}

const COMMANDS: &[&str] = &[
    "setBreakpoints",
    "configurationDone",
    "threads",
    "stackTrace",
    "scopes",
    "variables",
    "evaluate",
    "next",
    "stepIn",
    "continue",
    "stepBack",
    "reverseContinue",
    "source",
];

impl DapSession {
    async fn request(&self, command: &str, arguments: Value) -> AppResult<Value> {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(seq, sender);
        if let Err(error) = self.io.send(
            &json!({"seq": seq, "type": "request", "command": command, "arguments": arguments}),
        ) {
            self.pending.lock().unwrap().remove(&seq);
            return Err(error);
        }
        let response = match tokio::time::timeout(Duration::from_secs(60), receiver).await {
            Ok(Ok(response)) => response,
            Ok(Err(_)) => bail!("デバッガーが終了しました"),
            Err(_) => {
                self.pending.lock().unwrap().remove(&seq);
                bail!("デバッガーが応答しません（{command}）")
            }
        };
        if response["success"] == true {
            Ok(response.get("body").cloned().unwrap_or(Value::Null))
        } else {
            let message = response["body"]["error"]["format"]
                .as_str()
                .or_else(|| response["message"].as_str())
                .unwrap_or("デバッガーのエラー");
            bail!("{message}")
        }
    }
}

impl DapManager {
    fn current(&self) -> AppResult<Arc<DapSession>> {
        match self.session.lock().unwrap().clone() {
            Some(session) if session.io.is_alive() => Ok(session),
            _ => bail!("デバッグセッションがありません"),
        }
    }

    pub fn stop(&self) {
        if let Some(session) = self.session.lock().unwrap().take() {
            session.io.kill();
        }
    }
}

/// Opens a recorded trace (`rewind run --record FILE --record-mode debug`) in the debugger.
#[tauri::command]
pub async fn dap_start(
    app: AppHandle,
    state: State<'_, AppState>,
    trace: String,
    source_root: Option<String>,
) -> AppResult<Value> {
    state.dap.stop();
    // Sources in a trace are relative to the program's root: the project folder, or the folder
    // of a standalone file. Either way it must be inside the workspace.
    let root = match source_root {
        Some(dir) => state.workspace.resolve_in_root(&dir)?,
        None => state.workspace.require_root()?,
    };
    if !root.is_dir() {
        bail!("フォルダーではありません: {}", display(&root));
    }
    let trace = state.workspace.resolve_existing(&trace)?;
    let toolchain = state.toolchain()?;
    let generation = state.dap.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let pending: Pending = Arc::default();
    let io = {
        let pending = pending.clone();
        let event_app = app.clone();
        let log_app = app.clone();
        let exit_app = app.clone();
        FramedChild::spawn(
            &toolchain.executable,
            &["dap"],
            &root,
            move |message| {
                if message["type"] == "response" {
                    if let Some(seq) = message["request_seq"].as_i64()
                        && let Some(sender) = pending.lock().unwrap().remove(&seq)
                    {
                        let _ = sender.send(message);
                    }
                } else if message["type"] == "event" {
                    let _ = event_app.emit(
                        "dap-event",
                        json!({"generation": generation, "event": message["event"], "body": message["body"]}),
                    );
                }
            },
            move |line| {
                let _ = log_app.emit("dap-log", json!({"generation": generation, "line": line}));
            },
            move || {
                let _ = exit_app.emit("dap-exit", json!({"generation": generation}));
            },
        )?
    };
    let session = Arc::new(DapSession {
        io,
        seq: AtomicI64::new(1),
        pending,
    });
    let result = async {
        let capabilities = session
            .request(
                "initialize",
                json!({"clientID": "epoch", "clientName": "Epoch", "adapterID": "rewind",
                       "linesStartAt1": true, "columnsStartAt1": true, "pathFormat": "path"}),
            )
            .await?;
        session
            .request(
                "launch",
                json!({"trace": display(&trace), "root": display(&root)}),
            )
            .await?;
        AppResult::Ok(capabilities)
    }
    .await;
    match result {
        Ok(capabilities) => {
            *state.dap.session.lock().unwrap() = Some(session);
            Ok(json!({"generation": generation, "capabilities": capabilities}))
        }
        Err(error) => {
            session.io.kill();
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn dap_request(
    state: State<'_, AppState>,
    command: String,
    arguments: Value,
) -> AppResult<Value> {
    if !COMMANDS.contains(&command.as_str()) {
        bail!("許可されていない操作です: {command}");
    }
    let session = state.dap.current()?;
    session.request(&command, arguments).await
}

#[tauri::command]
pub async fn dap_stop(state: State<'_, AppState>) -> AppResult<()> {
    let session = state.dap.session.lock().unwrap().clone();
    if let Some(session) = session {
        let _ = tokio::time::timeout(
            Duration::from_secs(2),
            session.request("disconnect", json!({})),
        )
        .await;
    }
    state.dap.stop();
    Ok(())
}
