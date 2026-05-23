use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

use crate::auth::{AuthSession, ProtonAuth};
use crate::db::{Db, FileState};
use crate::keyring;

pub struct AppState {
    pub session: Mutex<Option<AuthSession>>,
    pub watcher_stop: Mutex<Option<Arc<AtomicBool>>>,
    pub last_tray_status: Mutex<Option<TrayStatusPayload>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            watcher_stop: Mutex::new(None),
            last_tray_status: Mutex::new(None),
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

/// Called by JS after a successful SRP login to persist the session in GNOME Keyring.
#[tauri::command]
pub async fn store_tokens(
    uid: String,
    access_token: String,
    refresh_token: String,
    user_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = AuthSession {
        uid,
        access_token,
        refresh_token,
        user_id,
        two_factor_enabled: false,
    };

    keyring::store_session(&session)
        .await
        .map_err(|e| e.to_string())?;

    *state.session.lock().unwrap() = Some(session);
    Ok(())
}

#[tauri::command]
pub async fn logout(state: State<'_, AppState>) -> Result<(), String> {
    let session = state.session.lock().unwrap().clone();

    if let Some(ref s) = session {
        let base_url = std::env::var("PROTON_API_BASE")
            .unwrap_or_else(|_| "https://mail.proton.me/api".to_string());
        let app_version = std::env::var("PROTON_APP_VERSION")
            .unwrap_or_else(|_| "external-drive-protondrive@0.1.0-alpha".to_string());

        if let Ok(auth) = ProtonAuth::new(&base_url, &app_version) {
            let _ = auth.logout(s).await; // best-effort
        }
    }

    keyring::clear_session()
        .await
        .map_err(|e| e.to_string())?;
    let _ = keyring::clear_key_password().await;

    *state.session.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn store_key_password(key_password: String) -> Result<(), String> {
    keyring::store_key_password(&key_password)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_key_password() -> Option<String> {
    keyring::load_key_password().await
}

#[tauri::command]
pub fn get_auth_status(state: State<'_, AppState>) -> AuthStatus {
    let session = state.session.lock().unwrap();
    match &*session {
        Some(s) => AuthStatus {
            logged_in: true,
            user_id: Some(s.user_id.clone()),
        },
        None => AuthStatus {
            logged_in: false,
            user_id: None,
        },
    }
}

/// Returns session tokens so JS can derive the key password on startup with a restored session.
#[tauri::command]
pub fn get_session_tokens(state: State<'_, AppState>) -> Option<SessionTokens> {
    let session = state.session.lock().unwrap();
    session.as_ref().map(|s| SessionTokens {
        uid: s.uid.clone(),
        access_token: s.access_token.clone(),
        refresh_token: s.refresh_token.clone(),
        user_id: s.user_id.clone(),
    })
}

/// Called at app startup — restore session from keyring if available.
pub async fn restore_session_from_keyring(state: &AppState) {
    if let Some(session) = keyring::load_session().await {
        *state.session.lock().unwrap() = Some(session);
    }
}

/// Opens the Proton human-verification page in a separate window.
/// The verify SPA at verify.proton.me expects: ?methods=captcha,...&token=TOKEN&embed=1
/// It broadcasts { type: 'HUMAN_VERIFICATION_SUCCESS', payload: { token, type } } via postMessage.
#[tauri::command]
pub async fn open_captcha_window(
    token: String,
    methods: Vec<String>,
    theme: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Close any stale captcha window from a previous attempt.
    if let Some(old) = app.get_webview_window("captcha") {
        let _ = old.close();
    }

    let mut url = url::Url::parse("https://verify.proton.me/").map_err(|e| e.to_string())?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("methods", &methods.join(","))
            .append_pair("token", &token)
            .append_pair("embed", "1");
        if let Some(t) = theme.as_deref() {
            q.append_pair("theme", t);
        }
    }

    // verify.proton.me detects the host environment and picks a postMessage path:
    //   - WebView2 (Chromium): calls window.chrome.webview.postMessage({type:'pm_captcha', token:TOKEN})
    //   - iframe embed:        calls window.parent.postMessage({type:'HUMAN_VERIFICATION_SUCCESS', payload:{token}})
    //
    // In a standalone WebKit window neither exists, so the page shows completion UI but
    // never sends the token anywhere. Fix: inject a window.chrome.webview shim so the
    // verify app takes the pm_captcha path. Also cover the postMessage path as a fallback.
    //
    // Token delivery uses window.location.href = 'pd-captcha://...' which is NOT subject
    // to connect-src CSP. The scheme is registered in lib.rs so WebKit2GTK treats it as
    // a known scheme and routes it to our handler.
    let init_script = r#"
        (function() {
            function relay(token) {
                window.location.href = 'pd-captcha://solved?token=' + encodeURIComponent(token);
            }

            // Shim window.chrome.webview so verify.proton.me uses the pm_captcha path.
            if (!window.chrome) { window.chrome = {}; }
            window.chrome.webview = {
                postMessage: function(data) {
                    try {
                        var msg = (typeof data === 'string') ? JSON.parse(data) : data;
                        if (msg && msg.type === 'pm_captcha' && msg.token) {
                            relay(msg.token);
                        }
                    } catch (e) {}
                }
            };

            // Fallback: intercept window.postMessage in case the page uses that path.
            window.addEventListener('message', function(e) {
                var d = e.data;
                if (!d) { return; }
                if (d.type === 'HUMAN_VERIFICATION_SUCCESS' && d.payload && d.payload.token) {
                    relay(d.payload.token);
                } else if (d.type === 'pm_captcha' && d.token) {
                    relay(d.token);
                }
            });
        })();
    "#;

    let app_handle = app.clone();
    tauri::WebviewWindowBuilder::new(&app, "captcha", tauri::WebviewUrl::External(url))
        .title("Human Verification — Proton Drive")
        .inner_size(480.0, 700.0)
        .resizable(true)
        .devtools(true)
        .on_navigation(move |nav_url| {
            if nav_url.scheme() == "pd-captcha" {
                let token = nav_url
                    .query_pairs()
                    .find(|(k, _)| k == "token")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                let handle = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle.emit("captcha-token", token);
                    if let Some(w) = handle.get_webview_window("captcha") {
                        let _ = w.close();
                    }
                });
                false // block the navigation so the page doesn't actually load pd-captcha://
            } else {
                true // allow all normal navigation (initial load, internal verify.proton.me redirects)
            }
        })
        .initialization_script(init_script)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Closes the captcha window if it is open.
#[tauri::command]
pub fn close_captcha_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("captcha") {
        let _ = w.close();
    }
}

