# TypeScript Sync Engine Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `src/lib/sync.ts` (872 lines, 7 mixed concerns) into a focused `sync/` directory module, and fix a silent-failure bug in the startup config path.

**Architecture:** Create `src/lib/sync/` as a directory module. `sync/state.ts` owns all shared mutable state and the helpers that mutate it. `sync/config.ts` handles startup config loading and folder-map expansion. `sync/local-to-remote.ts` and `sync/remote-to-local.ts` own each half of the sync loop. `sync/reconciliation.ts` owns full-scan reconciliation. `sync/index.ts` wires everything together (exports `startSync`) and re-exports the public API so that all existing import paths (`"./lib/sync"`, `"../lib/sync"`) continue to work unchanged. TypeScript module resolution: `sync.ts` takes priority over `sync/index.ts`, so `sync.ts` must be deleted in the same commit that creates `sync/index.ts` (Task 7).

**Tech Stack:** TypeScript 5, React 19, Vitest. All 81 existing `pnpm test` cases must pass after every task that involves changing imports or deleting files.

---

## File Structure

**Create:**
- `src/lib/sync/state.ts` — all module-level mutable state + helpers that read/write it: `suppressUntil`, `recentlyUploaded`, `watchedFolderUids`, `_paused`, `_status`, `_fullSyncInProgress`, `_statusCallback`, `_lastErrorNotificationMs`, `SUPPRESS_MS`, `FULL_SYNC_LABEL`, `ERROR_NOTIFY_THROTTLE_MS`, `_recentlySynced`, `_trayUpdateTimer`; functions: `suppressPath`, `isSuppressed`, `markUploaded`, `addRecentlySynced`, `scheduleTrayUpdate`, `notifyStatus`, `markActive`, `markInactive`, `recordError`, `statFile`, `pauseSync`, `resumeSync`, `isSyncPaused`, `getSyncStatus`, `setSyncStatusCallback`, `_resetSyncStateForTesting`, `_setWatchedFoldersForTesting`
- `src/lib/sync/config.ts` — `loadSyncConfig`, `expandFolderUids`, `buildWatchedFolderMap`, `waitForFileStable`
- `src/lib/sync/local-to-remote.ts` — `handleLocalChange`, `handleLocalUpsert`, `handleLocalDelete`, `handleLocalDirCreate`, `handleLocalDirDeleteToRemote`, `findWatchedFolderByLocalPath`, `findWatchedDirUidByLocalPath`
- `src/lib/sync/remote-to-local.ts` — `handleDriveEvent`, `handleRemoteNodeUpdate`, `handleRemoteDelete`, `handleRemoteDirDelete`
- `src/lib/sync/reconciliation.ts` — `initialSyncFolder`, `initialSyncLocalFolder`, `cleanStaleDbEntries`, `triggerFullSync`
- `src/lib/sync/index.ts` — `startSync` lifecycle function; re-exports entire public API from sub-modules; preserves all types exported by original `sync.ts`

**Modify:**
- `src/lib/sync/config.ts` — add `.catch()` on the non-fatal `set_db_sync_config` invoke call

**Delete:**
- `src/lib/sync.ts` (replaced by `sync/` directory; deleted in same commit as Task 7)

**Consumers (no changes required — `"./lib/sync"` still resolves correctly):**
- `src/App.tsx`
- `src/components/Onboarding.tsx`
- `src/components/ConflictWizard.tsx`
- `src/components/FolderTree.tsx`
- `src/__tests__/syncHandlers.test.ts`
- `src/__tests__/helpers/syncMocks.ts`

---

## Dependency Graph

```
state.ts        ← drive.ts (for scheduleTrayUpdate invoke), @tauri-apps/api/core
config.ts       ← state.ts, drive.ts, syncHelpers.ts, @tauri-apps/api/core
local-to-remote.ts ← state.ts, drive.ts, @tauri-apps/api/core
remote-to-local.ts ← state.ts, drive.ts, @tauri-apps/api/core
reconciliation.ts  ← state.ts, local-to-remote.ts, remote-to-local.ts, @tauri-apps/api/core
index.ts           ← all above + drive.ts, @tauri-apps/api/event
```

