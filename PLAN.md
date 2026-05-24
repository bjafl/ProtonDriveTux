# PLAN — Proton Drive Linux Sync Client

*Updated: 2026-05-23*

---

## Status

| Phase | Goal | Status |
|-------|------|--------|
| 0 | Tauri shell: tray, inotify, config | ✅ Done |
| 1 | SRP login + GNOME Keyring | ✅ Done |
| 2 | JS SDK integrated, file transfer | ✅ Done (except 2.6) |
| 3 | Bidirectional sync engine | ✅ Done — all known gaps fixed |
| 4 | UI polish, notifications, autostart, AppImage | 🔄 Partial — AppImage build pending |

What exists: login, unlock, onboarding (with root-mode selector), folder selection,
conflict wizard, bidirectional sync with inotify + Drive events, token refresh,
file revisions, rename handling, write-stability check, permanent deletes propagated
to Drive, watcher handoff on root change, sync pause/resume, large file streaming,
Nextcloud-style tray menu with sync state + recently synced files, SQLite state,
desktop notifications, autostart.

---

## Bugs / Gaps — must fix for correct sync

### G1. `initialSyncLocalFolder` only scans top-level files ✅ Fixed

**Where:** `src/lib/sync.ts` → `initialSyncLocalFolder`  
**Fix applied:** For entries with `selectedRoot.mode === "recursive"`, now calls
`list_dir_recursive` (returns `LocalFileEntry[]` with `abs_path`) instead of flat
`list_local_dir`. Files mode still uses flat listing.

---

### G2. Large file memory: full base64 round-trip ✅ Fixed

**Where:** `src/lib/sync.ts` → `handleLocalUpsert` / `handleRemoteNodeUpdate`  
**Fix applied:**
- **Upload:** Registered `pd-file://` custom URI scheme in `lib.rs`. The Rust handler
  serves raw file bytes on demand; `handleLocalUpsert` now does
  `fetch("pd-file:///abs/path") → blob() → File` — no base64, no IPC copy.
- **Download:** Added `truncate_local_file` (creates/clears the file) and
  `write_local_file_chunk` (append mode) Rust commands. `handleRemoteNodeUpdate` now
  writes each SDK chunk to disk as it arrives via a `WritableStream` sink instead of
  accumulating all chunks before encoding.

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

**3.1 Sync pause / resume** ✅ Fixed  
`_paused` flag in `sync.ts` guards both `handleLocalChange` and `handleDriveEvent`.
`pauseSync()` / `resumeSync()` / `isSyncPaused()` exported. Resume triggers a full
reconciliation to catch changes made while paused. Tray menu has a dynamic Pause/Resume
item (Rust emits `sync://pause-toggle`); MainView status card has a matching button.

---

### Phase 4 — remaining

**4.1 MainView: show selected Drive folders, not "My Files"** ✅ Fixed  
`src/App.tsx` now reads `selected_folders` from DB on init and displays the folder
names joined by ", " in the sync-path row.

**4.2 Watcher handoff when sync root changes** ✅ Fixed  
`Onboarding.tsx` `handleFolderSelectNext` now calls `clear_all_file_states` before
saving the new root, ensuring the `files` DB table is clean so the new sync session
starts without false conflicts. `Db::clear_all()` added to `db.rs`.

**4.5 Captcha dialog UI review**  
The captcha window works but had minor layout/UX issues at the time it was implemented.
Review the dialog appearance and flow (`open_captcha_window` in `commands.rs`, captcha step in
`LoginForm.tsx`) — fix any rough edges before considering the login flow complete.

**4.3 AppImage build verification**  
Run `cargo tauri build` end-to-end on a clean Ubuntu 22.04 machine or container.
Document the exact `apt` packages needed: `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `libssl-dev`. Produce a working `.AppImage`.

**4.4 Desktop notification on sync error** ✅ Fixed  
`recordError` in `sync.ts` now calls `show_notification` on each error, throttled
to max 1 notification per 30 s.

---

## Research notes — Nextcloud desktop client

*From analysis of `../desktop` (Nextcloud's official C++/Qt client), 2026-05-23.*

### Tray
- Rich tray info lives in a **frameless popup window** (QML `ApplicationWindow` with
  `Qt.FramelessWindowHint`) that pops up relative to the tray icon — not a native menu.
- The native context menu is minimal (pause/resume, settings, exit); all status/activity is
  in the popup.
- Popup auto-hides on focus loss. Activity feed is **lazy-loaded** (fetched only when popup
  opens, not kept in sync continuously).
- Geometry is computed carefully to handle tray icon at screen bottom/top/side.
- On Linux, Qt's `QSystemTrayIcon` handles SNI automatically — no AppIndicator directly.

**Applicable to us:** Our current implementation is context-menu-only. A popup window
(React webview or separate Tauri window) positioned relative to the tray icon would give
richer status info. See item 4.6 below.

### Virtual file system (VFS / on-demand sync)
- **Nextcloud does not use FUSE on Linux.** Placeholders are real 1-byte files on disk.
- Metadata (size, mtime, etag) stored in Linux extended attributes (`user.nextcloud.*`)
  and mirrored in SQLite.
- **On Linux, hydration is not kernel-driven** — the sync engine detects `AlwaysLocal`
  pin state and downloads on the next sync cycle. There is no transparent on-demand trigger.
- **Windows gets real on-demand** via the Cloud Filter API (CfApi): the kernel notifies
  the client when a file is opened, triggering a `HydrationJob`.
- Architecture is a **plugin/strategy pattern**: abstract `Vfs` base class with per-platform
  implementations (`VfsXAttr`, `VfsCfApi`, `VfsSuffix`). Maps cleanly to Rust traits.

**Applicable to us (if we ever add VFS):**
- Realistic Linux path: xattr-based placeholders + per-file pin states + SQLite metadata.
  Download triggered on next sync cycle, not on file open.
- True on-demand (file open → download) would require FUSE (`libfuse` + a FUSE filesystem
  that intercepts `open()` and blocks until download completes). High complexity.
- Start with xattr/suffix placeholders; defer FUSE to a potential v2.

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
