//! A child process that speaks `Content-Length` framed JSON on stdio — the transport shared by
//! the Language Server Protocol and the Debug Adapter Protocol. Incoming frames are bounded in
//! size and header length, so a misbehaving server cannot make the editor allocate without limit.

use crate::error::AppResult;
use crate::process;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

const MAX_FRAME: usize = 64 * 1024 * 1024;
const MAX_HEADER_LINE: usize = 4096;

pub struct FramedChild {
    child: Mutex<Child>,
    stdin: Mutex<Option<ChildStdin>>,
    alive: AtomicBool,
}

impl FramedChild {
    /// Starts `program args...` in `cwd`. `on_message` runs on a reader thread for every frame;
    /// `on_stderr` gets each stderr line; `on_exit` runs once when stdout closes.
    pub fn spawn(
        program: &Path,
        args: &[&str],
        cwd: &Path,
        on_message: impl Fn(Value) + Send + 'static,
        on_stderr: impl Fn(String) + Send + 'static,
        on_exit: impl FnOnce() + Send + 'static,
    ) -> AppResult<std::sync::Arc<FramedChild>> {
        let mut child = process::command(program)
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{} を起動できません: {e}", program.display()))?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdin = child.stdin.take();
        let this = std::sync::Arc::new(FramedChild {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            alive: AtomicBool::new(true),
        });
        let reader_handle = this.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Some(message) = read_frame(&mut reader) {
                on_message(message);
            }
            reader_handle.alive.store(false, Ordering::SeqCst);
            on_exit();
        });
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok).take(10_000) {
                on_stderr(line);
            }
        });
        Ok(this)
    }

    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn send(&self, message: &Value) -> AppResult<()> {
        let body = serde_json::to_vec(message)?;
        let mut guard = self.stdin.lock().unwrap();
        let Some(stdin) = guard.as_mut() else {
            return Err("サーバーは終了しています".into());
        };
        let header = format!("Content-Length: {}\r\n\r\n", body.len());
        stdin
            .write_all(header.as_bytes())
            .and_then(|_| stdin.write_all(&body))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("サーバーへ送れません: {e}").into())
    }

    /// Closes stdin (a polite end for servers that exit on EOF), then kills the process.
    pub fn kill(&self) {
        self.stdin.lock().unwrap().take();
        let mut child = self.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
        self.alive.store(false, Ordering::SeqCst);
    }
}

impl Drop for FramedChild {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Reads one frame; `None` on end of stream or on a malformed or oversized frame.
pub fn read_frame(reader: &mut impl BufRead) -> Option<Value> {
    let mut length: Option<usize> = None;
    let mut lines = 0;
    loop {
        let mut line = Vec::new();
        let read = reader
            .by_ref()
            .take(MAX_HEADER_LINE as u64)
            .read_until(b'\n', &mut line)
            .ok()?;
        if read == 0 || !line.ends_with(b"\n") {
            return None;
        }
        lines += 1;
        if lines > 32 {
            return None;
        }
        let line = std::str::from_utf8(&line).ok()?.trim();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().ok();
        }
    }
    let length = length.filter(|n| *n <= MAX_FRAME)?;
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    serde_json::from_slice(&body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_frames_and_rejects_garbage() {
        let input =
            b"Content-Length: 7\r\n\r\n{\"a\":1}Content-Length: 2\r\nContent-Type: x\r\n\r\n[]";
        let mut reader = &input[..];
        assert_eq!(read_frame(&mut reader).unwrap()["a"], 1);
        assert!(read_frame(&mut reader).unwrap().is_array());
        assert!(read_frame(&mut reader).is_none());
        let huge = format!("Content-Length: {}\r\n\r\n", MAX_FRAME + 1);
        assert!(read_frame(&mut huge.as_bytes()).is_none());
        let long_header = vec![b'x'; MAX_HEADER_LINE + 10];
        assert!(read_frame(&mut &long_header[..]).is_none());
    }
}
