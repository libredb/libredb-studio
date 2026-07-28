// Hide the console window on Windows release builds; on Linux this is inert.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    libredb_studio_desktop::run();
}