No circular dependencies.

---

## Task 1: Create `sync/state.ts`

Build the shared-state module. This file has no dependencies on the other new sync sub-modules.

**Files:**
- Create: `src/lib/sync/state.ts`

- [ ] **Step 1: Write `sync/state.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";
import { findWatchedFolderByPath } from "../syncHelpers";
import type { WatchedFolderEntry, SelectedFolderRecord } from "../syncHelpers";
import type { FileStat } from "../syncDecisions";

// Re-export for consumers of sync/index.ts
export type { WatchedFolderEntry, SelectedFolderRecord };

// ── Types ────────────────────────────────────────────────────────────────────

export interface WatchEvent {
  absPath: string;
  kind: "create" | "modify" | "delete";
}

export interface SyncStatus {
  active: string[];
  errors: Array<{ path: string; error: string }>;
}

export interface FileState {
  remoteId: string;
  localPath: string;
  etag: string | null;
  modifiedAt: number | null;
  sizeBytes: number | null;
  syncState: string;
}

interface LocalFileEntry {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export type { LocalFileEntry };

// ── Anti-loop state ──────────────────────────────────────────────────────────

export const suppressUntil = new Map<string, number>();
export const recentlyUploaded = new Set<string>();
export const SUPPRESS_MS = 5_000;

export function suppressPath(absPath: string): void {
  suppressUntil.set(absPath, Date.now() + SUPPRESS_MS);
}

export function isSuppressed(absPath: string): boolean {
  const until = suppressUntil.get(absPath);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  suppressUntil.delete(absPath);
  return false;
}

export function markUploaded(nodeUid: string): void {
  recentlyUploaded.add(nodeUid);
  setTimeout(() => recentlyUploaded.delete(nodeUid), SUPPRESS_MS);
}

// ── Watched folder map ───────────────────────────────────────────────────────

export const watchedFolderUids = new Map<string, WatchedFolderEntry>();

// ── Sync status state ────────────────────────────────────────────────────────

export let _status: SyncStatus = { active: [], errors: [] };
export let _statusCallback: ((s: SyncStatus) => void) | null = null;
export let _lastErrorNotificationMs = 0;
export let _fullSyncInProgress = false;
export let _paused = false;
export const FULL_SYNC_LABEL = "__full_sync__";
export const ERROR_NOTIFY_THROTTLE_MS = 30_000;

interface RecentFile { name: string; direction: "up" | "down" }
export const _recentlySynced: RecentFile[] = [];
export let _trayUpdateTimer: ReturnType<typeof setTimeout> | null = null;

// Setters for variables that cannot be reassigned from importing modules
export function setStatus(s: SyncStatus): void { _status = s; }
export function setStatusCallback(cb: ((s: SyncStatus) => void) | null): void { _statusCallback = cb; }
export function setLastErrorNotificationMs(v: number): void { _lastErrorNotificationMs = v; }
export function setFullSyncInProgress(v: boolean): void { _fullSyncInProgress = v; }
export function setPaused(v: boolean): void { _paused = v; }
export function setTrayUpdateTimer(t: ReturnType<typeof setTimeout> | null): void { _trayUpdateTimer = t; }

// ── Status helpers ───────────────────────────────────────────────────────────

export function addRecentlySynced(absPath: string, direction: "up" | "down"): void {
  const name = absPath.split("/").pop() ?? absPath;
  _recentlySynced.unshift({ name, direction });
  if (_recentlySynced.length > 10) _recentlySynced.pop();
}

export function scheduleTrayUpdate(): void {
  if (_trayUpdateTimer) clearTimeout(_trayUpdateTimer);
  _trayUpdateTimer = setTimeout(() => {
    _trayUpdateTimer = null;
    const activeItems = _status.active.filter((x) => x !== FULL_SYNC_LABEL);
    invoke("update_tray_status", {
      paused: _paused,
      syncing: activeItems.length > 0,
      activeCount: activeItems.length,
      recentFiles: _recentlySynced.slice(0, 8),
      errorCount: _status.errors.length,
    }).catch(() => {});
  }, 400);
}

export function notifyStatus(): void {
  _statusCallback?..(getSyncStatus());
  scheduleTrayUpdate();
}

export function markActive(label: string): void {
  if (!_status.active.includes(label)) {
    _status.active.push(label);
    notifyStatus();
  }
}

export function markInactive(label: string): void {
  _status.active = _status.active.filter((x) => x !== label);
  notifyStatus();
}

export function recordError(path: string, error: string): void {
  _status.errors.push({ path, error });
  if (_status.errors.length > 20) _status.errors.shift();
  notifyStatus();

  const now = Date.now();
  if (now - _lastErrorNotificationMs >= ERROR_NOTIFY_THROTTLE_MS) {
    _lastErrorNotificationMs = now;
    invoke("show_notification", {
      title: "Proton Drive Sync — error",
      body: `${path.split("/").pop() ?? path}: ${error}`,
    }).catch(() => {});
  }
}

// ── File stat helper ─────────────────────────────────────────────────────────

export async function statFile(absPath: string): Promise<FileStat | null> {
  try {
    return await invoke<FileStat>("stat_local_file", { absPath });
  } catch {
    return null;
  }
}

// ── Public sync control ──────────────────────────────────────────────────────

export function pauseSync(): void {
  if (_paused) return;
  _paused = true;
  notifyStatus();
}

export function resumeSync(): void {
  if (!_paused) return;
  _paused = false;
  notifyStatus();
}

export function isSyncPaused(): boolean { return _paused; }

export function getSyncStatus(): SyncStatus {
  return { active: [..._status.active], errors: [..._status.errors] };
}

export function setSyncStatusCallback(cb: ((s: SyncStatus) => void) | null): void {
  _statusCallback = cb;
}

// ── Test utilities ───────────────────────────────────────────────────────────

/** @internal */
export function _resetSyncStateForTesting(): void {
  suppressUntil.clear();
  recentlyUploaded.clear();
  watchedFolderUids.clear();
  _paused = false;
  _fullSyncInProgress = false;
  _status = { active: [], errors: [] };
  _statusCallback = null;
  _lastErrorNotificationMs = 0;
  if (_trayUpdateTimer) clearTimeout(_trayUpdateTimer);
  _trayUpdateTimer = null;
  _recentlySynced.length = 0;
}

/** @internal */
export function _setWatchedFoldersForTesting(entries: Map<string, WatchedFolderEntry>): void {
  watchedFolderUids.clear();
  for (const [k, v] of entries) watchedFolderUids.set(k, v);
}
```

