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

### G1. `initialSyncLocalFolder` only scans top-level files ✅ Fixed

**Where:** `src/lib/sync.ts` → `initialSyncLocalFolder`  
**Fix applied:** For entries with `selectedRoot.mode === "recursive"`, now calls
`list_dir_recursive` (returns `LocalFileEntry[]` with `abs_path`) instead of flat
`list_local_dir`. Files mode still uses flat listing.

---

### G2. Large file memory: full base64 round-trip

**Where:** `src/lib/sync.ts` → `handleLocalUpsert`,
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

### G3. Watcher has no stop channel ✅ Fixed

**Where:** `src-tauri/src/watcher.rs`, `src-tauri/src/commands.rs`  
**Fix applied:** `start_watcher` now returns `Arc<AtomicBool>`. `AppState` stores
the current stop flag. `start_file_watcher` stops the old watcher before starting
a new one. New `stop_file_watcher` command exposed.

---

### G4. Deleting a local file does not delete it from Drive ✅ Fixed

**Where:** `src/lib/sync.ts` → `handleLocalChange` / `handleLocalDelete`  
**Fix applied:** `handleLocalDelete` looks up `remote_id` by `local_path` from DB,
calls `trashNode(remoteId)` (SDK `trashNodes` wrapper in `drive.ts`), then removes
the DB row via new `delete_file_state` Rust command.

---

## Remaining feature work

### Phase 3 — remaining

**3.1 Sync pause / resume**  
Add a stop-sync path: unsubscribe from Drive events, stop the local watcher,
set a `paused` flag so inotify events are dropped. Resume: restart watcher + resubscribe.
Expose `pause_sync` / `resume_sync` Tauri commands. Show pause/resume button in MainView.

---

### Phase 4 — remaining

**4.1 MainView: show selected Drive folders, not "My Files"** ✅ Fixed  
`src/App.tsx` now reads `selected_folders` from DB on init and displays the folder
names joined by ", " in the sync-path row.

**4.2 Watcher handoff when sync root changes**  
"Change sync settings" re-runs onboarding. When the user saves a new local root,
stop the watcher on the old path (see G3), start it on the new path, and clear
the `files` DB table so initial sync re-discovers everything.

**4.3 AppImage build verification**  
Run `cargo tauri build` end-to-end on a clean Ubuntu 22.04 machine or container.
Document the exact `apt` packages needed: `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `libssl-dev`. Produce a working `.AppImage`.

**4.4 Desktop notification on sync error** ✅ Fixed  
`recordError` in `sync.ts` now calls `show_notification` on each error, throttled
to max 1 notification per 30 s.

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
