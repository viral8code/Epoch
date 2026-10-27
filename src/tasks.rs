//! Running `rewind` on the user's code: run, record for the debugger, check, test, build,
//! compile, profile. The frontend chooses a kind and a few validated options; the argument
//! vector is built here, so the frontend can never run an arbitrary program or option.

use crate::bail;
use crate::error::AppResult;
use crate::state::AppState;
use crate::workspace::display;
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;

struct Running {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
}

#[derive(Default)]
pub struct TaskManager {
    next: AtomicU64,
    running: Mutex<HashMap<u64, Running>>,
}

impl TaskManager {
    pub fn kill_all(&self) {
        for (_, task) in self.running.lock().unwrap().drain() {
            let _ = task.child.lock().unwrap().kill();
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRequest {
    kind: String,
    file: Option<String>,
    #[serde(default)]
    effects: String,
    #[serde(default)]
    args: Vec<String>,
    steps: Option<u64>,
    filter: Option<String>,
}

/// Effects are a comma-separated list of names such as `fileRead,fileWrite`.
pub fn valid_effects(effects: &str) -> bool {
    effects.is_empty()
        || (effects.len() <= 512
            && effects
                .split(',')
                .all(|e| !e.is_empty() && e.chars().all(|c| c.is_ascii_alphanumeric())))
}

fn trace_path(root: &Path, file: &Path) -> AppResult<PathBuf> {
    let dir = root.join(".rewind").join("epoch").join("traces");
    std::fs::create_dir_all(&dir)?;
    let stem = file
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "trace".into());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    // Keep the newest few traces; debug traces can be large.
    let mut old: Vec<_> = std::fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .collect();
    if old.len() >= 10 {
        old.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
        for entry in &old[..old.len() - 9] {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(dir.join(format!("{stem}-{stamp}.json")))
}

fn build_args(
    request: &TaskRequest,
    root: &Path,
    file: Option<&Path>,
    trace: Option<&Path>,
) -> AppResult<Vec<String>> {
    if !valid_effects(&request.effects) {
        bail!("効果の指定が正しくありません: {}", request.effects);
    }
    if request.args.len() > 64
        || request
            .args
            .iter()
            .any(|a| a.len() > 4096 || a.contains('\0'))
    {
        bail!("プログラムの引数が多すぎるか、長すぎます");
    }
    let project = root.join("rewind.toml").is_file();
    let root_text = display(root);
    let mut args: Vec<String> = vec!["--diagnostic-format".into(), "json".into()];
    let need_file = || -> AppResult<String> {
        file.map(display)
            .ok_or_else(|| "対象のファイルがありません".into())
    };
    let push_common = |args: &mut Vec<String>| {
        if project {
            args.extend(["--root".into(), root_text.clone()]);
        }
        if !request.effects.is_empty() {
            args.extend(["--allow-effects".into(), request.effects.clone()]);
        }
        if let Some(steps) = request.steps {
            args.extend(["--steps".into(), steps.to_string()]);
        }
    };
    match request.kind.as_str() {
        "run" | "record" => {
            args.extend(["run".into(), need_file()?]);
            push_common(&mut args);
            if let Some(trace) = trace {
                args.extend([
                    "--record".into(),
                    display(trace),
                    "--record-mode".into(),
                    "debug".into(),
                ]);
            }
            if !request.args.is_empty() {
                args.push("--".into());
                args.extend(request.args.iter().cloned());
            }
        }
        "profile" => {
            args.extend(["profile".into(), need_file()?]);
            push_common(&mut args);
            args.extend(["--profile-format".into(), "text".into()]);
        }
        "check" => {
            args.push("check".into());
            match file {
                Some(file) if !project => args.push(display(file)),
                _ => args.extend(["--root".into(), root_text]),
            }
        }
        "compile" => {
            args.extend(["compile".into(), need_file()?]);
            if !request.effects.is_empty() {
                args.extend(["--allow-effects".into(), request.effects.clone()]);
            }
        }
        "test" | "build" => {
            if !project {
                bail!("rewind.toml のあるフォルダーで使えます");
            }
            args.extend([request.kind.clone(), "--root".into(), root_text]);
            if request.kind == "test"
                && let Some(filter) = request.filter.as_deref().filter(|f| !f.is_empty())
            {
                if filter.len() > 256 || filter.chars().any(char::is_control) {
                    bail!("テストの絞り込みが正しくありません");
                }
                args.extend(["--filter".into(), filter.into()]);
            }
        }
        "doc" => {
            args.extend(["doc".into(), need_file()?]);
        }
        other => bail!("知らない操作です: {other}"),
    }
    Ok(args)
}

/// Forwards a pipe to the frontend in chunks, keeping UTF-8 sequences whole across reads.
fn pump(
    app: AppHandle,
    id: u64,
    stream: &'static str,
    mut pipe: impl Read + Send + 'static,
    budget: Arc<AtomicUsize>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 16 * 1024];
        let mut carry: Vec<u8> = Vec::new();
        let mut truncated = false;
        loop {
            let n = match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            if truncated {
                continue;
            }
            if budget.fetch_add(n, Ordering::Relaxed) + n > OUTPUT_LIMIT {
                truncated = true;
                let _ = app.emit(
                    "task-output",
                    json!({"id": id, "stream": "system", "text": "\n[出力が上限を超えたため、以降は表示しません]\n"}),
                );
                continue;
            }
            carry.extend_from_slice(&buffer[..n]);
            let valid = match std::str::from_utf8(&carry) {
                Ok(_) => carry.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => carry.len(),
            };
            let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
            carry.drain(..valid);
            if !text.is_empty() {
                let _ = app.emit(
                    "task-output",
                    json!({"id": id, "stream": stream, "text": text}),
                );
            }
        }
        if !carry.is_empty() {
            let text = String::from_utf8_lossy(&carry).into_owned();
            let _ = app.emit(
                "task-output",
                json!({"id": id, "stream": stream, "text": text}),
            );
        }
    })
}

#[tauri::command]
pub fn task_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: TaskRequest,
) -> AppResult<serde_json::Value> {
    let root = state.workspace.require_root()?;
    let toolchain = state.toolchain()?;
    let file = match &request.file {
        Some(file) => {
            let resolved = state.workspace.resolve_in_root(file)?;
            if !resolved.is_file() {
                bail!("ファイルではありません: {file}");
            }
            Some(resolved)
        }
        None => None,
    };
    let trace = if request.kind == "record" {
        Some(trace_path(
            &root,
            file.as_deref().ok_or("対象のファイルがありません")?,
        )?)
    } else {
        None
    };
    let args = build_args(&request, &root, file.as_deref(), trace.as_deref())?;
    let cwd = file
        .as_deref()
        .and_then(Path::parent)
        .filter(|_| !root.join("rewind.toml").is_file())
        .unwrap_or(&root)
        .to_path_buf();
    let mut child = crate::process::command(&toolchain.executable)
        .args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("rewind を起動できません: {e}"))?;
    let id = state.tasks.next.fetch_add(1, Ordering::SeqCst) + 1;
    let budget = Arc::new(AtomicUsize::new(0));
    let out = pump(
        app.clone(),
        id,
        "stdout",
        child.stdout.take().unwrap(),
        budget.clone(),
    );
    let err = pump(
        app.clone(),
        id,
        "stderr",
        child.stderr.take().unwrap(),
        budget,
    );
    let stdin = Arc::new(Mutex::new(child.stdin.take()));
    let child = Arc::new(Mutex::new(child));
    state.tasks.running.lock().unwrap().insert(
        id,
        Running {
            child: child.clone(),
            stdin,
        },
    );
    let started = Instant::now();
    let trace_text = trace.as_deref().map(display);
    let command_line = std::iter::once("rewind".to_string())
        .chain(args.iter().map(|a| {
            if a.contains(' ') {
                format!("\"{a}\"")
            } else {
                a.clone()
            }
        }))
        .collect::<Vec<_>>()
        .join(" ");
    {
        let app = app.clone();
        let trace_text = trace_text.clone();
        std::thread::spawn(move || {
            let status = loop {
                match child.lock().unwrap().try_wait() {
                    Ok(Some(status)) => break status.code(),
                    Ok(None) => {}
                    Err(_) => break None,
                }
                std::thread::sleep(Duration::from_millis(15));
            };
            let _ = out.join();
            let _ = err.join();
            use tauri::Manager;
            if let Some(state) = app.try_state::<AppState>() {
                state.tasks.running.lock().unwrap().remove(&id);
            }
            let _ = app.emit(
                "task-exit",
                json!({"id": id, "code": status, "elapsedMs": started.elapsed().as_millis() as u64, "trace": trace_text}),
            );
        });
    }
    Ok(json!({"id": id, "commandLine": command_line, "cwd": display(&cwd), "trace": trace_text}))
}