- [ ] **Step 2: Verify the file compiles in isolation**

```bash
cd /path/to/proton-drive-linux-sync && pnpm tsc --noEmit 2>&1 | head -20
```
Expected: no errors (sync.ts still exists and works, new file is not yet imported anywhere).

- [ ] **Step 3: Commit**

```bash
git add src/lib/sync/state.ts
git commit -m "refactor: create sync/state.ts with shared sync state and helpers"
```

---

## Task 2: Create `sync/config.ts`

**Files:**
- Create: `src/lib/sync/config.ts`

- [ ] **Step 1: Write `sync/config.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";
import { getSyncRoot, listFolderChildren } from "../drive";
import { NodeType } from "@protontech/drive-sdk";
import { findWatchedFolderByPath } from "../syncHelpers";
import type { SelectedFolderRecord, WatchedFolderEntry } from "../syncHelpers";
import { watchedFolderUids, statFile } from "./state";
import type { FileStat } from "../syncDecisions";

export async function loadSyncConfig(): Promise<{
  localRoot: string;
  selectedFolders: SelectedFolderRecord[];
  treeEventScopeId: string;
}> {
  const [localRoot, selectedFoldersJson] = await Promise.all([
    invoke<string | null>("get_local_root"),
    invoke<string | null>("get_db_sync_config", { key: "selected_folders" }),
  ]);

  if (!localRoot) throw new Error("No local root configured — run onboarding first");

  const selectedFolders: SelectedFolderRecord[] = selectedFoldersJson
    ? (JSON.parse(selectedFoldersJson) as SelectedFolderRecord[])
    : [];

  const rootResult = await getSyncRoot();
  if (!rootResult.ok) throw new Error("Could not get Drive root: " + String(rootResult.error));

  const treeEventScopeId = rootResult.value.treeEventScopeId;
  // Non-fatal: persist the scope ID for reference, but don't abort startup on DB failure.
  invoke("set_db_sync_config", { key: "tree_event_scope_id", value: treeEventScopeId })
    .catch((e: unknown) => console.warn("[sync] Failed to persist tree event scope ID:", e));

  return { localRoot, selectedFolders, treeEventScopeId };
}

/** @internal */
export async function expandFolderUids(
  folderUid: string,
  localDir: string,
  selectedRoot: SelectedFolderRecord,
  mode: "files" | "recursive",
): Promise<void> {
  watchedFolderUids.set(folderUid, { localDir, selectedRoot });
  if (mode !== "recursive") return;
  for await (const child of listFolderChildren(folderUid, { type: NodeType.Folder })) {
    if (!child.ok) continue;
    const childLocalDir = `${localDir}/${child.value.name}`;
    await expandFolderUids(child.value.uid, childLocalDir, selectedRoot, "recursive");
  }
}

export async function buildWatchedFolderMap(
  selectedFolders: SelectedFolderRecord[],
  localRoot: string,
): Promise<void> {
  watchedFolderUids.clear();
  for (const folder of selectedFolders) {
    const localDir = folder.drivePath ? `${localRoot}/${folder.drivePath}` : localRoot;
    await expandFolderUids(folder.uid, localDir, folder, folder.mode);
  }
}

/** @internal */
export async function waitForFileStable(absPath: string): Promise<FileStat | null> {
  const first = await statFile(absPath);
  if (!first) return null;
  await new Promise<void>((r) => setTimeout(r, 1_000));
  const second = await statFile(absPath);
  if (!second) return null;
  if (second.mtimeMs === first.mtimeMs && second.sizeBytes === first.sizeBytes) return second;
  await new Promise<void>((r) => setTimeout(r, 1_000));
  const third = await statFile(absPath);
  if (!third || third.mtimeMs !== second.mtimeMs || third.sizeBytes !== second.sizeBytes) return null;
  return third;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync/config.ts
git commit -m "refactor: create sync/config.ts with config loading and folder map expansion"
```

