mod auth;
mod commands;
mod db;
mod keyring;
mod watcher;

use commands::{
    AppState, clear_all_file_states, close_captcha_window, delete_file_state, delete_local_dir,
    delete_local_file, disable_autostart, emit_pause_toggle, enable_autostart, ensure_local_dir,
    get_all_file_states, get_auth_status, get_autostart_enabled, get_db_sync_config,
    get_file_state_by_local_path, get_file_state_by_remote_id, get_home_dir, get_key_password,
    get_local_root, get_session_tokens, get_tray_status, list_dir_recursive, list_local_dir,
    logout, open_captcha_window, read_local_file, rename_local_file, restore_session_from_keyring,
    set_db_sync_config, set_file_sync_state, set_local_root, show_main_window, show_notification,
    start_file_watcher, stat_local_file, stop_file_watcher, store_key_password, store_tokens,
    trash_local_file, truncate_local_file, update_tray_status, upsert_file_state,
    validate_local_root, write_local_file, write_local_file_chunk,
};
use db::Db;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .manage(AppState::new())
        // pd-file:// serves raw file bytes to the WebView without base64 encoding, used by
        // the upload path in sync.ts to avoid the O(n) IPC+base64 memory spike.
        // URI form: pd-file:///abs/path/to/file — path() gives /abs/path/to/file.
        .register_uri_scheme_protocol("pd-file", |app, request| {
            let path_str = request.uri().path().to_string();

            // Guard: reject paths that escape the configured sync root to prevent path traversal.
            let allowed = (|| -> Option<bool> {
                let db = app.app_handle().state::<Db>();
                let root = db.get_sync_config("local_root").ok().flatten()?;
                let canonical_root = std::fs::canonicalize(&root).ok()?;
                let canonical_path = std::fs::canonicalize(&path_str).ok()?;
                Some(canonical_path.starts_with(&canonical_root))
            })()
            .unwrap_or(false);

            if !allowed {
                return tauri::http::Response::builder()
                    .status(403)
                    .header("Content-Type", "text/plain")
                    .body(b"forbidden".to_vec())
                    .unwrap();
            }

            match std::fs::read(&path_str) {
                Ok(bytes) => tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Type", "application/octet-stream")
                    .header("Access-Control-Allow-Origin", "*")
                    .body(bytes)
                    .unwrap(),
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .header("Content-Type", "text/plain")
                    .body(b"not found".to_vec())
                    .unwrap(),
            }
        })
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
            list_dir_recursive,
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
            store_key_password,
            get_key_password,
            validate_local_root,
            set_local_root,
            get_local_root,
            get_home_dir,
            start_file_watcher,
            stop_file_watcher,
            delete_file_state,
            clear_all_file_states,
            delete_local_dir,
            ensure_local_dir,
            truncate_local_file,
            write_local_file_chunk,
            update_tray_status,
            get_tray_status,
            show_main_window,
            emit_pause_toggle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    // Initial menu: just show/quit; the frontend updates it via update_tray_status.
    let status = MenuItem::with_id(app, "status", "✓  Synced", false, None::<&str>)?;
    let sep = tauri::menu::PredefinedMenuItem::separator(app)?;
    let show = MenuItem::with_id(app, "show", "Open", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &sep, &show, &quit])?;

    let icon_bytes = include_bytes!("../icons/tray-idle.png");
    let icon = tauri::image::Image::from_bytes(icon_bytes)?;

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Proton Drive Sync")
        .on_tray_icon_event(|tray, event| {
            use tauri::tray::{MouseButton, MouseButtonState, TrayIconEvent};
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, position, .. } = event {
                toggle_tray_popup(tray.app_handle(), position);
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "pause" | "resume" => {
                let _ = app.emit("sync://pause-toggle", ());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn toggle_tray_popup(app: &tauri::AppHandle, click_pos: tauri::PhysicalPosition<f64>) {
    let Some(popup) = app.get_webview_window("tray-popup") else { return };
    if popup.is_visible().unwrap_or(false) {
        let _ = popup.hide();
    } else {
        position_and_show_popup(&popup, click_pos);
    }
}

fn position_and_show_popup(popup: &tauri::WebviewWindow, click_pos: tauri::PhysicalPosition<f64>) {
    const POPUP_W: f64 = 300.0;
    const POPUP_H: f64 = 420.0;
    const GAP: f64 = 6.0;

    let position = if let Ok(monitors) = popup.available_monitors() {
        // Find the monitor containing the click.
        let monitor = monitors.into_iter().find(|m| {
            let p = m.position();
            let s = m.size();
            click_pos.x >= p.x as f64
                && click_pos.x < p.x as f64 + s.width as f64
                && click_pos.y >= p.y as f64
                && click_pos.y < p.y as f64 + s.height as f64
        });
        if let Some(m) = monitor {
            let mx = m.position().x as f64;
            let my = m.position().y as f64;
            let mw = m.size().width as f64;
            let mh = m.size().height as f64;

            // Horizontal: centred on click, clamped to screen edges.
            let x = (click_pos.x - POPUP_W / 2.0).max(mx).min(mx + mw - POPUP_W);
            // Vertical: above icon if panel is at bottom, below if at top.
            let y = if click_pos.y > my + mh / 2.0 {
                click_pos.y - POPUP_H - GAP
            } else {
                click_pos.y + GAP
            };
            tauri::PhysicalPosition { x: x as i32, y: y as i32 }
        } else {
            tauri::PhysicalPosition { x: click_pos.x as i32, y: click_pos.y as i32 }
        }
    } else {
        tauri::PhysicalPosition { x: click_pos.x as i32, y: click_pos.y as i32 }
    };

    let _ = popup.set_position(position);
    let _ = popup.show();
    let _ = popup.set_focus();
}

fn setup_window_close_handler(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else { return };
    let win = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = win.hide();
        }
    });
}

fn handle_minimized_flag(app: &tauri::App) {
    if std::env::args().any(|a| a == "--minimized") {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    }
}
