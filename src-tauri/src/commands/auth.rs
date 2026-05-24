use tauri::{Emitter, Manager, State};
use super::{AppState, CommandError, SessionTokens, AuthStatus};
use crate::{auth::ProtonAuth, keyring};

/// Called by JS after a successful SRP login to persist the session in GNOME Keyring.
#[tauri::command]
pub async fn store_tokens(
    uid: String,
    access_token: String,
    refresh_token: String,
    user_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    use crate::auth::AuthSession;
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
pub async fn logout(state: State<'_, AppState>) -> Result<(), CommandError> {
    let session = state.session.lock().unwrap().clone();

    if let Some(ref s) = session {
        let base_url = std::env::var("PROTON_API_BASE")
            .unwrap_or_else(|_| "https://mail.proton.me/api".to_string());
        let app_version = std::env::var("PROTON_APP_VERSION")
            .unwrap_or_else(|_| "external-drive-protondrive-linux@0.1.0-alpha".to_string());

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
pub async fn store_key_password(key_password: String) -> Result<(), CommandError> {
    keyring::store_key_password(&key_password)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
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
) -> Result<(), CommandError> {
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
