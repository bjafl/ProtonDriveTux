# PLAN — Proton Drive Linux Sync Client

*Updated: 2026-05-22*

---

## Status

| Phase | Goal | Status |
|-------|------|--------|
| 0 | Tauri shell: tray, inotify, config | ✅ Done |
| 1 | SRP login + GNOME Keyring | ✅ Done |
| 2 | JS SDK integrated, file transfer | ✅ Done (except 2.6) |
| 3 | Bidirectional sync engine | 🔄 In progress — core works, gaps below |
| 4 | UI polish, notifications, autostart, AppImage | 🔄 Partial |

What exists: login, unlock, onboarding, folder selection, conflict wizard,
bidirectional sync with inotify + Drive events, token refresh, file revisions,
rename handling, write-stability check, trash-based deletes, SQLite state.

---

## Bugs / Gaps — must fix for correct sync

### G1. `initialSyncLocalFolder` only scans top-level files

**Where:** `src/lib/sync.ts` → `initialSyncLocalFolder`  
**Problem:** Calls `list_local_dir` (flat) for every watched folder entry.
For `recursive` folders this means subdirectory files are not uploaded on startup.
The inotify watcher covers them once the app is running, but a cold start misses
everything in subdirectories.  
**Fix:** For each entry where `selectedRoot.mode === "recursive"`, call
`list_dir_recursive` instead of `list_local_dir`. The returned `LocalFileEntry[]`
already has `rel_path` and `abs_path` — use `abs_path` as the argument to
`handleLocalUpsert`.

---

### G2. Large file memory: full base64 round-trip

**Where:** `src/lib/sync.ts` → `handleLocalUpsert` (lines ~337–349),
`src-tauri/src/commands.rs` → `read_local_file` / `write_local_file`  
**Problem:** `read_local_file` reads the whole file into RAM as bytes, base64-encodes
it, returns a string across IPC; JS decodes with `atob()` into a second buffer.
A 500 MB file doubles its footprint twice. SDK uploaders support `File` objects
which the browser can stream from a URL/blob.  
**Fix (MVP):** Add a `read_local_file_chunked(abs_path, offset, len)` command and
stream chunks into a `ReadableStream` fed to the SDK uploader, or use
`tauri://localhost/...` asset protocol to serve local files directly as a URL.  
**Fix (stretch):** Register a custom Tauri protocol handler `pd-file://` that
streams file bytes on demand — the SDK uploader receives a URL and streams without
buffering.

---

### G3. Watcher has no stop channel

**Where:** `src-tauri/src/watcher.rs`, `src-tauri/src/commands.rs` → `start_file_watcher`  
**Problem:** `start_file_watcher` spawns a thread with a `RecommendedWatcher` and
returns. There is no way to stop it. Calling `start_file_watcher` a second time
(e.g. after the user changes the sync root in settings) starts a second watcher;
both run indefinitely, emitting duplicate events.  
**Fix:** Pass an `Arc<AtomicBool>` stop flag into the watcher thread. Expose a
`stop_file_watcher` Tauri command that sets the flag. Store the current stop flag
in `AppState` so re-triggering first stops the old watcher.

---

### G4. Deleting a local file does not delete it from Drive

**Where:** `src/lib/sync.ts` → `handleLocalChange`  
**Problem:** When `kind === "delete"` we log "skipping local delete (MVP safety)"
and return. The file stays in Drive forever.  
**Fix:** Look up the `remote_id` from the DB by `local_path`. Call the SDK delete
API (check `drive.ts` — likely need a `deleteNode(uid)` export). On success, remove
the DB row. Keep the "MVP safety" guard as a config flag initially; default it off
so deletes are synced.

---

## Remaining feature work

### Phase 3 — remaining

**3.1 Sync pause / resume**  
Add a stop-sync path: unsubscribe from Drive events, stop the local watcher,
set a `paused` flag so inotify events are dropped. Resume: restart watcher + resubscribe.
Expose `pause_sync` / `resume_sync` Tauri commands. Show pause/resume button in MainView.

---

### Phase 4 — remaining

**4.1 MainView: show selected Drive folders, not "My Files"**  
`src/App.tsx` / `src/components/MainView` currently shows a hardcoded "Drive-mappe"
label. Replace with the list of selected folder names from `selectedFolders` state
(read from DB via `get_db_sync_config("selected_folders")`).

**4.2 Watcher handoff when sync root changes**  
"Change sync settings" re-runs onboarding. When the user saves a new local root,
stop the watcher on the old path (see G3), start it on the new path, and clear
the `files` DB table so initial sync re-discovers everything.

**4.3 AppImage build verification**  
Run `cargo tauri build` end-to-end on a clean Ubuntu 22.04 machine or container.
Document the exact `apt` packages needed: `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `libssl-dev`. Produce a working `.AppImage`.

**4.4 Desktop notification on sync error**  
`show_notification` command exists. Wire it: when `sync_state = error` is set for
a file, emit a notification with the file name and error. Rate-limit: max 1
notification per 30 s to avoid spam.

---

## Deferred (conscious decisions, not forgotten)

| Item | Reason deferred | Revisit |
|------|----------------|---------|
| Concurrent uploads | Sequential is safe; ordering bugs are worse than slow | After basic sync is stable |
| Retry / backoff | SDK retries transient errors internally; outer wrapper is marginal | After G1–G4 fixed |
| Runtime conflict wizard | Last-write-wins is documented v1 policy | Phase 3 follow-up |
| File picker "Browse" button | Requires `tauri-plugin-dialog`; text input works | Phase 4 |
| GNOME tray without extension | `gnome-shell-extension-appindicator` standard on Ubuntu 22.04+ | Known limitation |
| Address key COMPROMISED flag | Low risk for personal single-user use | Before any multi-user use |
| Token TTL persistence across restores | First 401 triggers refresh anyway (G1 fixed) | After token refresh is battle-tested |
| Drive tree rename staleness | `drivePath` rebuilt on each startup during `buildWatchedFolderMap` | Already partially mitigated |
| SDK breaking change (new crypto model, ETA late 2026) | All SDK calls isolated behind `src/lib/drive.ts` | When Proton publishes new SDK |

---

## Architecture notes

- All SDK calls go through `src/lib/drive.ts` — the isolation boundary for the coming SDK crypto change.
- All Tauri commands are in `src-tauri/src/commands.rs`. Register new ones in `lib.rs` `invoke_handler![]`.
- Pure business logic (selection state machine, conflict helpers, path matching, translations) lives in
  `src/lib/{folderTreeHelpers,conflictHelpers,syncHelpers,translations}.ts` — no Tauri/SDK imports,
  fully unit-tested.
- SQLite schema: `files` table (remote state) + `sync_config` table (key/value settings).
- Security invariants: never store passwords, only session tokens; always send `x-pm-appversion` header;
  no direct Proton API calls outside the SDK.
