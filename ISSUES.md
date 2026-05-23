# Issues — Proton Drive Linux Sync

*Generated: 2026-05-23. From full codebase review across TypeScript/React frontend and Rust backend.*

---

## HIGH — Correctness Risk / Potential Data Loss

### [TS-H1] `suppressUntil` map grows unboundedly
**File:** `src/lib/sync.ts:73`

`suppressUntil` entries are only cleaned up when that exact path is checked again. Deleted or renamed files leave stale entries that are never evicted. Same problem with `recentlyUploaded` (line 74) — the `setTimeout` cleanup only runs on the happy path; if upload throws before that line, the entry leaks.

**Fix:** Clear both maps at the top of `startSync`. Add a periodic sweep (inside the existing 5-minute interval) to flush expired entries.

---

### [TS-H2] File truncated to 0 bytes before download completes
**File:** `src/lib/sync.ts:741–754`

`suppressPath(expectedPath)` and `invoke("truncate_local_file")` are called before `downloadToStream`. If the download fails midway, the local file is 0 bytes, the path is suppressed for 5 seconds, and the DB still holds the old etag/size. The user has a zero-byte file until the next full sync.

**Fix:** Write to a temp path and rename atomically on completion, or at minimum mark `syncState = "pending_download"` in the DB before truncating.

---

### [TS-H3] Revision uploads don't suppress re-download
**File:** `src/lib/sync.ts:578–589 vs 594–597`

The new-upload branch adds `nodeUid` to `recentlyUploaded` with a `setTimeout` cleanup. The revision-upload branch does not. The resulting `NodeUpdated` Drive event passes through `handleDriveEvent` and triggers a redundant re-download of the file just uploaded.

**Fix:** Add `recentlyUploaded.add(nodeUid)` with `setTimeout` cleanup inside the revision branch, mirroring the new-upload branch.

---

### [TS-H4] `handleLocalUpsert` skips re-upload when only size matches
**File:** `src/lib/sync.ts:549–551`

The skip condition checks `sizeBytes` only. A file edited in-place to the same byte count (same-size text replacement) is never re-uploaded. `modifiedAt` is stored in the DB but not consulted here.

**Fix:** Change condition to also require `stat.mtimeMs === existing.modifiedAt` before skipping.

---

### [TS-H5] `APP_VERSION` missing `-linux` suffix in `drive.ts` and `auth.ts`
**Files:** `src/lib/drive.ts:30`, `src/lib/auth.ts:13`

`httpClient.ts` correctly uses `external-drive-protondrive-linux@0.1.0-alpha`. `drive.ts` and `auth.ts` fallbacks omit `-linux`. All direct `fetch` calls from these modules send a malformed `x-pm-appversion` header.

**Fix:** Change both fallbacks to `"external-drive-protondrive-linux@0.1.0-alpha"`. Extract to a shared `src/lib/config.ts` (see TS-M1).

---

### [TS-H6] Event anchor not persisted for `TreeRefresh`/`FastForward` events
**File:** `src/lib/sync.ts:654–666`

`persistEventAnchor` is only called if the event has both `treeEventScopeId` and `eventId`. If `TreeRefresh`/`FastForward` events don't carry `eventId`, the anchor is not persisted and events since the refresh will be replayed on restart.

**Fix:** Audit the SDK's `DriveEvent` type to confirm whether these event types carry `eventId`. If not, persist a sentinel or the latest known anchor explicitly.

---

### [Rust-H1] `pd-file://` URI handler has no path-traversal guard
**File:** `src-tauri/src/lib.rs:43–46`

`request.uri().path()` is passed directly to `std::fs::read`. A URL like `pd-file:///../../../etc/passwd` serves arbitrary local files to the WebView without restriction.

**Fix:** Verify that the canonicalized path starts with the configured sync root before reading. Add a `// SAFETY:` comment explaining the trust model.

---

### [Rust-H2] `.unwrap()` on `get_webview_window("main")` at startup
**File:** `src-tauri/src/lib.rs:248`

`app.get_webview_window("main").unwrap()` panics if the window label is ever changed. Every other window access in the same file uses `if let Some(...)`.

**Fix:** Use `if let Some(window) = app.get_webview_window("main")` or `.expect("main window must exist — check tauri.conf.json")`.

---

## MEDIUM — Maintainability / Structure

### [TS-M1] `BASE_URL` and `APP_VERSION` duplicated across 4 files
**Files:** `drive.ts:28–30`, `auth.ts:11–14`, `accountProvider.ts:9–10`, `httpClient.ts:8`

Copy-pasted constants across all HTTP-calling modules. Direct cause of TS-H5.

**Fix:** Extract to `src/lib/config.ts`, import everywhere else.

---

### [TS-M2] `FileState`, `WatchEvent`, `SelectedFolderRecord` defined in two places
**Files:** `sync.ts:39–56`, `App.tsx:27–45`, `App.tsx:172–177`

Identical type definitions in both `sync.ts` and `App.tsx`. Any field addition requires changing two files and risks drift.

**Fix:** Export from `sync.ts`/`syncHelpers.ts`, remove local redefinitions in `App.tsx`.

---

### [TS-M3] `MainView` polls all file states every 3 seconds unconditionally
**File:** `src/App.tsx:284–290`

Full DB read over IPC 20 times per minute regardless of whether anything has changed. The sync engine already calls `upsert_file_state`/`delete_file_state` after each operation.

**Fix:** Trigger file-state refresh inside `setSyncStatusCallback`, or have Rust emit a `db://files-changed` event after writes.

---

### [TS-M4] Module-level mutable state in `sync.ts` prevents testing and breaks React Strict Mode
**File:** `src/lib/sync.ts:73–94`

