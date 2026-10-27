//! The workspace is the only part of the disk the editor touches without asking. Every path that
//! comes from the frontend is resolved here: it must be absolute, and after resolving symbolic
//! links it must lie inside the workspace root or be a file the user picked in a native dialog.
//! A crafted file name or a symlink inside the project therefore cannot make the editor read or
//! write outside of it.

use crate::bail;
use crate::error::AppResult;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::RwLock;

#[derive(Default)]
pub struct Workspace {
    root: RwLock<Option<PathBuf>>,
    /// Canonical paths of files outside the root that the user chose in an open/save dialog.
    granted: RwLock<HashSet<PathBuf>>,
}

impl Workspace {
    pub fn root(&self) -> Option<PathBuf> {
        self.root.read().unwrap().clone()
    }

    pub fn require_root(&self) -> AppResult<PathBuf> {
        match self.root() {
            Some(root) => Ok(root),
            None => bail!("フォルダーが開かれていません"),
        }
    }

    pub fn set_root(&self, path: &Path) -> AppResult<PathBuf> {
        let canonical = std::fs::canonicalize(path)?;
        if !canonical.is_dir() {
            bail!("フォルダーではありません: {}", display(&canonical));
        }
        *self.root.write().unwrap() = Some(canonical.clone());
        Ok(canonical)
    }

    pub fn close(&self) {
        *self.root.write().unwrap() = None;
    }

    pub fn grant(&self, path: &Path) -> AppResult<PathBuf> {
        let canonical = canonical_for_write(path)?;
        self.granted.write().unwrap().insert(canonical.clone());
        Ok(canonical)
    }

    fn allowed(&self, canonical: &Path) -> bool {
        if let Some(root) = self.root()
            && canonical.starts_with(&root)
        {
            return true;
        }
        self.granted.read().unwrap().contains(canonical)
    }

    /// Resolves an existing path for reading or modification.
    pub fn resolve_existing(&self, path: &str) -> AppResult<PathBuf> {
        let candidate = absolute(path)?;
        let canonical = std::fs::canonicalize(&candidate)
            .map_err(|e| format!("{}: {e}", display(&candidate)))?;
        if !self.allowed(&canonical) {
            bail!("ワークスペースの外のパスです: {}", display(&candidate));
        }
        Ok(canonical)
    }

    /// Resolves a path that may not exist yet (a file about to be saved).
    pub fn resolve_for_write(&self, path: &str) -> AppResult<PathBuf> {
        let candidate = absolute(path)?;
        let canonical = canonical_for_write(&candidate)?;
        if !self.allowed(&canonical) {
            bail!("ワークスペースの外のパスです: {}", display(&candidate));
        }
        Ok(canonical)
    }

    /// Resolves a directory inside the workspace and a new child name inside it.
    pub fn resolve_new_child(&self, dir: &str, name: &str) -> AppResult<PathBuf> {
        validate_file_name(name)?;
        let dir = self.resolve_in_root(dir)?;
        if !dir.is_dir() {
            bail!("フォルダーではありません: {}", display(&dir));
        }
        Ok(dir.join(name))
    }

    /// Like `resolve_existing`, but only inside the root (never a granted outside file). Used for
    /// structural operations: rename, delete, listing.
    pub fn resolve_in_root(&self, path: &str) -> AppResult<PathBuf> {
        let root = self.require_root()?;
        let resolved = self.resolve_existing(path)?;
        if !resolved.starts_with(&root) {
            bail!("ワークスペースの外のパスです: {path}");
        }
        Ok(resolved)
    }
}

fn absolute(path: &str) -> AppResult<PathBuf> {
    if path.is_empty() || path.contains('\0') {
        bail!("不正なパスです");
    }
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        bail!("絶対パスが必要です: {}", display(&path));
    }
    Ok(path)
}

/// Canonicalizes the parent directory and appends the (validated) file name, so the result is
/// canonical even when the file itself does not exist yet.
fn canonical_for_write(path: &Path) -> AppResult<PathBuf> {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return Ok(canonical);
    }
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        bail!("ファイル名がありません: {}", display(path));
    };
    validate_file_name(name)?;
    let Some(parent) = path.parent() else {
        bail!("親フォルダーがありません: {}", display(path));
    };
    let parent = std::fs::canonicalize(parent)?;
    Ok(parent.join(name))
}

/// Rejects names that are not a single, portable path component.
pub fn validate_file_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name.trim() != name {
        bail!("名前が空か、前後に空白があります");
    }
    if name.len() > 255 {
        bail!("名前が長すぎます");
    }
    let mut components = Path::new(name).components();
    if !matches!(
        (components.next(), components.next()),
        (Some(Component::Normal(_)), None)
    ) {
        bail!("使えない名前です: {name}");
    }
    if name.chars().any(|c| {
        c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        bail!("名前に使えない文字があります: {name}");
    }
    if name.ends_with('.') {
        bail!("名前の末尾に「.」は使えません");
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        bail!("Windows の予約名は使えません: {name}");
    }
    Ok(())
}

/// The form of a path shown to the user and sent to the frontend: without the `\\?\` prefix that
/// `canonicalize` adds on Windows (kept for UNC paths, where removing it would change meaning).
pub fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\")
        && !rest.starts_with("UNC\\")
    {
        return rest.to_string();
    }
    text.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unportable_names() {
        for bad in [
            "", " a", "a ", "..", ".", "a/b", "a\\b", "CON", "com1.txt", "x:y", "a.", "a\u{1}",
        ] {
            assert!(validate_file_name(bad).is_err(), "{bad:?}");
        }
        for good in ["main.rw", "テスト.rw", ".gitignore", "console.rw", "COM10"] {
            assert!(validate_file_name(good).is_ok(), "{good:?}");
        }
    }

    #[test]
    fn confines_to_root() {
        let base = std::env::temp_dir().join(format!("epoch-ws-{}", std::process::id()));
        let inside = base.join("project");
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::write(base.join("secret.txt"), "x").unwrap();
        std::fs::write(inside.join("main.rw"), "x").unwrap();
        let ws = Workspace::default();
        ws.set_root(&inside).unwrap();
        let ok = inside.join("main.rw");
        assert!(ws.resolve_existing(ok.to_str().unwrap()).is_ok());
        let escape = inside.join("..").join("secret.txt");
        assert!(ws.resolve_existing(escape.to_str().unwrap()).is_err());
        assert!(
            ws.resolve_for_write(base.join("new.txt").to_str().unwrap())
                .is_err()
        );
        assert!(ws.resolve_existing("relative.rw").is_err());
        assert!(
            ws.resolve_new_child(inside.to_str().unwrap(), "../x")
                .is_err()
        );
        let granted = ws.grant(&base.join("secret.txt")).unwrap();
        assert!(ws.resolve_existing(&display(&granted)).is_ok());
        std::fs::remove_dir_all(&base).unwrap();
    }
}
