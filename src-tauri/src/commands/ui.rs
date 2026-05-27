use tauri::{menu::{Menu, MenuItem, PredefinedMenuItem}, Emitter, Manager, State};
use super::{AppState, CommandError};

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub name: String,
    pub direction: String, // "up" | "down"
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayStatusPayload {
    pub paused: bool,
    pub syncing: bool,
    pub active_count: usize,
    pub recent_files: Vec<RecentFile>,
    pub error_count: usize,
    pub queued_down: usize,
    pub queued_up: usize,
}

/// Shows a desktop notification. Silently no-ops if the notification daemon is unavailable.
#[tauri::command]
pub fn show_notification(title: String, body: String) {
    let _ = notify_rust::Notification::new()
        .summary(&title)
        .body(&body)
        .appname("Proton Drive Sync")
        .show();
}

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

#[tauri::command]
pub fn update_tray_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    payload: TrayStatusPayload,
) -> Result<(), CommandError> {
    // Persist for the popup window to query on open, and broadcast to all webviews.
    *state.last_tray_status.lock().unwrap() = Some(payload.clone());
    let _ = app.emit("tray://status", &payload);

    let tray = match app.tray_by_id("main") {
        Some(t) => t,
        None => return Ok(()),
    };

    // Build status line text.
    let status_text = if payload.paused {
        "⏸  Sync paused".to_string()
    } else if payload.syncing {
        format!("↕  Syncing {} item(s)…", payload.active_count)
    } else if payload.error_count > 0 {
        format!("⚠  {} error(s)", payload.error_count)
    } else {
        "✓  Synced".to_string()
    };

    // Tooltip (plain text, no Unicode that causes pango errors on some setups).
    let tooltip = if payload.paused {
        "Proton Drive Sync — paused".to_string()
    } else if payload.syncing {
        format!("Proton Drive Sync — syncing {}", payload.active_count)
    } else if payload.error_count > 0 {
        format!("Proton Drive Sync — {} errors", payload.error_count)
    } else {
        "Proton Drive Sync — synced".to_string()
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
        let heading = MenuItem::with_id(&app, "recent-hd", "Recently synced:", false, None::<&str>)
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
    let pause_label = if payload.paused { "▶  Resume sync" } else { "⏸  Pause sync" };
    let pause_id = if payload.paused { "resume" } else { "pause" };
    let pause_item = MenuItem::with_id(&app, pause_id, pause_label, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let show = MenuItem::with_id(&app, "show", "Open", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", "Quit", true, None::<&str>)
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

