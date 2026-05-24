# Issues — Proton Drive Linux Sync

*Generated: 2026-05-24. Fresh codebase review after all previous issues (TS-H1–H6, Rust-H1–H2, all MEDIUM, all LOW) were resolved. None of those issues are re-reported here.*

---

## HIGH — Correctness Risk / Potential Data Loss

### [TS-H1] `ConflictWizard` `downloadAndWrite` triples heap usage and writes non-atomically
**File:** `src/components/ConflictWizard.tsx:291–307`

`downloadAndWrite` accumulates all stream chunks into a `chunks: Uint8Array[]` array, merges them into a second `Uint8Array`, then base64-encodes the whole thing for a single IPC call — three in-memory copies of the file at peak. More critically, it calls `write_local_file` at the final destination path directly. If anything fails (base64 too large for IPC, disk full, IPC timeout), the destination file is left at zero bytes or partially overwritten with no cleanup. `handleRemoteNodeUpdate` in `sync.ts` already solves this correctly with a `.pd-tmp` + `rename_local_file` pattern; the conflict wizard bypasses it.

**Fix:** Write to `absPath + ".pd-tmp"` using `truncate_local_file` + `write_local_file_chunk` per chunk (streaming, no accumulation), then `rename_local_file` on success. Delete the temp on failure, mirroring the pattern in `handleRemoteNodeUpdate`.

---

### [TS-H2] `ConflictWizard` calls `onComplete()` during the render phase
**File:** `src/components/ConflictWizard.tsx:128–132`

```tsx
if (conflicts.length === 0) {
  onComplete();  // triggers parent setState during render
  return null;
}
```

`onComplete` calls `setAppState("ready")` in the parent. Calling a parent state setter from inside a child render function is a React violation — renders must be pure and side-effect-free. React's StrictMode double-invokes renders, so `onComplete` is called twice in development. In production the behavior is implementation-defined and can produce skipped renders or missed updates.

**Fix:** Move to a `useEffect`:
```tsx
useEffect(() => {
  if (conflicts !== null && conflicts.length === 0) onComplete();
}, [conflicts, onComplete]);
```

---

### [Rust-H1] File-write and file-delete commands have no path-traversal guard
**File:** `src-tauri/src/commands.rs:384–505`

The `pd-file://` handler uses `canonicalize + starts_with(sync_root)` to block traversal. The following IPC commands accept arbitrary `abs_path` strings with no analogous guard:
- `read_local_file` — reads any file on the filesystem
- `write_local_file`, `truncate_local_file`, `write_local_file_chunk` — overwrites any file
- `delete_local_file`, `delete_local_dir` — deletes any path
- `rename_local_file` — moves files to/from any path
- `ensure_local_dir` — creates directories anywhere

The threat surface is real: the JS SDK (`vendor/sdk/js/sdk`) is a third-party git submodule. A supply-chain compromise could make IPC calls with attacker-controlled paths. CSP is `null` in `tauri.conf.json`, removing the browser-level script restriction.

**Fix:** Add a shared guard and call it at the top of every write/delete/rename/read command:
```rust
fn within_sync_root(abs_path: &str, db: &Db) -> Result<(), CommandError> {
    let root = db.get_sync_config("local_root")?
        .ok_or_else(|| CommandError::Other("Sync root not configured".into()))?;
    let canonical_root = std::fs::canonicalize(&root)
        .map_err(|e| CommandError::Other(format!("canonicalize root: {e}")))?;
    let canonical_path = std::fs::canonicalize(abs_path)
        .map_err(|e| CommandError::Other(format!("canonicalize path: {e}")))?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(CommandError::Other(format!("Path outside sync root: {abs_path}")));
    }
    Ok(())
}
```

---

### [Rust-H2] `unwrap()` on HTTP header construction panics on invalid `PROTON_APP_VERSION`
**File:** `src-tauri/src/auth.rs:37`

```rust
reqwest::header::HeaderValue::from_str(app_version).unwrap()
```

`HeaderValue::from_str` errors on any control byte or non-ASCII character. If `PROTON_APP_VERSION` in the environment contains such a character, `ProtonAuth::new` panics and kills the Tauri process. This is on the code path for the `logout` IPC command.