---

## Task 3: Create `sync/local-to-remote.ts`

**Files:**
- Create: `src/lib/sync/local-to-remote.ts`

- [ ] **Step 1: Write `sync/local-to-remote.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";
import {
  getFileUploader, getFileRevisionUploader, getNode, trashNode, findOrCreateFolder,
} from "../drive";
import { findWatchedFolderByPath } from "../syncHelpers";
import { guessMimeType, isAlreadySynced } from "../syncDecisions";
import {
  watchedFolderUids, isSuppressed, suppressPath, recentlyUploaded, markUploaded,
  markActive, markInactive, recordError, addRecentlySynced, statFile, _paused,
} from "./state";
import type { WatchEvent, FileState } from "./state";
import { waitForFileStable } from "./config";

export type { WatchEvent };

function findWatchedFolderByLocalPath(absPath: string) {
  return findWatchedFolderByPath(absPath, watchedFolderUids);
}

function findWatchedDirUidByLocalPath(absPath: string): string | undefined {
  for (const [uid, entry] of watchedFolderUids) {
    if (entry.localDir === absPath) return uid;
  }
  return undefined;
}

/** @internal */
export async function handleLocalChange(event: WatchEvent): Promise<void> {
  if (event.absPath.endsWith(".pd-tmp")) return;
  if (_paused) {
    console.log("[sync] paused — ignoring local event for", event.absPath);
    return;
  }
  const { absPath, kind } = event;

  if (isSuppressed(absPath)) {
    console.log("[sync] suppressed local event for", absPath);
    return;
  }

  if (kind === "delete") {
    await handleLocalDelete(absPath);
    return;
  }

  const stat = await statFile(absPath);
  if (stat?.isDir) {
    if (kind === "create") await handleLocalDirCreate(absPath);
    return;
  }

  await handleLocalUpsert(absPath, true);
}

async function handleLocalDelete(absPath: string): Promise<void> {
  const dirUid = findWatchedDirUidByLocalPath(absPath);
  if (dirUid) {
    await handleLocalDirDeleteToRemote(dirUid, absPath);
    return;
  }

  const existing = await invoke<FileState | null>("get_file_state_by_local_path", {
    localPath: absPath,
  });
  if (!existing) {
    console.log("[sync] local delete: no DB entry for", absPath, "— skipping");
    return;
  }
  const label = absPath;
  markActive(label);
  try {
    await trashNode(existing.remoteId);
    await invoke("delete_file_state", { remoteId: existing.remoteId });
    console.log("[sync] trashed remote node for deleted local file:", absPath);
  } catch (err) {
    console.error("[sync] Failed to trash remote node for", absPath, err);
    recordError(absPath, String(err));
  } finally {
    markInactive(label);
  }
}

async function handleLocalDirDeleteToRemote(folderUid: string, localDir: string): Promise<void> {
  markActive(localDir);
  try {
    await trashNode(folderUid);
    for (const [uid, entry] of watchedFolderUids) {
      if (entry.localDir === localDir || entry.localDir.startsWith(localDir + "/")) {
        watchedFolderUids.delete(uid);
      }
    }
    const allFiles = await invoke<FileState[]>("get_all_file_states");
    for (const f of allFiles) {
      if (f.localPath === localDir || f.localPath.startsWith(localDir + "/")) {
        await invoke("delete_file_state", { remoteId: f.remoteId }).catch(console.error);
      }
    }
    console.log("[sync] trashed remote dir for deleted local dir:", localDir, "(uid:", folderUid, ")");
  } catch (err) {
    console.error("[sync] failed to trash remote dir:", localDir, err);
    recordError(localDir, String(err));
  } finally {
    markInactive(localDir);
  }
}

async function handleLocalDirCreate(absPath: string): Promise<void> {
  const match = findWatchedFolderByLocalPath(absPath);
  if (!match) {
    console.log("[sync] dir not in watched folder, skipping:", absPath);
    return;
  }
  const dirname = absPath.split("/").pop() ?? absPath;
  markActive(absPath);
  try {
    const result = await findOrCreateFolder(match.uid, dirname);
    if (!result.ok) throw new Error(String(result.error));
    const folderUid = result.value.uid;
    if (!watchedFolderUids.has(folderUid)) {
      watchedFolderUids.set(folderUid, { localDir: absPath, selectedRoot: match.entry.selectedRoot });
    }
    console.log("[sync] created remote dir:", absPath, "→", folderUid);
  } catch (err) {
    console.error("[sync] failed to create remote dir:", absPath, err);
    recordError(absPath, String(err));
  } finally {
    markInactive(absPath);
  }
}

/** @internal */
export async function handleLocalUpsert(absPath: string, checkStability: boolean): Promise<void> {
  // ... (copy exact body from sync.ts lines 545–638)
  // Key: uses watchedFolderUids, findWatchedFolderByLocalPath, statFile, waitForFileStable,
  //      isAlreadySynced, guessMimeType, getNode, getFileRevisionUploader, getFileUploader,
  //      markUploaded, addRecentlySynced, invoke, markActive, markInactive, recordError
}
```

