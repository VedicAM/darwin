mod pi;

use tauri::{AppHandle, State};
use tauri_plugin_opener::init;

/// Sends a prompt to the running `pi` session, spawning it on first use.
/// Returns as soon as Pi accepts the prompt. Progress arrives as `pi://event`.
#[tauri::command]
fn pi_prompt(app: AppHandle, state: State<'_, pi::PiSession>, message: String) -> Result<(), String> {
    state.prompt(&app, message)
}

/// Asks Pi to report its current state (model, provider, ...). The reply comes
/// back through `pi://event` as a `get_state` response, not through this call.
#[tauri::command]
fn pi_get_state(app: AppHandle, state: State<'_, pi::PiSession>) -> Result<(), String> {
    state.get_state(&app)
}

/// Terminates the `pi` child. The next prompt will spawn a fresh one.
#[tauri::command]
fn pi_stop(state: State<'_, pi::PiSession>) -> Result<(), String> {
    state.stop()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(init())
        .manage(pi::PiSession::default())
        .invoke_handler(tauri::generate_handler![pi_prompt, pi_get_state, pi_stop])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