All engine state is module-level. React 18 Strict Mode double-invokes `useEffect`; the first cleanup runs before the second `startSync` completes, leaving stale shared state. `suppressUntil` and `recentlyUploaded` are not reset between runs.

**Fix:** Encapsulate state in a factory function or class. At minimum, clear `suppressUntil` and `recentlyUploaded` at the top of `startSync`.

---

### [TS-M5] `waitForFileStable` only does 2 comparisons
**File:** `src/lib/sync.ts:199–208`

Two 1-second waits, then returns unconditionally. A file being written at ~1 byte/second rate passes the check with an incomplete state.

**Fix:** Add a third read and only return if the last two reads agree.

---

### [TS-M6] `TrayPopup` unlisten cleanup pattern is incorrect
**File:** `src/components/TrayPopup.tsx:37–40`

The `useEffect` cleanup uses `.then(f => f())` on unresolved promises. If the component unmounts before the promises settle, cleanup is a no-op and subscriptions leak. `LoginForm.tsx` correctly uses `useRef` for this pattern.

**Fix:** Use `useRef<(() => void) | null>` for both unlisten functions, set on promise resolve, call unconditionally in cleanup.

---

### [TS-M7] `cachedAddresses` in `accountProvider.ts` never invalidated
**File:** `src/lib/accountProvider.ts:123–140`

Populated once, never cleared. Rotated address keys or new addresses added during a session are never picked up.

**Fix:** Clear cache in `releaseDriveClient()`, or add a TTL (e.g. 1 hour).

---

### [Rust-M1] Tray icon PNGs decoded on every `update_tray_status` call
**File:** `src-tauri/src/commands.rs:800–810`

`Image::from_bytes` runs PNG decoding on every status update, which can be frequent during sync. The 4 icon variants are statically known.

**Fix:** Decode icons once at startup and cache in `AppState`. Use `MenuItem::set_text()` for in-place label updates instead of rebuilding the full menu.

---

### [Rust-M2] All Tauri commands return `Result<_, String>`
**File:** `src-tauri/src/commands.rs` (pervasive)

Error type is erased to `String` via `.map_err(|e| e.to_string())`. `auth.rs` and `keyring.rs` already use `thiserror`. Frontend receives unstructured strings with no ability to branch on error type.

**Fix:** Add `CommandError` enum with `#[derive(thiserror::Error, Serialize)]` wrapping `rusqlite::Error`, `std::io::Error`, etc.

---

### [Rust-M3] SQLite row-mapping closure duplicated 4 times in `db.rs`
**File:** `src-tauri/src/db.rs:103–160`

The `FileState` row-mapping closure is copy-pasted in `get_by_remote_id`, `get_by_local_path`, `all_files`, and elsewhere.

**Fix:** Extract `fn row_to_file_state(row: &Row) -> rusqlite::Result<FileState>` as a private helper.

---

### [Rust-M4] Watcher stop-flag checked only at loop top — up to 500 ms stop latency
**File:** `src-tauri/src/watcher.rs:63–66`

Stop flag is checked once per loop iteration before `recv_timeout(500ms)`. New watcher may start while old one still holds inotify watch on the same path.

**Fix:** Also check stop flag inside the `Err(Timeout)` arm, or reduce poll interval.

---

## LOW — Polish / Style

### [TS-L1] TOTP submit button shows same text in both states
**File:** `src/components/LoginForm.tsx:272`

`{loading ? t.confirmBtn : t.confirmBtn}` is a no-op ternary. No loading feedback during TOTP submit.

---

### [TS-L2] Hardcoded Norwegian label in `Onboarding.tsx`
**File:** `src/components/Onboarding.tsx:133`

`<label>Mappe</label>` bypasses `useLang()`. Always shows Norwegian regardless of selected language.

---

### [TS-L3] `TrayPopup` not wrapped in `LangProvider`
**File:** `src/main.tsx:13–21`

`TrayPopup` is inside `ThemeProvider` but not `LangProvider`. Not currently a bug (popup has hardcoded English), but `useLang()` would fail silently if translations are added.

---

### [TS-L4] Hardcoded Norwegian error title in `sync.ts`
**File:** `src/lib/sync.ts:169`

`title: "Proton Drive Sync — feil"` in a module with no i18n dependency. Pass from caller or make configurable.

---

### [TS-L5] `mediaType: "application/octet-stream"` for all uploads
**File:** `src/lib/sync.ts:569`

All files uploaded with the same MIME type. Proton Drive web client cannot preview files. Use actual MIME type based on file extension.

---

### [Rust-L1] Unreachable `saturating_add` in `count_files_capped`
**File:** `src-tauri/src/commands.rs:550–568`

`count` is always `< cap` due to the early-return guard. The `saturating_add` implies an overflow risk that cannot occur and misleads readers.

---

### [Rust-L2] `handle_minimized_flag` allocates Vec for args unnecessarily
**File:** `src-tauri/src/lib.rs:259–260`

`std::env::args().collect::<Vec<String>>()` allocates all args. Use `std::env::args().any(|a| a == "--minimized")` instead.

---

## Dead Code

### [Rust-Note] SRP implementation in `auth.rs` is unused
**File:** `src-tauri/src/auth.rs:277–295`

The Rust `hash_password` function has a broken bcrypt step (FIXME comment). However, this does not affect authentication — all SRP login is handled in TypeScript via `@protontech/crypto/srp`. `auth.rs` is only used for the HTTP DELETE call during logout. The unused SRP functions (`compute_srp_proof`, `hash_password`, `extract_modulus_bytes`, `pad_to`) should be removed.

---

*Total: 7 HIGH, 8 MEDIUM, 7 LOW, 1 note*
