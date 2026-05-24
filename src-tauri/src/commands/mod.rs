use serde::{Deserialize, Serialize};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::auth::AuthSession;

mod guards;
mod auth;
mod db;
mod file;
mod config;
mod watcher;
mod ui;

pub use auth::{store_tokens, logout, store_key_password, get_key_password, get_auth_status, get_session_tokens, restore_session_from_keyring, open_captcha_window, close_captcha_window};
pub use db::{get_all_file_states, upsert_file_state, set_file_sync_state, get_file_state_by_remote_id, get_file_state_by_local_path, get_db_sync_config, set_db_sync_config, delete_file_state, clear_all_file_states};
pub use file::{ensure_local_dir, list_local_dir, read_local_file, write_local_file, truncate_local_file, write_local_file_chunk, trash_local_file, delete_local_file, delete_local_dir, stat_local_file, rename_local_file, list_dir_recursive, LocalFileEntry};
pub use config::{validate_local_root, set_local_root, get_local_root, get_home_dir, LocalRootInfo};
pub use watcher::{start_file_watcher, stop_file_watcher};
pub use ui::{show_notification, get_autostart_enabled, enable_autostart, disable_autostart, update_tray_status, get_tray_status, show_main_window, emit_pause_toggle, RecentFile, TrayStatusPayload};

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



