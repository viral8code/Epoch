//! Locating the `rewind` command and asking it for the facts of the language.
//!
//! The editor never runs a `rewind` it finds inside the open project: a cloned repository could
//! otherwise plant its own executable and have it run just by being opened.

use crate::bail;
use crate::error::AppResult;
use crate::process;
use crate::workspace::display;
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Toolchain {
    pub path: String,
    pub version: String,
    /// The JSON of `rewind editor-info`.
    pub editor_info: Value,
    #[serde(skip)]
    pub executable: PathBuf,
}

pub fn locate(configured: &str, workspace: Option<&Path>) -> AppResult<PathBuf> {
    let path = if configured.trim().is_empty() {
        which::which(if cfg!(windows) {
            "rewind.exe"
        } else {
            "rewind"
        })
        .map_err(|_| "rewind コマンドが PATH に見つかりません。設定で場所を指定してください")?
    } else {
        let path = PathBuf::from(configured.trim());
        if !path.is_absolute() {
            bail!("rewind の場所は絶対パスで指定してください");
        }
        path
    };
    let path = std::fs::canonicalize(&path)
        .map_err(|e| format!("rewind の場所 {}: {e}", path.display()))?;
    if !path.is_file() {
        bail!("rewind の場所がファイルではありません: {}", display(&path));
    }
    if let Some(root) = workspace
        && path.starts_with(root)
    {
        bail!(
            "開いているフォルダーの中の rewind は実行しません: {}",
            display(&path)
        );
    }
    Ok(path)
}

pub fn probe(executable: &Path) -> AppResult<Toolchain> {
    let version = process::capture(
        executable,
        &["--version"],
        None,
        None,
        Duration::from_secs(10),
    )?;
    if version.status != Some(0) {
        bail!("rewind --version が失敗しました: {}", version.stderr.trim());
    }
    let info = process::capture(
        executable,
        &["editor-info"],
        None,
        None,
        Duration::from_secs(10),
    )?;
    let editor_info = if info.status == Some(0) {
        serde_json::from_str(&info.stdout).unwrap_or(Value::Null)
    } else {
        // Older compilers have no editor-info; the frontend falls back to its built-in word list.
        Value::Null
    };
    Ok(Toolchain {
        path: display(executable),
        version: version.stdout.trim().to_string(),
        editor_info,
        executable: executable.to_path_buf(),
    })
}
