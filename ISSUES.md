# Code Review — Proton Drive Linux Sync
*Date: 2026-05-24 — third-pass review*

All issues from the previous two reviews have been resolved and are not re-reported here.

---

## HIGH — Security / Data Integrity

### [Rust-H1] Four read/list IPC commands have no sync-root path guard
**Files:**
- `src-tauri/src/commands.rs` — `list_local_dir`, `read_local_file`, `stat_local_file`, `list_dir_recursive`

All write/delete/rename commands call `within_sync_root(abs_path, &db)` to prevent path traversal.
The four read-path commands accept any absolute path from JavaScript with no validation.
`read_local_file` base64-encodes and returns file contents; `list_dir_recursive` returns every
filename under an arbitrary directory tree.

Threat surface: CSP is `null` in `tauri.conf.json` (no browser-level script restriction), and the
Proton Drive JS SDK is a third-party git submodule. A supply-chain compromise could call
`read_local_file("/home/user/.ssh/id_rsa")` and return the private key to JS for exfiltration.
The `pd-file://` scheme handler already guards reads correctly — the IPC commands should match.

**Fix:** Add `db: State<'_, Db>` to each of the four command signatures and call
`within_sync_root(&abs_path, &db)?;` as the first statement. The `State` parameter is transparent
to TypeScript callers — no JS changes needed.

---

## MEDIUM — Logic / Data Integrity

### [TS-M1] Leftover `.pd-tmp` temp files from interrupted downloads are uploaded to Drive on startup
**Files:**
- `src-tauri/src/commands.rs` — `collect_recursive` (no `.pd-tmp` filter)
- `src/lib/sync.ts` — `initialSyncLocalFolder` (calls `handleLocalUpsert` for every collected file)

`streamDownloadToPath` writes to `absPath + ".pd-tmp"` before an atomic rename. If the app crashes
mid-download the temp file remains on disk. `collect_recursive` skips `.trash` directories but does
not filter `.pd-tmp` files, so they appear in `list_dir_recursive` results as ordinary files. On the
next startup `initialSyncLocalFolder` calls `handleLocalUpsert` for every path — the `.pd-tmp` file
is not in the DB, so it is treated as a new local file and uploaded to Drive as e.g.
`document.txt.pd-tmp`.

**Fix (Rust):** In `collect_recursive`, skip files with `.pd-tmp` extension:
```rust
} else if ft.is_file() {
    // Skip partial-download temp files from an interrupted sync.
    if path.extension().map_or(false, |e| e == "pd-tmp") {
        continue;
    }
    // ... existing push logic
}
```

---

### [TS-M2] `handleLocalChange` does not filter `.pd-tmp` paths — slow downloads cause spurious uploads
**File:** `src/lib/sync.ts` — `handleLocalChange`

During `streamDownloadToPath`, inotify fires `create` and `modify` events for `absPath.pd-tmp`.
These reach `handleLocalChange`, which calls `handleLocalUpsert`. `waitForFileStable` polls mtime
and size with two 1-second gaps. If a download stalls for more than 1 second between chunk writes
(large file, slow connection) both polls see the same state and conclude the file is stable.
`handleLocalUpsert` then reads and uploads the truncated temp file to Drive.

This is independent of TS-M1: it happens during a live download, without any crash.

**Fix (TypeScript):** Early return at the top of `handleLocalChange`:
```ts
async function handleLocalChange(event: WatchEvent): Promise<void> {
  if (event.absPath.endsWith(".pd-tmp")) return;
  // ... existing code
}
```

---

## LOW — Dead Code

### [TS-L1] `doLogout` in `auth.ts` is exported but never imported
**File:** `src/lib/auth.ts`

Every logout path in the app calls `invoke("logout")` directly. `doLogout` is the only export from
`auth.ts` that nothing imports. It also performs a redundant `DELETE /auth/v4` call that the Rust
`logout` command already makes.

**Fix:** Remove `doLogout`.

---

### [TS-L2] Redundant `watchedFolderUids.delete` after loop in `handleLocalDirDeleteToRemote`
**File:** `src/lib/sync.ts`

The loop deletes every map entry whose `localDir` equals or is under `localDir`, which includes the
entry for `folderUid` itself. The standalone `watchedFolderUids.delete(folderUid)` immediately after
is always a no-op, but reads as if it handles a case the loop misses.

**Fix:** Remove the redundant standalone delete call.

---

## Notes

### `SmokeTest.tsx` — orphaned component
`src/components/SmokeTest.tsx` is not imported anywhere and is removed from the bundle by
tree-shaking. Can be deleted to keep the source tree clean.

### `watchedFolderUids` singleton and React StrictMode
In development with StrictMode, effects are double-invoked. The module-level `watchedFolderUids`
map could appear empty transiently on startup because the first cleanup fires before the second
init completes. Not a production concern — the `cancelled` flags and `stopSyncRef` in `App.tsx`
prevent actual data races — but developers may see confusing log output.

---

*Total: 1 HIGH, 2 MEDIUM, 2 LOW, 2 notes.*
