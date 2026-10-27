//! Child processes. Every program is started directly with an argument vector, never through a
//! shell, so no file name or user input is ever parsed as a command line.

use crate::bail;
use crate::error::AppResult;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A `Command` with the platform flags every child of the editor gets.
pub fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: tools run without flashing a console window.
        command.creation_flags(0x0800_0000);
    }
    command
}

pub struct Captured {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a program to completion with a time limit and a cap on the captured output.
pub fn capture(
    program: &Path,
    args: &[&str],
    cwd: Option<&Path>,
    stdin: Option<&str>,
    timeout: Duration,
) -> AppResult<Captured> {
    const LIMIT: u64 = 16 * 1024 * 1024;
    let mut cmd = command(program);
    cmd.args(args)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("{} を起動できません: {e}", program.display()))?;
    if let Some(text) = stdin {
        let mut pipe = child.stdin.take().unwrap();
        let text = text.to_owned();
        std::thread::spawn(move || {
            use std::io::Write;
            let _ = pipe.write_all(text.as_bytes());
        });
    }
    let read = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(pipe) = pipe {
                let _ = pipe.take(LIMIT).read_to_end(&mut buffer);
            }
            String::from_utf8_lossy(&buffer).into_owned()
        })
    };
    let out = read(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let err = read(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!("{} が時間内に終わりませんでした", program.display());
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    Ok(Captured {
        status: status.code(),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
    })
}
