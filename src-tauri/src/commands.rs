use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

use crate::auth::{AuthSession, ProtonAuth};
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

    *state.session.lock().unwrap() = None;
    Ok(())
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
    app: tauri::AppHandle,
) -> Result<(), String> {
    // Close any stale captcha window from a previous attempt.
    if let Some(old) = app.get_webview_window("captcha") {
        let _ = old.close();
    }

    let mut url = url::Url::parse("https://verify.proton.me/").map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("methods", &methods.join(","))
        .append_pair("token", &token)
        .append_pair("embed", "1");

    // In a standalone window window.parent === window, so postMessage to parent fires on self.
    // The verify app sends { type: 'HUMAN_VERIFICATION_SUCCESS', payload: { token, type } }.
    let init_script = r#"
        (function() {
            function dbg(msg) {
                window.__TAURI_INTERNALS__.invoke('captcha_debug', { msg: String(msg) }).catch(function(){});
            }

            dbg('init, href=' + location.href + ' parent===self=' + (window.parent === window.self));

            window.addEventListener('message', function(e) {
                dbg('msg: ' + JSON.stringify(e.data));
                if (e.data && e.data.type === 'HUMAN_VERIFICATION_SUCCESS' && e.data.payload && e.data.payload.token) {
                    window.__TAURI_INTERNALS__.invoke('relay_captcha_token', { token: e.data.payload.token })
                        .catch(function(err) { dbg('relay failed: ' + err); });
                }
            });

            window.addEventListener('load', function() {
                dbg('load, final href=' + location.href);
            });
        })();
    "#;

    tauri::WebviewWindowBuilder::new(&app, "captcha", tauri::WebviewUrl::External(url))
        .title("Human Verification — Proton Drive")
        .inner_size(440.0, 560.0)
        .resizable(false)
        .devtools(true)
        .initialization_script(init_script)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Relays the solved captcha token from the captcha window to the main window.
#[tauri::command]
pub async fn relay_captcha_token(token: String, app: tauri::AppHandle) -> Result<(), String> {
    app.emit("captcha-token", token).map_err(|e| e.to_string())
}

/// Closes the captcha window if it is open.
#[tauri::command]
pub fn close_captcha_window(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("captcha") {
        let _ = w.close();
    }
}

/// Relays debug messages from the captcha window init script to the main window console.
#[tauri::command]
pub async fn captcha_debug(msg: String, app: tauri::AppHandle) -> Result<(), String> {
    app.emit("captcha-debug", msg).map_err(|e| e.to_string())
}
