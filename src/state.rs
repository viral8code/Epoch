use crate::dap::DapManager;
use crate::error::AppResult;
use crate::lsp::LspManager;
use crate::search::SearchManager;
use crate::settings::{self, Settings};
use crate::tasks::TaskManager;
use crate::toolchain::{self, Toolchain};
use crate::workspace::Workspace;
use std::sync::Mutex;

pub struct AppState {
    pub workspace: Workspace,
    pub settings: Mutex<Settings>,
    toolchain: Mutex<Option<Toolchain>>,
    pub lsp: LspManager,
    pub dap: DapManager,
    pub tasks: TaskManager,
    pub search: SearchManager,
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            workspace: Workspace::default(),
            settings: Mutex::new(settings::load_settings()),
            toolchain: Mutex::new(None),
            lsp: LspManager::default(),
            dap: DapManager::default(),
            tasks: TaskManager::default(),
            search: SearchManager::default(),
        }
    }

    /// The `rewind` to use, located and probed on first use and after settings change.
    pub fn toolchain(&self) -> AppResult<Toolchain> {
        if let Some(toolchain) = self.toolchain.lock().unwrap().clone() {
            return Ok(toolchain);
        }
        let configured = self.settings.lock().unwrap().rewind_path.clone();
        let executable = toolchain::locate(&configured, self.workspace.root().as_deref())?;
        let probed = toolchain::probe(&executable)?;
        *self.toolchain.lock().unwrap() = Some(probed.clone());
        Ok(probed)
    }

    pub fn forget_toolchain(&self) {
        *self.toolchain.lock().unwrap() = None;
    }

    pub fn shutdown(&self) {
        self.tasks.kill_all();
        self.lsp.stop();
        self.dap.stop();
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
