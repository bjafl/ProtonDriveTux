mod auth;
mod commands;
mod keyring;
mod watcher;

use commands::{
    AppState, captcha_debug, close_captcha_window, get_auth_status, get_session_tokens, logout,
    open_captcha_window, relay_captcha_token, restore_session_from_keyring, store_tokens,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
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
        .setup(|app| {
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
            relay_captcha_token,
            close_captcha_window,
            captcha_debug,
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
