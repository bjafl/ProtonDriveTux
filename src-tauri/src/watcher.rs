use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub abs_path: String,
    pub kind: String, // "create" | "modify" | "delete"
}

pub fn start_watcher(app: AppHandle, watch_path: PathBuf) {
    std::thread::spawn(move || {
        if !watch_path.exists() {
            if let Err(e) = std::fs::create_dir_all(&watch_path) {
                eprintln!("[watcher] Klarte ikke opprette {:?}: {e}", watch_path);
                return;
            }
            eprintln!("[watcher] Opprettet sync-mappe: {:?}", watch_path);
        }

        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

        let mut watcher = match RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default(),
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[watcher] Klarte ikke opprette watcher: {e}");
                return;
            }
        };

        if let Err(e) = watcher.watch(&watch_path, RecursiveMode::Recursive) {
            eprintln!("[watcher] Klarte ikke watche {:?}: {e}", watch_path);
            return;
        }

        eprintln!("[watcher] Lytter på {:?}", watch_path);

        // Debounce: samle events i 300 ms-vinduer før vi emitter.
        // Value is the last-seen kind for the path.
        let debounce = Duration::from_millis(300);
        let mut pending: HashMap<PathBuf, String> = HashMap::new();
        let mut deadline: Option<Instant> = None;

        loop {
            let timeout = deadline
                .map(|d| d.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_secs(60));

            match rx.recv_timeout(timeout) {
                Ok(Ok(event)) => {
                    let kind = match &event.kind {
                        notify::EventKind::Create(_) => "create",
                        notify::EventKind::Modify(_) => "modify",
                        notify::EventKind::Remove(_) => "delete",
                        _ => continue, // skip Access, Other, etc.
                    };
                    for path in event.paths {
                        pending.insert(path, kind.to_string());
                    }
                    deadline = Some(Instant::now() + debounce);
                }
                Ok(Err(e)) => eprintln!("[watcher] Feil: {e}"),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if deadline.map(|d| Instant::now() >= d).unwrap_or(false) {
                        for (path, kind) in pending.drain() {
                            let event = WatchEvent {
                                abs_path: path.to_string_lossy().to_string(),
                                kind,
                            };
                            let _ = app.emit("sync://local-change", event);
                        }
                        deadline = None;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}
