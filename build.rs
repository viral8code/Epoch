//! The app manifest lists every command the window may call; `capabilities/default.json` grants
//! them to the main window only. A command missing from either list cannot be invoked.

const COMMANDS: &[&str] = &[
    "app_init",
    "open_workspace_dialog",
    "open_recent_workspace",
    "close_workspace",
    "workspace_project",
    "open_file_dialog",
    "save_file_dialog",
    "open_trace_dialog",
    "pick_rewind_dialog",
    "save_settings",
    "save_session",
    "toolchain_info",
    "app_exit",
    "list_dir",
    "read_text_file",
    "write_text_file",
    "file_stamp",
    "create_file",
    "create_dir",
    "rename_path",
    "delete_path",
    "reveal_path",
    "lsp_start",
    "lsp_request",
    "lsp_notify",
    "lsp_stop",
    "dap_start",
    "dap_request",
    "dap_stop",
    "task_start",
    "task_input",
    "task_close_input",
    "task_kill",
    "list_workspace_files",
    "search_start",
    "search_cancel",
    "search_replace",
    "load_timeline",
];

fn main() {
    // The window is bundled by `ui/build.mjs`; Tauri embeds ui/dist at compile time.
    if !std::path::Path::new("ui/dist/index.html").exists() {
        panic!("ui/dist がありません。先に `cd ui && npm ci && npm run build` を実行してください。");
    }
    println!("cargo:rerun-if-changed=ui/dist");
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("tauri build failed");
}
