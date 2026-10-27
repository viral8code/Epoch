//! User settings and the last session, kept as JSON in the per-user config directory. Everything
//! read back is clamped to sane values, so a hand-edited file cannot break the editor.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub font_family: String,
    pub font_size: u32,
    pub line_height: u32,
    pub tab_size: u32,
    pub insert_spaces: bool,
    pub word_wrap: bool,
    pub minimap: bool,
    pub render_whitespace: bool,
    pub format_on_save: bool,
    pub auto_save: bool,
    pub auto_save_delay_ms: u32,
    pub rewind_path: String,
    pub default_effects: String,
    pub check_on_save: bool,
    pub recent_workspaces: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "dark".into(),
            font_family: "Cascadia Mono, Consolas, 'BIZ UDGothic', 'MS Gothic', monospace".into(),
            font_size: 14,
            line_height: 0,
            tab_size: 4,
            insert_spaces: true,
            word_wrap: false,
            minimap: true,
            render_whitespace: false,
            format_on_save: false,
            auto_save: false,
            auto_save_delay_ms: 1000,
            rewind_path: String::new(),
            default_effects: String::new(),
            check_on_save: true,
            recent_workspaces: Vec::new(),
        }
    }
}

impl Settings {
    pub fn sanitized(mut self) -> Self {
        if !matches!(self.theme.as_str(), "dark" | "light" | "blue") {
            self.theme = "dark".into();
        }
        self.font_size = self.font_size.clamp(8, 48);
        self.line_height = if self.line_height == 0 {
            0
        } else {
            self.line_height.clamp(10, 80)
        };
        self.tab_size = self.tab_size.clamp(1, 16);
        self.auto_save_delay_ms = self.auto_save_delay_ms.clamp(200, 60_000);
        // Limits count characters: `String::truncate` would panic inside a multi-byte character.
        self.font_family = self
            .font_family
            .chars()
            .filter(|c| !matches!(c, ';' | '{' | '}' | '<' | '>'))
            .take(300)
            .collect();
        if !crate::tasks::valid_effects(&self.default_effects) {
            self.default_effects.clear();
        }
        self.rewind_path = self.rewind_path.chars().take(1024).collect();
        self.recent_workspaces
            .retain(|p| !p.is_empty() && p.len() < 4096);
        self.recent_workspaces.dedup();
        self.recent_workspaces.truncate(12);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizing_clamps_and_keeps_multibyte_text_whole() {
        let settings = Settings {
            theme: "neon".into(),
            font_size: 200,
            font_family: "あ".repeat(400) + "{x}",
            rewind_path: "ü".repeat(2000),
            default_effects: "file;rm".into(),
            ..Settings::default()
        }
        .sanitized();
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.font_size, 48);
        assert_eq!(settings.font_family.chars().count(), 300);
        assert_eq!(settings.rewind_path.chars().count(), 1024);
        assert!(settings.default_effects.is_empty());
    }
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub workspace: Option<String>,
    pub open_files: Vec<String>,
    pub active_file: Option<String>,
}

fn dir() -> Option<PathBuf> {
    dirs::config_dir().map(|d| d.join("Epoch"))
}

fn load<T: Default + for<'de> Deserialize<'de>>(name: &str) -> T {
    dir()
        .and_then(|d| std::fs::read(d.join(name)).ok())
        .filter(|bytes| bytes.len() < 4 * 1024 * 1024)
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn store<T: Serialize>(name: &str, value: &T) -> AppResult<()> {
    let Some(dir) = dir() else {
        return Ok(());
    };
    std::fs::create_dir_all(&dir)?;
    let bytes = serde_json::to_vec_pretty(value)?;
    crate::files::atomic_write(&dir.join(name), &bytes)
}

pub fn load_settings() -> Settings {
    load::<Settings>("settings.json").sanitized()
}

pub fn save_settings(settings: &Settings) -> AppResult<()> {
    store("settings.json", settings)
}

pub fn load_session() -> Session {
    let mut session: Session = load("session.json");
    session.open_files.truncate(100);
    session
}

pub fn save_session(session: &Session) -> AppResult<()> {
    store("session.json", session)
}
