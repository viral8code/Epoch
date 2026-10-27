// Release builds are GUI programs: no console window behind the editor.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    epoch_lib::run();
}