The complete body of `handleLocalUpsert` is copied verbatim from `sync.ts` lines 545–638. Change `import` references to come from `"./state"` and `"./config"` rather than module-level variables.

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync/local-to-remote.ts
git commit -m "refactor: create sync/local-to-remote.ts with local→remote handlers"
```

---

## Task 4: Create `sync/remote-to-local.ts`

**Files:**
- Create: `src/lib/sync/remote-to-local.ts`

- [ ] **Step 1: Write `sync/remote-to-local.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";
import { getNode, streamDownloadToPath } from "../drive";
import { NodeType, DriveEventType } from "@protontech/drive-sdk";
import type { DriveEvent } from "@protontech/drive-sdk";
import {
  watchedFolderUids, isSuppressed, suppressPath, recentlyUploaded,
  markActive, markInactive, recordError, addRecentlySynced, _paused,
} from "./state";
import type { FileState } from "./state";

/** @internal */
export async function handleRemoteNodeUpdate(nodeUid: string): Promise<void> {
  // ... (copy exact body from sync.ts lines 694–788)
}

/** @internal */
export async function handleRemoteDelete(nodeUid: string): Promise<void> {
  // ... (copy exact body from sync.ts lines 791–852, including handleRemoteDirDelete)
}

async function handleRemoteDirDelete(folderUid: string, localDir: string): Promise<void> {
  // ... (copy exact body from sync.ts — the private helper used by handleRemoteDelete)
}

