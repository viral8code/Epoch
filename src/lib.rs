//! Epoch — an integrated development environment for the REWIND programming language.
//!
//! The Rust side owns everything that touches the system: files (confined to the open folder),
//! the `rewind` language server and debugger, running programs, and searching. The window shows
//! a Monaco editor and talks to this side only through the commands registered below.

pub mod app;
pub mod dap;
pub mod error;
pub mod files;
pub mod lsp;
pub mod process;
pub mod rpc;
pub mod search;
pub mod settings;
pub mod state;
pub mod tasks;
pub mod timeline;
pub mod toolchain;
pub mod workspace;

use tauri::{Emitter, Manager, WindowEvent};

pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::new())
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                // The page decides: it asks about unsaved files, then calls `app_exit`.
                api.prevent_close();
                let _ = window.emit("close-requested", ());
            }
            WindowEvent::Destroyed => {
                window.app_handle().state::<state::AppState>().shutdown();
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            app::app_init,
            app::open_workspace_dialog,
            app::open_recent_workspace,
            app::close_workspace,
            app::workspace_project,
            app::open_file_dialog,
            app::save_file_dialog,
            app::open_trace_dialog,
            app::pick_rewind_dialog,
            app::save_settings,
            app::save_session,
            app::toolchain_info,
            app::app_exit,
            files::list_dir,
            files::read_text_file,
            files::write_text_file,
            files::file_stamp,
            files::create_file,
            files::create_dir,
            files::rename_path,
            files::delete_path,
            files::reveal_path,
            lsp::lsp_start,
            lsp::lsp_request,
            lsp::lsp_notify,
            lsp::lsp_stop,
            dap::dap_start,
            dap::dap_request,
            dap::dap_stop,
            tasks::task_start,
            tasks::task_input,
            tasks::task_close_input,
            tasks::task_kill,
            search::list_workspace_files,
            search::search_start,
            search::search_cancel,
            search::search_replace,
            timeline::load_timeline,
        ])
        .run(tauri::generate_context!())
        .expect("Epoch を起動できませんでした");
}