// ── DB commands ──────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_all_file_states(db: State<'_, Db>) -> Result<Vec<FileState>, String> {
    db.all_files().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_file_state(
    remote_id: String,
    local_path: String,
    etag: Option<String>,
    modified_at: Option<i64>,
    size_bytes: Option<i64>,
    sync_state: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    let state = FileState {
        remote_id,
        local_path,
        etag,
        modified_at,
        size_bytes,
        sync_state,
    };
    db.upsert_file(&state).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_file_sync_state(
    remote_id: String,
    sync_state: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    db.set_sync_state(&remote_id, &sync_state)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_file_state_by_remote_id(
    remote_id: String,
    db: State<'_, Db>,
) -> Result<Option<FileState>, String> {
    db.get_by_remote_id(&remote_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_file_state_by_local_path(
    local_path: String,
    db: State<'_, Db>,
) -> Result<Option<FileState>, String> {
    db.get_by_local_path(&local_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_db_sync_config(key: String, db: State<'_, Db>) -> Result<Option<String>, String> {
    db.get_sync_config(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_db_sync_config(
    key: String,
    value: String,
    db: State<'_, Db>,
) -> Result<(), String> {
    db.set_sync_config(&key, &value).map_err(|e| e.to_string())
}

// ── Local file I/O commands ──────────────────────────────────────────────────

/// Creates the directory at abs_path (including parents) if it doesn't already exist.
#[tauri::command]
pub fn ensure_local_dir(abs_path: String) -> Result<(), String> {
    std::fs::create_dir_all(&abs_path).map_err(|e| format!("create_dir_all {abs_path}: {e}"))
}

/// Lists regular files (non-directories) directly inside abs_path. Returns absolute paths.
#[tauri::command]
pub fn list_local_dir(abs_path: String) -> Result<Vec<String>, String> {
    let entries = std::fs::read_dir(&abs_path)
        .map_err(|e| format!("read_dir {abs_path}: {e}"))?;
    let mut files = Vec::new();
    for entry in entries.flatten() {
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            files.push(entry.path().to_string_lossy().into_owned());
        }
    }
    Ok(files)
}

/// Reads a local file and returns its contents as a base64-encoded string.
#[tauri::command]
pub fn read_local_file(abs_path: String) -> Result<String, String> {
    let bytes = std::fs::read(&abs_path).map_err(|e| format!("read {abs_path}: {e}"))?;
    Ok(STANDARD.encode(&bytes))
}

/// Decodes a base64 string and writes it to a local file, creating parent dirs as needed.
#[tauri::command]
pub fn write_local_file(abs_path: String, content_b64: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(&content_b64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    if let Some(parent) = std::path::Path::new(&abs_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;
    }
    std::fs::write(&abs_path, &bytes).map_err(|e| format!("write {abs_path}: {e}"))
}

/// Creates (or truncates) a local file, creating parent dirs as needed.
/// Used to initialise a file before streaming chunks via write_local_file_chunk.
#[tauri::command]
pub fn truncate_local_file(abs_path: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&abs_path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_all {}: {e}", parent.display()))?;
    }
    std::fs::File::create(&abs_path).map_err(|e| format!("truncate {abs_path}: {e}"))?;
    Ok(())
}

/// Decodes a base64 chunk and appends it to an existing file.
/// Must be called after truncate_local_file to ensure the file exists.
#[tauri::command]
pub fn write_local_file_chunk(abs_path: String, content_b64: String) -> Result<(), String> {
    use std::io::Write;
    let bytes = STANDARD
        .decode(&content_b64)
        .map_err(|e| format!("base64 decode: {e}"))?;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&abs_path)
        .map_err(|e| format!("open append {abs_path}: {e}"))?;
    file.write_all(&bytes).map_err(|e| format!("write chunk {abs_path}: {e}"))
}

/// Moves a local file into `{sync_root}/.trash/` instead of permanently deleting it.
/// Creates the trash directory as needed. Silently succeeds if the source does not exist.
#[tauri::command]
pub fn trash_local_file(abs_path: String, sync_root: String) -> Result<(), String> {
    let src = std::path::Path::new(&abs_path);
    if !src.exists() {
        return Ok(());
    }
    let trash_dir = std::path::Path::new(&sync_root).join(".trash");
    std::fs::create_dir_all(&trash_dir)
        .map_err(|e| format!("create trash dir: {e}"))?;

    let filename = src
        .file_name()
        .ok_or_else(|| format!("no filename in {abs_path}"))?;
    // Append a timestamp so repeated deletes of the same name don't collide.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let dest_name = format!("{}.{ts}", filename.to_string_lossy());
    let dest = trash_dir.join(dest_name);

    std::fs::rename(src, &dest).map_err(|e| format!("rename {abs_path} → {}: {e}", dest.display()))
}

/// Deletes a local file. Silently succeeds if the file does not exist.
#[tauri::command]
pub fn delete_local_file(abs_path: String) -> Result<(), String> {
    match std::fs::remove_file(&abs_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove_file {abs_path}: {e}")),
    }
}

/// Recursively deletes a local directory. Silently succeeds if the path does not exist.
#[tauri::command]
pub fn delete_local_dir(abs_path: String) -> Result<(), String> {
    match std::fs::remove_dir_all(&abs_path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove_dir_all {abs_path}: {e}")),
    }
}

/// Returns the modification time (in ms since Unix epoch) and size of a local file.
#[tauri::command]
pub fn stat_local_file(abs_path: String) -> Result<FileStat, String> {
    let meta = std::fs::metadata(&abs_path)
        .map_err(|e| format!("stat {abs_path}: {e}"))?;
    let mtime_ms = meta
        .modified()
        .map_err(|e| format!("mtime {abs_path}: {e}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    Ok(FileStat {
        mtime_ms,
        size_bytes: meta.len() as i64,
        is_dir: meta.is_dir(),
    })
}

/// Renames (moves) a local file. Fails if the source does not exist.
#[tauri::command]
pub fn rename_local_file(from_path: String, to_path: String) -> Result<(), String> {
    std::fs::rename(&from_path, &to_path)
        .map_err(|e| format!("rename {from_path} → {to_path}: {e}"))
}

// ── Local root management ─────────────────────────────────────────────────────

const SYSTEM_DIRS: &[&str] = &[
    "/usr", "/etc", "/var", "/bin", "/lib", "/sbin", "/boot", "/proc", "/sys", "/dev", "/run",
    "/tmp",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRootInfo {
    pub valid: bool,
    pub exists: bool,
    pub is_empty: bool,
    pub file_count: u32,
    pub error: Option<String>,
}

#[tauri::command]
pub fn validate_local_root(path: String) -> Result<LocalRootInfo, String> {
    let p = std::path::Path::new(&path);

    if !p.is_absolute() {
        return Ok(LocalRootInfo {
            valid: false,
            exists: false,
            is_empty: true,
            file_count: 0,
            error: Some("Path must be absolute".into()),
        });
    }

    let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;
    let home_path = std::path::Path::new(&home);

    if path == home {
        return Ok(LocalRootInfo {
            valid: false,
            exists: p.exists(),
            is_empty: false,
            file_count: 0,
            error: Some("Cannot sync directly into your home directory".into()),
        });
    }

    if !p.starts_with(home_path) {
        return Ok(LocalRootInfo {
            valid: false,
            exists: p.exists(),
            is_empty: false,
            file_count: 0,
            error: Some("Path must be inside your home directory".into()),
        });
    }

    for sys in SYSTEM_DIRS {
        if p.starts_with(sys) {
            return Ok(LocalRootInfo {
                valid: false,
                exists: p.exists(),
                is_empty: false,
                file_count: 0,
                error: Some(format!("Cannot use system directory {sys}")),
            });
        }
    }

    let exists = p.exists();
    if !exists {
        return Ok(LocalRootInfo {
            valid: true,
            exists: false,
            is_empty: true,
            file_count: 0,
            error: None,
        });
    }

    let file_count = count_files_capped(p, 10_000);
    Ok(LocalRootInfo {
        valid: true,
        exists: true,
        is_empty: file_count == 0,
        file_count,
        error: None,
    })
}

fn count_files_capped(dir: &std::path::Path, cap: u32) -> u32 {
    let mut count = 0u32;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        if count >= cap {
            return count;
        }
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_file() {
            count += 1;
        } else if ft.is_dir() {
            count = count.saturating_add(count_files_capped(&entry.path(), cap - count));
        }
    }
    count
}

#[tauri::command]
pub fn set_local_root(path: String, db: State<'_, Db>) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        std::fs::create_dir_all(p).map_err(|e| format!("Cannot create directory: {e}"))?;
    }
    db.set_sync_config("local_root", &path)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_local_root(db: State<'_, Db>) -> Result<Option<String>, String> {
    db.get_sync_config("local_root").map_err(|e| e.to_string())
}

// ── Recursive directory listing ───────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub rel_path: String,
    pub abs_path: String,
    pub mtime_ms: i64,
    pub size_bytes: i64,
}

#[tauri::command]
pub fn list_dir_recursive(abs_path: String) -> Result<Vec<LocalFileEntry>, String> {
    let root = std::path::Path::new(&abs_path);
    let mut results = Vec::new();
    collect_recursive(root, root, &mut results, 10_000)?;
    Ok(results)
}

fn collect_recursive(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<LocalFileEntry>,
    cap: usize,
) -> Result<(), String> {
    if out.len() >= cap {
        return Ok(());
    }
    let entries =
        std::fs::read_dir(dir).map_err(|e| format!("read_dir {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        if out.len() >= cap {
            break;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if path.file_name().map_or(false, |n| n == ".trash") {
                continue;
            }
            collect_recursive(root, &path, out, cap)?;
        } else if ft.is_file() {
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_millis() as i64);
            let rel_path = path
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(LocalFileEntry {
                rel_path,
                abs_path: path.to_string_lossy().into_owned(),
                mtime_ms,
                size_bytes: meta.len() as i64,
            });
        }
    }
    Ok(())
}

// ── File watcher (on-demand) ──────────────────────────────────────────────────

#[tauri::command]
pub fn start_file_watcher(
    path: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
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

#[tauri::command]
pub fn delete_file_state(remote_id: String, db: State<'_, Db>) -> Result<(), String> {
    db.delete_by_remote_id(&remote_id).map_err(|e| e.to_string())
}

/// Removes all file-state rows. Called when the user changes the sync root so the
/// new sync session starts with a clean slate instead of treating old paths as conflicts.
#[tauri::command]
pub fn clear_all_file_states(db: State<'_, Db>) -> Result<(), String> {
    db.clear_all().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "~".into())
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
pub fn enable_autostart() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = autostart_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = format!(
        "[Desktop Entry]\nType=Application\nName=Proton Drive Sync\nExec={} --minimized\nHidden=false\nX-GNOME-Autostart-enabled=true\n",
        exe.display()
    );
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn disable_autostart() -> Result<(), String> {
    let path = autostart_path()?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
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
) -> Result<(), String> {
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

    // Build tray icon to reflect state.
    let icon_bytes: &[u8] = if payload.paused {
        include_bytes!("../icons/tray-idle.png")
    } else if payload.syncing {
        include_bytes!("../icons/tray-syncing.png")
    } else if payload.error_count > 0 {
        include_bytes!("../icons/tray-error.png")
    } else {
        include_bytes!("../icons/tray-idle.png")
    };
    let icon = tauri::image::Image::from_bytes(icon_bytes).map_err(|e| e.to_string())?;
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

// ── GLib warning suppressor ──────────────────────────────────────────────────

/// Silences the one-time deprecation warning that libayatana-appindicator3
/// emits via g_warning() on initialisation. The tray-icon crate correctly
/// links against libayatana-appindicator3-1 (GTK3); there is no glib-only
/// variant supported by tray-icon yet, so this warning cannot be avoided at
/// the library level.
#[cfg(target_os = "linux")]
pub fn suppress_appindicator_warning() {
    use std::ffi::{c_char, c_uint, c_void};

    #[link(name = "glib-2.0")]
    extern "C" {
        fn g_log_set_handler(
            log_domain: *const c_char,
            log_levels: c_uint,
            log_func: unsafe extern "C" fn(*const c_char, c_uint, *const c_char, *mut c_void),
            user_data: *mut c_void,
        ) -> c_uint;
    }

    unsafe extern "C" fn noop(
        _domain: *const c_char,
        _level: c_uint,
        _message: *const c_char,
        _data: *mut c_void,
    ) {
    }

    // G_LOG_LEVEL_WARNING = 1 << 4 = 16
    let domain = b"libayatana-appindicator\0";
    unsafe {
        g_log_set_handler(
            domain.as_ptr().cast(),
            16,
            noop,
            std::ptr::null_mut(),
        );
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // ── count_files_capped ────────────────────────────────────────────────────

    #[test]
    fn count_files_capped_empty_dir_returns_zero() {
        let dir = TempDir::new().unwrap();
        assert_eq!(count_files_capped(dir.path(), 1000), 0);
    }

    #[test]
    fn count_files_capped_counts_flat_files() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.txt"), "a").unwrap();
        fs::write(dir.path().join("b.txt"), "b").unwrap();
        fs::write(dir.path().join("c.txt"), "c").unwrap();
        assert_eq!(count_files_capped(dir.path(), 1000), 3);
    }

    #[test]
    fn count_files_capped_counts_files_in_subdirs() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("root.txt"), "r").unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("child.txt"), "c").unwrap();
        assert_eq!(count_files_capped(dir.path(), 1000), 2);
    }

    #[test]
    fn count_files_capped_stops_at_cap() {
        let dir = TempDir::new().unwrap();
        for i in 0..10 {
            fs::write(dir.path().join(format!("{i}.txt")), "x").unwrap();
        }
        assert_eq!(count_files_capped(dir.path(), 3), 3);
    }

    // ── collect_recursive ─────────────────────────────────────────────────────

    #[test]
    fn collect_recursive_skips_trash_subdirectory() {
        let dir = TempDir::new().unwrap();
        let trash = dir.path().join(".trash");
        fs::create_dir(&trash).unwrap();
        fs::write(trash.join("deleted.txt"), "gone").unwrap();
        fs::write(dir.path().join("kept.txt"), "keep").unwrap();

        let mut out = Vec::new();
        collect_recursive(dir.path(), dir.path(), &mut out, 1000).unwrap();

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rel_path, "kept.txt");
    }

    #[test]
    fn collect_recursive_builds_relative_paths() {
        let dir = TempDir::new().unwrap();
        let sub = dir.path().join("docs");
        fs::create_dir(&sub).unwrap();
        fs::write(sub.join("report.pdf"), "pdf").unwrap();

        let mut out = Vec::new();
        collect_recursive(dir.path(), dir.path(), &mut out, 1000).unwrap();

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rel_path, "docs/report.pdf");
    }

    #[test]
    fn collect_recursive_honors_cap() {
        let dir = TempDir::new().unwrap();
        for i in 0..20 {
            fs::write(dir.path().join(format!("{i}.txt")), "x").unwrap();
        }
        let mut out = Vec::new();
        collect_recursive(dir.path(), dir.path(), &mut out, 5).unwrap();
        assert!(out.len() <= 5);
    }

    #[test]
    fn collect_recursive_populates_abs_path_and_size() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("file.txt"), "hello").unwrap();

        let mut out = Vec::new();
        collect_recursive(dir.path(), dir.path(), &mut out, 1000).unwrap();

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].size_bytes, 5);
        assert!(out[0].abs_path.ends_with("file.txt"));
        assert!(out[0].mtime_ms > 0);
    }

    // ── list_local_dir ────────────────────────────────────────────────────────

    #[test]
    fn list_local_dir_returns_only_files_not_dirs() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("file.txt"), "data").unwrap();
        fs::create_dir(dir.path().join("subdir")).unwrap();

        let result = list_local_dir(dir.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(result.len(), 1);
        assert!(result[0].ends_with("file.txt"));
    }

    #[test]
    fn list_local_dir_empty_dir_returns_empty() {
        let dir = TempDir::new().unwrap();
        let result = list_local_dir(dir.path().to_string_lossy().into_owned()).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn list_local_dir_errors_on_nonexistent_path() {
        assert!(list_local_dir("/nonexistent/path/zzzz".to_string()).is_err());
    }

    // ── read_local_file / write_local_file ────────────────────────────────────

    #[test]
    fn write_and_read_local_file_round_trips() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.bin").to_string_lossy().into_owned();
        let original = b"hello world \x00\xff";
        let encoded = base64::engine::general_purpose::STANDARD.encode(original);

        write_local_file(path.clone(), encoded).unwrap();
        let result_b64 = read_local_file(path).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(result_b64)
            .unwrap();
        assert_eq!(decoded, original);
    }

    #[test]
    fn write_local_file_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir
            .path()
            .join("a/b/c/file.txt")
            .to_string_lossy()
            .into_owned();
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"data");
        write_local_file(path.clone(), encoded).unwrap();
        assert!(std::path::Path::new(&path).exists());
    }

    #[test]
    fn read_local_file_errors_on_missing_file() {
        assert!(read_local_file("/nonexistent/file.txt".to_string()).is_err());
    }

    #[test]
    fn write_local_file_rejects_invalid_base64() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("out.txt").to_string_lossy().into_owned();
        assert!(write_local_file(path, "not!valid!base64!!!".to_string()).is_err());
    }

    // ── delete_local_file ─────────────────────────────────────────────────────

    #[test]
    fn delete_local_file_removes_existing_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("del.txt");
        fs::write(&path, "bye").unwrap();
        delete_local_file(path.to_string_lossy().into_owned()).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn delete_local_file_succeeds_silently_on_missing() {
        assert!(delete_local_file("/tmp/proton_test_missing_zzzz.txt".to_string()).is_ok());
    }

    // ── delete_local_dir ─────────────────────────────────────────────────────

    #[test]
    fn delete_local_dir_removes_directory_tree() {
        let dir = TempDir::new().unwrap();
        let target = dir.path().join("subtree");
        fs::create_dir(&target).unwrap();
        fs::create_dir(target.join("child")).unwrap();
        fs::write(target.join("child").join("file.txt"), "data").unwrap();
        delete_local_dir(target.to_string_lossy().into_owned()).unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn delete_local_dir_succeeds_silently_on_missing() {
        assert!(delete_local_dir("/tmp/proton_test_missing_dir_zzzz".to_string()).is_ok());
    }

    // ── rename_local_file ─────────────────────────────────────────────────────

    #[test]
    fn rename_local_file_moves_the_file() {
        let dir = TempDir::new().unwrap();
        let src = dir.path().join("old.txt");
        let dst = dir.path().join("new.txt");
        fs::write(&src, "content").unwrap();
        rename_local_file(
            src.to_string_lossy().into_owned(),
            dst.to_string_lossy().into_owned(),
        )
        .unwrap();
        assert!(!src.exists());
        assert!(dst.exists());
    }

    #[test]
    fn rename_local_file_errors_on_missing_source() {
        let dir = TempDir::new().unwrap();
        assert!(rename_local_file(
            "/nonexistent/src.txt".to_string(),
            dir.path().join("dst.txt").to_string_lossy().into_owned(),
        )
        .is_err());
    }

    // ── trash_local_file ─────────────────────────────────────────────────────

    #[test]
    fn trash_local_file_moves_file_to_trash_dir() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("important.txt");
        fs::write(&file_path, "data").unwrap();

        trash_local_file(
            file_path.to_string_lossy().into_owned(),
            dir.path().to_string_lossy().into_owned(),
        )
        .unwrap();

        assert!(!file_path.exists());
        let trash = dir.path().join(".trash");
        let entries: Vec<_> = fs::read_dir(&trash).unwrap().flatten().collect();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].file_name().to_string_lossy().contains("important.txt"));
    }

    #[test]
    fn trash_local_file_succeeds_silently_when_source_missing() {
        let dir = TempDir::new().unwrap();
        assert!(trash_local_file(
            "/nonexistent/file.txt".to_string(),
            dir.path().to_string_lossy().into_owned(),
        )
        .is_ok());
    }

    // ── stat_local_file ───────────────────────────────────────────────────────

    #[test]
    fn stat_local_file_returns_correct_size() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("sized.txt");
        fs::write(&path, "12345").unwrap(); // 5 bytes
        let stat = stat_local_file(path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(stat.size_bytes, 5);
    }

    #[test]
    fn stat_local_file_returns_positive_mtime() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("timed.txt");
        fs::write(&path, "x").unwrap();
        let stat = stat_local_file(path.to_string_lossy().into_owned()).unwrap();
        assert!(stat.mtime_ms > 0);
    }

    #[test]
    fn stat_local_file_errors_on_missing() {
        assert!(stat_local_file("/nonexistent/missing.txt".to_string()).is_err());
    }

    // ── validate_local_root ───────────────────────────────────────────────────

    #[test]
    fn validate_local_root_rejects_relative_path() {
        let result = validate_local_root("relative/path".to_string()).unwrap();
        assert!(!result.valid);
        assert!(result.error.is_some());
    }

    #[test]
    fn validate_local_root_rejects_system_dir() {
        let result = validate_local_root("/etc/proton-test-folder".to_string()).unwrap();
        assert!(!result.valid);
        assert!(result.error.is_some());
    }

    #[test]
    fn validate_local_root_rejects_home_directory_itself() {
        let home = std::env::var("HOME").expect("HOME must be set in test environment");
        let result = validate_local_root(home).unwrap();
        assert!(!result.valid);
    }

    #[test]
    fn validate_local_root_rejects_path_outside_home() {
        // /tmp is not under HOME on Linux (HOME is /home/…)
        let result = validate_local_root("/tmp/some-folder".to_string()).unwrap();
        // Either rejected as system dir or as outside HOME — either way, invalid
        assert!(!result.valid);
    }

    #[test]
    fn validate_local_root_accepts_nonexistent_path_under_home() {
        let home = std::env::var("HOME").expect("HOME must be set in test environment");
        let path = format!("{home}/nonexistent-proton-drive-test-zzzz9999");
        let result = validate_local_root(path).unwrap();
        assert!(result.valid, "expected valid, got error: {:?}", result.error);
        assert!(!result.exists);
        assert_eq!(result.file_count, 0);
        assert!(result.error.is_none());
    }

    #[test]
    fn validate_local_root_reports_file_count_for_existing_dir() {
        let home = std::env::var("HOME").expect("HOME must be set in test environment");
        let dir = TempDir::new_in(&home).unwrap();
        fs::write(dir.path().join("one.txt"), "1").unwrap();
        fs::write(dir.path().join("two.txt"), "2").unwrap();

        let result = validate_local_root(dir.path().to_string_lossy().into_owned()).unwrap();
        assert!(result.valid);
        assert!(result.exists);
        assert!(!result.is_empty);
        assert_eq!(result.file_count, 2);
    }
}
