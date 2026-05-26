# PLAN — Proton Drive Linux Sync Client

> Updated: 2026-05-23

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

(all fixed)

---

## Remaining feature work

### Phase 3 — remaining

(done)

---

### Phase 4 — remaining

**4.5 Captcha dialog UI review**  
The captcha window works but had minor layout/UX issues at the time it was implemented.
Review the dialog appearance and flow (`open_captcha_window` in `commands.rs`, captcha step in
`LoginForm.tsx`) — fix any rough edges before considering the login flow complete.

**4.3 AppImage build verification**  
Run `cargo tauri build` end-to-end on a clean Ubuntu 22.04 machine or container.
Document the exact `apt` packages needed: `libwebkit2gtk-4.1-dev`,
`libayatana-appindicator3-dev`, `libssl-dev`. Produce a working `.AppImage`.

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
| --- | --- | --- |
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