**Fix:**
```rust
reqwest::header::HeaderValue::from_str(app_version)
    .map_err(|_| AuthError::InvalidConfig("PROTON_APP_VERSION contains invalid characters".into()))
```
Add an `InvalidConfig(String)` variant to `AuthError`.

---

## MEDIUM — Maintainability / Correctness

### [TS-M1] `handleRemoteDelete` marks file as `"deleted"` instead of removing the DB row
**File:** `src/lib/sync.ts:837`

```ts
await invoke("set_file_sync_state", { remoteId: nodeUid, syncState: "deleted" });
```

The `"deleted"` state is never read anywhere. The stale row sits in the DB until `cleanStaleDbEntries` runs on the next full sync. This is inconsistent with `handleRemoteDirDelete` (line 873), which correctly calls `delete_file_state`. The DB accumulates unreachable rows between syncs.

**Fix:** Replace with `invoke("delete_file_state", { remoteId: nodeUid })`.

---

### [TS-M2] Conflict detection equates files by size alone — silently misses content differences
**File:** `src/components/ConflictWizard.tsx:272`

```ts
if (remoteSizeBytes !== null && remoteSizeBytes === local.sizeBytes) continue;
```

Two files with the same byte count but different content are excluded from the conflict table and never shown to the user. Edited text files of equal length are a common case.

**Fix:** Require both size and modification time to match:
```ts
const sameSize = remoteSizeBytes !== null && remoteSizeBytes === local.sizeBytes;
const sameMtime = remoteMtimeMs !== null && Math.abs(remoteMtimeMs - local.mtimeMs) < 2_000;
if (sameSize && sameMtime) continue;
```
(Requires `remoteMtimeMs` to be fetched alongside `remoteSizeBytes` in the conflict-loading logic.)

---

### [Rust-M1] `trash_local_file` fails on cross-device moves (NFS, separate partition)
**File:** `src-tauri/src/commands.rs:456`

`std::fs::rename` returns `EXDEV` when source and destination are on different filesystems. If the user's sync root is on a mounted NFS share or a separately-mounted partition, moving files to `.trash` (inside the sync root) fails. The remote-delete handler propagates this error and the local file is never removed.

**Fix:** Catch `EXDEV` and fall back to copy + delete:
```rust
match std::fs::rename(src, &dest) {
    Ok(()) => Ok(()),
    Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
        std::fs::copy(src, &dest)
            .and_then(|_| std::fs::remove_file(src))
            .map_err(|e| format!("cross-device trash {abs_path}: {e}").into())
    }
    Err(e) => Err(format!("rename {abs_path} → {}: {e}", dest.display()).into()),
}
```
Add `libc = "0.2"` to `Cargo.toml` dependencies.

---

## LOW — Polish

### [TS-L1] `tray-popup` window missing from `capabilities/default.json`
**File:** `src-tauri/capabilities/default.json`

The `tray-popup` window invokes `get_tray_status`, `show_main_window`, and `emit_pause_toggle`, but the window label is absent from the capabilities `"windows"` array (which covers only `"main"` and `"captcha"`). The commands work today but rely on unspecified fallback behaviour; this is fragile against future Tauri updates.

**Fix:** Add `"tray-popup"` to the `"windows"` array in `capabilities/default.json`.

---

## Notes (not bugs)

### [TS-Note] `src/lib/session.ts` is dead code
No file imports from `session.ts`. `App.tsx` defines its own local `AuthStatus` and calls `invoke` directly. The file can be removed.

---

### [Rust-Note] `app_version` fallback string differs between Rust and TypeScript
- Rust fallback (`commands.rs:119`, `auth.rs:33`): `"external-drive-protondrive@0.1.0-alpha"` (no `-linux`)
- TypeScript `config.ts` fallback: `"external-drive-protondrive-linux@0.1.0-alpha"` (has `-linux`)

When `PROTON_APP_VERSION` is unset, the Rust logout request sends a different `x-pm-appversion` than the TypeScript SDK requests. CLAUDE.md requires the `-linux` suffix; the Rust string is wrong.

**Fix:** Update both Rust fallback strings to `"external-drive-protondrive-linux@0.1.0-alpha"`.

---

*Total: 4 HIGH, 3 MEDIUM, 1 LOW, 2 notes*
