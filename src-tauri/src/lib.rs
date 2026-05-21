mod auth;
mod commands;
mod db;
mod keyring;
mod watcher;

use commands::{
    AppState, close_captcha_window, delete_local_file, disable_autostart, enable_autostart,
    get_all_file_states, get_auth_status, get_autostart_enabled, get_db_sync_config,
    get_file_state_by_local_path, get_file_state_by_remote_id, get_session_tokens, list_local_dir,
    logout, open_captcha_window, read_local_file, rename_local_file, restore_session_from_keyring,
    set_db_sync_config, set_file_sync_state, show_notification, stat_local_file, store_tokens,
    trash_local_file, upsert_file_state, write_local_file,
};
use db::Db;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

#[tauri::command]
fn get_sync_path() -> String {
    std::env::var("HOME")
        .map(|h| format!("{}/ProtonDrive", h))
        .unwrap_or_else(|_| "~/ProtonDrive".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .manage(AppState::new())
        // pd-captcha:// is a custom scheme used to relay the solved captcha token from the
        // captcha WebView back to the main app without using Tauri IPC (which is blocked by
        // verify.proton.me's connect-src CSP). Registering the scheme tells WebKit2GTK it is
        // a known scheme so navigation to it works and on_navigation fires reliably.
        .register_uri_scheme_protocol("pd-captcha", |app, request| {
            let token = request
                .uri()
                .query()
                .and_then(|q| {
                    url::form_urlencoded::parse(q.as_bytes())
                        .find(|(k, _)| k == "token")
                        .map(|(_, v)| v.into_owned())
                })
                .unwrap_or_default();

            if !token.is_empty() {
                let handle = app.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = handle.emit("captcha-token", token);
                    if let Some(w) = handle.get_webview_window("captcha") {
                        let _ = w.close();
                    }
                });
            }

            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", "text/plain")
                .body(vec![])
                .unwrap()
        })
        .setup(|app| {
            // Open SQLite DB and register it as managed state.
            let data_dir = app.path().app_data_dir()?;
            let db = Db::open(&data_dir).map_err(|e| tauri::Error::Anyhow(e.into()))?;
            app.manage(db);

            setup_tray(app)?;
            setup_window_close_handler(app);
            start_file_watcher(app);
            handle_minimized_flag(app);

            // Restore session from keyring in background
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let s = handle.state::<AppState>();
                restore_session_from_keyring(&s).await;
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_sync_path,
            store_tokens,
            logout,
            get_auth_status,
            get_session_tokens,
            open_captcha_window,
            close_captcha_window,
            get_all_file_states,
            upsert_file_state,
            set_file_sync_state,
            get_file_state_by_remote_id,
            get_db_sync_config,
            set_db_sync_config,
            list_local_dir,
            read_local_file,
            write_local_file,
            delete_local_file,
            trash_local_file,
            stat_local_file,
            rename_local_file,
            get_file_state_by_local_path,
            show_notification,
            get_autostart_enabled,
            enable_autostart,
            disable_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Åpne", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Avslutt", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("Proton Drive Sync")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn setup_window_close_handler(app: &tauri::App) {
    let window = app.get_webview_window("main").unwrap();
    let win = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = win.hide();
        }
    });
}

fn start_file_watcher(app: &tauri::App) {
    let sync_path = std::env::var("HOME")
        .map(|h| std::path::PathBuf::from(h).join("ProtonDrive"))
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/ProtonDrive"));

    watcher::start_watcher(app.handle().clone(), sync_path);
}

fn handle_minimized_flag(app: &tauri::App) {
    let args: Vec<String> = std::env::args().collect();
    if args.contains(&"--minimized".to_string()) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }
}
