use tauri::State;
use super::{AppState, CommandError};
use crate::watcher;
use std::sync::atomic::Ordering;

#[tauri::command]
pub fn start_file_watcher(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    // Stop any existing watcher before starting a new one.
    if let Some(old_stop) = state.watcher_stop.lock().unwrap().take() {
        old_stop.store(true, Ordering::Relaxed);
    }
    let stop = watcher::start_watcher(app, std::path::PathBuf::from(path));
    *state.watcher_stop.lock().unwrap() = Some(stop);
    Ok(())
}

#[tauri::command]
pub fn stop_file_watcher(state: State<'_, AppState>) {
    if let Some(stop) = state.watcher_stop.lock().unwrap().take() {
        stop.store(true, Ordering::Relaxed);
    }
}
