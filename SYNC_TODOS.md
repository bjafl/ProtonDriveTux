# Sync Engine — TODO & Gap Analysis

Cross-referenced against the official Proton Windows Drive client at `../windows-drive/`.

---

## BLOCKERS — Must fix before live sync is reliable

### 1. Token refresh on 401
**Problem:** Access tokens expire. Every API call will start failing after ~1 hour with no way to recover without a full re-login.

**What the Windows app does:**  
`AuthorizationHandler.cs` wraps every HTTP request. On 401 it calls `getRefreshedSessionAsync()` which posts to `POST /auth/v4/refresh` with the stored `RefreshToken`. The new `AccessToken` + `RefreshToken` are persisted and the original request is retried transparently.

**Windows app references:**
- `windows-drive/src/ProtonDrive.Client/Authentication/AuthorizationHandler.cs` — 401 intercept + retry (lines ~82–103)
- `windows-drive/src/ProtonDrive.Client/Authentication/AuthenticationService.cs` — `RefreshSessionAsync()` (lines ~320–373)

**Our gap:**  
`src/lib/httpClient.ts` has no refresh logic. `currentSession` in `drive.ts` is never updated after initial login.

**Fix needed in:**  
`src/lib/httpClient.ts` — intercept 401, call refresh endpoint, update `currentSession` closures in `drive.ts`, persist new tokens to Rust keyring via `invoke("store_tokens", ...)`, retry original request.

---

### 2. File modification upload (revisions)
**Problem:** When a local file that already exists in Drive is modified, we skip the upload entirely (we detect the path is already in the DB and do nothing). The Drive file is never updated.

**What the Windows app does:**  
`RemoteFileSystemClient.cs` calls `CreateRevisionAsync()` for modified files — this creates a new Drive revision under the existing node rather than creating a duplicate file. It compares local mtime/size against the stored state to decide whether an upload is needed.

**Windows app references:**
- `windows-drive/src/ProtonDrive.Client/RemoteFileSystemClient.cs` — `CreateRevisionAsync()` (lines ~365–447)

**Our gap:**  
`handleLocalUpsert` in `src/lib/sync.ts` — if `existingState` is found in the DB we return early without checking whether the file content has actually changed.

**Fix needed in:**  
`src/lib/sync.ts` — in `handleLocalUpsert`, compare local file `mtime` + `size` against DB `modifiedAt` + `sizeBytes`. If changed, use the SDK revision upload path (not `getFileUploader` with a fresh node — check SDK API for `updateFile` or revision creation). Update DB `etag`, `modifiedAt`, `sizeBytes` after successful revision upload.

---

### 3. Write-in-progress detection
**Problem:** inotify fires `CLOSE_WRITE` but we start uploading immediately. For files being written in chunks (large files, editors that write then flush), we may upload a partial file.

**What the Windows app does:**  
`FileRevisionProvider.cs` calls `ContentHasChangedRecently()` before committing an upload — it checks whether the file's last-write timestamp is within a 1-second window and retries until stable.

**Windows app references:**
- `windows-drive/src/ProtonDrive.Sync.Adapter/FileRevisionProvider.cs` — `ContentHasChangedRecently()` (lines ~84–126)

**Our gap:**  
`src-tauri/src/watcher.rs` emits events with a 300 ms debounce, but there is no stability check after the debounce — we call `handleLocalUpsert` immediately when the Tauri event arrives on the JS side.

**Fix needed in:**  
`src/lib/sync.ts` — after receiving a `local-change` event, wait ~1 s and re-stat the file. If `mtime` or `size` changed during that window, wait again. Only upload once the file is stable for ≥1 s.

---

## HIGH PRIORITY — Needed for correct steady-state sync

### 4. Offline change detection on startup
**Problem:** If the app was closed while files were modified (either locally or remotely), startup initial sync compares only whether a `remote_id` is known — it does not detect that the *content* changed.

**What the Windows app does:**  
`SyncEngineStateConsistencyGuard.cs` checks stored revision IDs against current API state on startup and marks stale entries for re-sync.

**Windows app references:**
- `windows-drive/src/ProtonDrive.Sync.Agent/Health/SyncEngineStateConsistencyGuard.cs`

**Our gap:**  
`initialSyncFolder` in `src/lib/sync.ts` — skips nodes that already have a DB entry, regardless of whether `activeRevision.uid` matches stored `etag`.

**Fix needed in:**  
`src/lib/sync.ts` → `initialSyncFolder` — compare `node.activeRevision?.uid` against stored `etag`; if different, trigger `handleRemoteNodeUpdate` to re-download.  
Similarly in `initialSyncLocalFolder` — compare local `mtime`/`size` against DB `modifiedAt`/`sizeBytes`; if different, trigger `handleLocalUpsert`.

---

### 5. Remote rename / move handling
**Problem:** When a file is renamed or moved in Drive, we receive a `NodeUpdated` event. We currently re-download the file as if it were new content, leaving the old local file orphaned under its original name.

**What the Windows app does:**  
On `NodeUpdated` the sync adapter checks whether the node's `name` or `parentLinkId` changed relative to the local DB record. If so, it issues a local rename/move rather than a re-download.

**Windows app references:**
- `windows-drive/src/ProtonDrive.Client/RemoteFileSystemClient.cs` — node diff logic
- `windows-drive/src/ProtonDrive.Sync.Adapter/` — adapter layer that translates Drive events into local FS operations

**Our gap:**  
`handleRemoteNodeUpdate` in `src/lib/sync.ts` always downloads the full file. It does not check whether the name changed.

**Fix needed in:**  
`src/lib/sync.ts` → `handleRemoteNodeUpdate` — after fetching the node, compare `node.name` against `existingState?.localPath`. If only the name changed (same `remote_id`, same `activeRevision.uid`), rename the local file with `fs.rename` (new Tauri command needed) and update the DB `localPath`. Only re-download if `activeRevision.uid` changed.

---

## ACCEPTABLE MVP GAPS — Defer to later phases

| Gap | Reason acceptable now | When to revisit |
|-----|-----------------------|-----------------|
| **Flat folder sync only** | Deliberate scope limit for test phase (`LinuxSyncTest/` root only) | Phase 3 — recursive folder tree |
| **Large file streaming** | SDK handles block chunking internally; our `getFileUploader` path already benefits from this | When files > ~100 MB are tested |
| **HTTP retry / backoff** | SDK has internal retry logic for transient network errors | If SDK retry proves insufficient in production |
| **Sequential uploads** | Concurrent upload coordination requires a proper work queue | Phase 3 — add `p-limit` or similar |
| **Address key Token signature verification** | Security hardening; `Signature` field on `AddressKey` should be verified against the signer key before trusting the decrypted token. Low risk in personal-use context. | Before any multi-user or production deployment |
| **Compromised key flag filtering** | `AddressKey.Flags` has a `COMPROMISED` bit (value 4). We should skip keys with this flag set. Currently we filter only `Active`. | Before production |
| **Conflict resolution** | Last-write-wins is documented as the v1 policy in CLAUDE.md | Phase 3 — add conflict UI |
| **GNOME tray without extension** | Requires `gnome-shell-extension-appindicator`; documented known limitation | Evaluate AppIndicator alternatives |
| **Token TTL persistence across keyring restores** | We store `access_token` + `refresh_token` but not their expiry. After a keyring restore we don't know how stale the access token is. Once token refresh (#1 above) is implemented this becomes a non-issue on the first 401. | After blocker #1 is fixed |
