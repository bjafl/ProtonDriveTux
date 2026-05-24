use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

use crate::auth::AuthSession;
use crate::db::{Db, FileState};

mod guards;
mod auth;
mod db;
mod file;
mod config;
mod watcher;
mod ui;

use guards::{canonical, within_sync_root, ensure_parent};

pub use auth::{store_tokens, logout, store_key_password, get_key_password, get_auth_status, get_session_tokens, restore_session_from_keyring, open_captcha_window, close_captcha_window};
pub use db::{get_all_file_states, upsert_file_state, set_file_sync_state, get_file_state_by_remote_id, get_file_state_by_local_path, get_db_sync_config, set_db_sync_config, delete_file_state, clear_all_file_states};
pub use file::{ensure_local_dir, list_local_dir, read_local_file, write_local_file, truncate_local_file, write_local_file_chunk, trash_local_file, delete_local_file, delete_local_dir, stat_local_file, rename_local_file, list_dir_recursive, LocalFileEntry};
pub use config::{validate_local_root, set_local_root, get_local_root, get_home_dir, LocalRootInfo};

#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for CommandError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<String> for CommandError {
    fn from(s: String) -> Self {
        Self::Other(s)
    }
}

impl From<&str> for CommandError {
    fn from(s: &str) -> Self {
        Self::Other(s.to_string())
    }
}

pub struct AppState {
    pub session: Mutex<Option<AuthSession>>,
    pub watcher_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub last_tray_status: Mutex<Option<TrayStatusPayload>>,
    pub icon_idle: tauri::image::Image<'static>,
    pub icon_syncing: tauri::image::Image<'static>,
    pub icon_error: tauri::image::Image<'static>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            watcher_stop: Mutex::new(None),
            last_tray_status: Mutex::new(None),
            icon_idle: tauri::image::Image::from_bytes(include_bytes!("../../icons/tray-idle.png"))
                .expect("tray-idle.png must be a valid PNG"),
            icon_syncing: tauri::image::Image::from_bytes(include_bytes!("../../icons/tray-syncing.png"))
                .expect("tray-syncing.png must be a valid PNG"),
            icon_error: tauri::image::Image::from_bytes(include_bytes!("../../icons/tray-error.png"))
                .expect("tray-error.png must be a valid PNG"),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub user_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokens {
    pub uid: String,
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub mtime_ms: i64,
    pub size_bytes: i64,
    pub is_dir: bool,
}

// ── File watcher (on-demand) ──────────────────────────────────────────────────

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
    let stop = crate::watcher::start_watcher(app, std::path::PathBuf::from(path));
    *state.watcher_stop.lock().unwrap() = Some(stop);
    Ok(())
}

#[tauri::command]
pub fn stop_file_watcher(state: State<'_, AppState>) {
    if let Some(stop) = state.watcher_stop.lock().unwrap().take() {
        stop.store(true, Ordering::Relaxed);
    }
}

// ── Desktop notifications ─────────────────────────────────────────────────────

/// Shows a desktop notification. Silently no-ops if the notification daemon is unavailable.
#[tauri::command]
pub fn show_notification(title: String, body: String) {
    let _ = notify_rust::Notification::new()
        .summary(&title)
        .body(&body)
        .appname("Proton Drive Sync")
        .show();
}

// ── Autostart ─────────────────────────────────────────────────────────────────

fn autostart_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    Ok(std::path::PathBuf::from(home)
        .join(".config")
        .join("autostart")
        .join("proton-drive-sync.desktop"))
}

#[tauri::command]
pub fn get_autostart_enabled() -> bool {
    autostart_path().map(|p| p.exists()).unwrap_or(false)
}

#[tauri::command]
pub fn enable_autostart() -> Result<(), CommandError> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = autostart_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = format!(
        "[Desktop Entry]\nType=Application\nName=Proton Drive Sync\nExec={} --minimized\nHidden=false\nX-GNOME-Autostart-enabled=true\n",
        exe.display()
    );
    std::fs::write(&path, content)
        .map_err(|e| e.to_string())
        .map_err(Into::into)
}

