// The only way the window reaches the system: commands implemented in Rust (src-side `#[tauri::command]`).
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const call = (command, args = {}) => invoke(command, args);
export const on = (event, handler) => listen(event, (e) => handler(e.payload));
export const setWindowTitle = (title) => getCurrentWindow().setTitle(title).catch(() => {});

export function errorText(error) {
  if (typeof error === 'string') return error;
  return error?.message ?? String(error);
}
