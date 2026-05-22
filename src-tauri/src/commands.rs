use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

use crate::auth::{AuthSession, ProtonAuth};
use crate::db::{Db, FileState};
use crate::keyring;

pub struct AppState {
    pub session: Mutex<Option<AuthSession>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
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
pub fn start_file_watcher(path: String, app: tauri::AppHandle) -> Result<(), String> {
    crate::watcher::start_watcher(app, std::path::PathBuf::from(path));
    Ok(())
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