#[tauri::command]
pub fn disable_autostart() -> Result<(), CommandError> {
    let path = autostart_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string().into()),
    }
}

// ── Tray status update ────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub name: String,
    pub direction: String, // "up" | "down"
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayStatusPayload {
    pub paused: bool,
    pub syncing: bool,
    pub active_count: usize,
    pub recent_files: Vec<RecentFile>,
    pub error_count: usize,
}

#[tauri::command]
pub fn update_tray_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    payload: TrayStatusPayload,
) -> Result<(), CommandError> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    #[allow(unused_imports)]
    use tauri::Manager;

    // Persist for the popup window to query on open, and broadcast to all webviews.
    *state.last_tray_status.lock().unwrap() = Some(payload.clone());
    let _ = app.emit("tray://status", &payload);

    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return Ok(()),
    };

    // Build status line text.
    let status_text = if payload.paused {
        "⏸  Synk satt på pause".to_string()
    } else if payload.syncing {
        format!("↕  Synkroniserer {} element(er)…", payload.active_count)
    } else if payload.error_count > 0 {
        format!("⚠  {} feil", payload.error_count)
    } else {
        "✓  Synkronisert".to_string()
    };

    // Tooltip (plain text, no Unicode that causes pango errors on some setups).
    let tooltip = if payload.paused {
        "Proton Drive Sync — pauset".to_string()
    } else if payload.syncing {
        format!("Proton Drive Sync — synkroniserer {}", payload.active_count)
    } else if payload.error_count > 0 {
        format!("Proton Drive Sync — {} feil", payload.error_count)
    } else {
        "Proton Drive Sync — synkronisert".to_string()
    };
    tray.set_tooltip(Some(tooltip.as_str())).map_err(|e| e.to_string())?;

    // Use pre-decoded icon from AppState to avoid PNG decoding on every status update.
    let icon = if payload.syncing && !payload.paused {
        state.icon_syncing.clone()
    } else if payload.error_count > 0 && !payload.paused {
        state.icon_error.clone()
    } else {
        state.icon_idle.clone()
    };
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;

    // Rebuild menu.
    let status_item =
        MenuItem::with_id(&app, "status", &status_text, false, None::<&str>)
            .map_err(|e| e.to_string())?;
    let sep1 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;

    let mut dyn_items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();

    if !payload.recent_files.is_empty() {
        let heading = MenuItem::with_id(&app, "recent-hd", "Nylig synkronisert:", false, None::<&str>)
            .map_err(|e| e.to_string())?;
        dyn_items.push(Box::new(heading));
        for (i, f) in payload.recent_files.iter().take(8).enumerate() {
            let arrow = if f.direction == "up" { "↑" } else { "↓" };
            let label = format!("  {}  {}", arrow, f.name);
            let item = MenuItem::with_id(&app, format!("rf-{i}"), &label, false, None::<&str>)
                .map_err(|e| e.to_string())?;
            dyn_items.push(Box::new(item));
        }
    }

    let sep2 = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let pause_label = if payload.paused { "▶  Gjenoppta sync" } else { "⏸  Sett sync på pause" };
    let pause_id = if payload.paused { "resume" } else { "pause" };
    let pause_item = MenuItem::with_id(&app, pause_id, pause_label, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let show = MenuItem::with_id(&app, "show", "Åpne", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", "Avslutt", true, None::<&str>)
        .map_err(|e| e.to_string())?;

    // Collect all items as trait-object refs.
    let mut refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![&status_item, &sep1];
    for item in &dyn_items {
        refs.push(item.as_ref());
    }
    refs.extend_from_slice(&[&sep2, &pause_item, &show, &quit]);

    let menu = Menu::with_items(&app, &refs).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;

    Ok(())
}

// ── Tray popup helpers ───────────────────────────────────────────────────────

#[tauri::command]
pub fn get_tray_status(state: State<'_, AppState>) -> Option<TrayStatusPayload> {
    state.last_tray_status.lock().unwrap().clone()
}

#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
pub fn emit_pause_toggle(app: tauri::AppHandle) {
    let _ = app.emit("sync://pause-toggle", ());
}