export async function handleDriveEvent(event: DriveEvent): Promise<void> {
  if (_paused) {
    console.log("[sync] paused — ignoring drive event:", event.type);
    return;
  }
  // ... (copy exact body from sync.ts lines 642–693)
  // Note: calls initialSyncFolder — that creates a circular dependency with reconciliation.ts.
  // Solution: pass initialSyncFolder as a callback parameter, OR import lazily.
  // Preferred: re-dispatch via an event or accept it as a parameter.
}
```

**Handling the `initialSyncFolder` circular call in `handleDriveEvent`:**

`handleDriveEvent` calls `initialSyncFolder()` on `TreeRefresh`/`FastForward` events. `initialSyncFolder` is in `reconciliation.ts`, which imports from `remote-to-local.ts` — creating a circular dependency.

**Solution:** Accept an `onFullRefresh` callback parameter in `handleDriveEvent`:

```typescript
export async function handleDriveEvent(
  event: DriveEvent,
  onFullRefresh: () => Promise<void>,
): Promise<void> {
  // ... same logic, but call onFullRefresh() instead of initialSyncFolder()
}
```

In `sync/index.ts` (where `startSync` wires everything), pass the callback:
```typescript
const subscription = await subscribeToTreeEvents(
  treeEventScopeId,
  async (event: DriveEvent) => {
    try {
      await handleDriveEvent(event, initialSyncFolder);
    } catch (err) { ... }
  },
);
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync/remote-to-local.ts
git commit -m "refactor: create sync/remote-to-local.ts with remote→local handlers"
```

---

## Task 5: Create `sync/reconciliation.ts`

**Files:**
- Create: `src/lib/sync/reconciliation.ts`

- [ ] **Step 1: Write `sync/reconciliation.ts`**

```typescript
import { invoke } from "@tauri-apps/api/core";
import { listFolderChildren } from "../drive";
import { NodeType } from "@protontech/drive-sdk";
import {
  watchedFolderUids, markActive, markInactive, recordError, statFile,
  _fullSyncInProgress, setFullSyncInProgress, FULL_SYNC_LABEL,
} from "./state";
import type { FileState } from "./state";
import { handleRemoteNodeUpdate } from "./remote-to-local";
import { handleLocalUpsert } from "./local-to-remote";