#[tauri::command]
pub fn task_input(state: State<'_, AppState>, id: u64, text: String) -> AppResult<()> {
    let stdin = match state.tasks.running.lock().unwrap().get(&id) {
        Some(task) => task.stdin.clone(),
        None => bail!("実行中ではありません"),
    };
    let mut guard = stdin.lock().unwrap();
    let Some(pipe) = guard.as_mut() else {
        bail!("入力は閉じられています");
    };
    pipe.write_all(text.as_bytes())
        .and_then(|_| pipe.flush())
        .map_err(|e| format!("入力を送れません: {e}").into())
}

#[tauri::command]
pub fn task_close_input(state: State<'_, AppState>, id: u64) -> AppResult<()> {
    if let Some(task) = state.tasks.running.lock().unwrap().get(&id) {
        task.stdin.lock().unwrap().take();
    }
    Ok(())
}

#[tauri::command]
pub fn task_kill(state: State<'_, AppState>, id: u64) -> AppResult<()> {
    if let Some(task) = state.tasks.running.lock().unwrap().get(&id) {
        let _ = task.child.lock().unwrap().kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: &str) -> TaskRequest {
        TaskRequest {
            kind: kind.into(),
            file: None,
            effects: String::new(),
            args: Vec::new(),
            steps: None,
            filter: None,
        }
    }

    #[test]
    fn effects_are_plain_names() {
        assert!(valid_effects(""));
        assert!(valid_effects("fileRead,fileWrite"));
        assert!(!valid_effects("fileRead,"));
        assert!(!valid_effects("a b"));
        assert!(!valid_effects("x;rm"));
    }

    #[test]
    fn program_arguments_follow_the_separator() {
        let root = std::env::temp_dir();
        let file = root.join("main.rw");
        let mut run = request("run");
        run.args = vec!["--allow-effects".into(), "env".into()];
        let args = build_args(&run, &root, Some(&file), None).unwrap();
        let separator = args.iter().position(|a| a == "--").unwrap();
        assert_eq!(&args[separator + 1..], &["--allow-effects", "env"]);
        assert!(!args[..separator].iter().any(|a| a == "env"));
        assert!(build_args(&request("rm"), &root, Some(&file), None).is_err());
    }
}
