use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub fn start_watcher(app: AppHandle, watch_path: PathBuf) {
    std::thread::spawn(move || {
        if !watch_path.exists() {
            eprintln!(
                "[watcher] {:?} finnes ikke — opprett mappen for å aktivere inotify",
                watch_path
            );
            return;
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

        // Debounce: samle events i 300 ms-vinduer før vi emitter
        let debounce = Duration::from_millis(300);
        let mut pending: HashSet<PathBuf> = HashSet::new();
        let mut deadline: Option<Instant> = None;

        loop {
            let timeout = deadline
                .map(|d| d.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_secs(60));

            match rx.recv_timeout(timeout) {
                Ok(Ok(event)) => {
                    for path in event.paths {
                        pending.insert(path);
                    }
                    deadline = Some(Instant::now() + debounce);
                }
                Ok(Err(e)) => eprintln!("[watcher] Feil: {e}"),
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if deadline.map(|d| Instant::now() >= d).unwrap_or(false) {
                        for path in pending.drain() {
                            let _ = app.emit(
                                "sync://local-change",
                                path.to_string_lossy().to_string(),
                            );
                        }
                        deadline = None;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}