interface LocalFileEntry {
  absPath: string;
  relPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export async function initialSyncFolder(): Promise<void> {
  for (const [folderUid, entry] of watchedFolderUids) {
    console.log("[sync] Scanning remote folder:", entry.localDir);
    try {
      for await (const result of listFolderChildren(folderUid, { type: NodeType.File })) {
        if (!result.ok) {
          console.warn("[sync] Error enumerating child:", result.error);
          continue;
        }
        const node = result.value;
        const existing = await invoke<FileState | null>("get_file_state_by_remote_id", {
          remoteId: node.uid,
        });
        if (existing) {
          const remoteRevUid = node.activeRevision?.uid;
          if (remoteRevUid && remoteRevUid === existing.etag) continue;
        }
        await handleRemoteNodeUpdate(node.uid);
      }
    } catch (err) {
      console.error("[sync] Folder scan failed for", entry.localDir, err);
    }
  }
}

export async function initialSyncLocalFolder(): Promise<void> {
  for (const [, entry] of watchedFolderUids) {
    console.log("[sync] Scanning local folder:", entry.localDir);
    await invoke("ensure_local_dir", { absPath: entry.localDir }).catch(console.error);
    try {
      if (entry.selectedRoot.mode === "recursive") {
        const files = await invoke<LocalFileEntry[]>("list_dir_recursive", { absPath: entry.localDir });
        for (const f of files) {
          await handleLocalUpsert(f.absPath, false);
        }
      } else {
        const files = await invoke<string[]>("list_local_dir", { absPath: entry.localDir });
        for (const absPath of files) {
          await handleLocalUpsert(absPath, false);
        }
      }
    } catch (err) {
      console.error("[sync] Local folder scan failed for", entry.localDir, err);
    }
  }
}

/** @internal */
export async function cleanStaleDbEntries(): Promise<void> {
  const allFiles = await invoke<FileState[]>("get_all_file_states");
  for (const f of allFiles) {
    const stat = await statFile(f.localPath);
    if (!stat) {
      console.log("[sync] removing stale DB entry:", f.localPath);
      await invoke("delete_file_state", { remoteId: f.remoteId }).catch(console.error);
    }
  }
}

export async function triggerFullSync(): Promise<void> {
  if (_fullSyncInProgress || watchedFolderUids.size === 0) return;
  setFullSyncInProgress(true);
  markActive(FULL_SYNC_LABEL);
  console.log("[sync] Starting full reconciliation…");
  try {
    await cleanStaleDbEntries();
    await initialSyncFolder();
    await initialSyncLocalFolder();
    console.log("[sync] Full reconciliation complete");
  } catch (err) {
    console.error("[sync] Full reconciliation failed:", err);
    recordError("(full sync)", String(err));
  } finally {
    setFullSyncInProgress(false);
    markInactive(FULL_SYNC_LABEL);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/sync/reconciliation.ts
git commit -m "refactor: create sync/reconciliation.ts with full-scan and triggerFullSync"
```

---

## Task 6: Create `sync/index.ts`

Wire everything together. This file exports `startSync` and re-exports the complete public API from sub-modules.

**Files:**
- Create: `src/lib/sync/index.ts`

- [ ] **Step 1: Write `sync/index.ts`**

```typescript
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { subscribeToTreeEvents } from "../drive";
import type { DriveEvent } from "@protontech/drive-sdk";
import { findWatchedFolderByPath } from "../syncHelpers";

import { loadSyncConfig, buildWatchedFolderMap, expandFolderUids, waitForFileStable } from "./config";
import { handleLocalChange } from "./local-to-remote";
import { handleDriveEvent } from "./remote-to-local";
import {
  initialSyncFolder, initialSyncLocalFolder, cleanStaleDbEntries, triggerFullSync,
} from "./reconciliation";
import {
  suppressUntil, recentlyUploaded, watchedFolderUids,
} from "./state";

// Re-export entire public API so that `import ... from "./sync"` still works
export type { WatchEvent, SyncStatus, FileState } from "./state";
export type { WatchedFolderEntry, SelectedFolderRecord } from "./state";
export {
  pauseSync, resumeSync, isSyncPaused, getSyncStatus, setSyncStatusCallback,
  _resetSyncStateForTesting, _setWatchedFoldersForTesting,
} from "./state";
export { expandFolderUids, waitForFileStable, cleanStaleDbEntries } from "./config";
export { handleLocalChange, handleLocalUpsert } from "./local-to-remote";
export { handleRemoteNodeUpdate, handleRemoteDelete } from "./remote-to-local";
export { triggerFullSync } from "./reconciliation";
export { findWatchedFolderByPath };

export async function startSync(): Promise<() => void> {
  suppressUntil.clear();
  recentlyUploaded.clear();

  console.log("[sync] Loading sync config from DB…");
  const { localRoot, selectedFolders, treeEventScopeId } = await loadSyncConfig();
  console.log("[sync] Building watched folder map,", selectedFolders.length, "selected folder(s)…");
  await buildWatchedFolderMap(selectedFolders, localRoot);
  console.log("[sync] Watching", watchedFolderUids.size, "Drive folder(s)");

  for (const [, entry] of watchedFolderUids) {
    await invoke("ensure_local_dir", { absPath: entry.localDir }).catch(console.error);
  }

  await initialSyncFolder();
  await initialSyncLocalFolder();

  const subscription = await subscribeToTreeEvents(
    treeEventScopeId,
    async (event: DriveEvent) => {
      try {
        await handleDriveEvent(event, initialSyncFolder);
      } catch (err) {
        console.error("[sync] Unhandled error in drive event handler:", err);
      }
    },
  );

  const unlisten: UnlistenFn = await listen<import("./state").WatchEvent>(
    "sync://local-change",
    async (e) => {
      try {
        await handleLocalChange(e.payload);
      } catch (err) {
        console.error("[sync] Unhandled error in local-change handler:", err);
      }
    },
  );

  console.log("[sync] Sync engine started");

  const periodicInterval = setInterval(() => {
    const now = Date.now();
    for (const [path, until] of suppressUntil) {
      if (now > until) suppressUntil.delete(path);
    }
    triggerFullSync().catch(console.error);
  }, 5 * 60 * 1000);

  return () => {
    unlisten();
    subscription.dispose();
    clearInterval(periodicInterval);
    watchedFolderUids.clear();
    console.log("[sync] Sync engine stopped");
  };
}
```

- [ ] **Step 2: Commit (do NOT delete sync.ts yet)**

```bash
git add src/lib/sync/index.ts
git commit -m "refactor: create sync/index.ts with startSync and full public API re-exports"
```

---

## Task 7: Delete `sync.ts` and verify all tests pass

TypeScript module resolution prefers `sync.ts` over `sync/index.ts` when both exist. This task performs the switchover atomically.

**Files:**
- Delete: `src/lib/sync.ts`

- [ ] **Step 1: Delete the old file**

```bash
rm src/lib/sync.ts
```

- [ ] **Step 2: Type-check**

```bash
pnpm tsc --noEmit
```
Expected: no errors. All consumers (`App.tsx`, `Onboarding.tsx`, `ConflictWizard.tsx`, `FolderTree.tsx`, test files) resolve `"./lib/sync"` / `"../lib/sync"` to `sync/index.ts`.

- [ ] **Step 3: Run full test suite**

```bash
pnpm test
```
Expected: 81 tests pass.

- [ ] **Step 4: Commit**

```bash
git rm src/lib/sync.ts
git add src/lib/sync/
git commit -m "refactor: complete sync.ts → sync/ directory module split"
```

---

## Task 8: Fix `handleLocalUpsert` `_paused` live-binding pattern

**Context:** In `local-to-remote.ts`, the code imports `_paused` from `state.ts` as a named import. ES module named imports of `let` variables are live bindings — the import always reflects the current value of the variable. However, if `_paused` were destructured into a local copy, the guard would be stale. Verify the import is a live binding (not a local copy).

**Files:**
- Verify: `src/lib/sync/local-to-remote.ts`
- Verify: `src/lib/sync/remote-to-local.ts`

- [ ] **Step 1: Verify live-binding pattern in local-to-remote.ts**

The import `import { _paused } from "./state"` is a live binding in ES modules — it will always read the current value. Confirm the usage at the top of `handleLocalChange` and `handleLocalUpsert` reads `_paused` directly (not via a closure over a local copy made at import time).

If it reads `_paused` inline in the function body, it is correct. If the original code wrapped it in `() => _paused`, change it to read the exported variable directly.

No code changes required if the pattern is already correct.

- [ ] **Step 2: Run tests to confirm pause/resume behavior**

```bash
pnpm test -- --reporter=verbose 2>&1 | grep -E "pause|PASS|FAIL"
```
Expected: pause-related tests pass.

- [ ] **Step 3: Commit (if any changes were needed)**

```bash
git add src/lib/sync/
git commit -m "fix: ensure _paused is read as live binding in sync sub-modules"
```
