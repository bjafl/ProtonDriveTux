import { updateTrayStatus, showNotification, statLocalFile } from "../ipcApi";
import type { WatchedFolderEntry, SelectedFolderRecord } from "../syncHelpers";
import type { FileStat } from "../../types/sync";

// Re-export for consumers of sync/index.ts
export type { WatchedFolderEntry, SelectedFolderRecord };
export type { FileState, LocalFileEntry } from "../../types/sync";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WatchEvent {
  absPath: string;
  kind: "create" | "modify" | "delete";
}

export interface SyncStatus {
  active: string[];
  errors: Array<{ path: string; error: string }>;
}

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
    updateTrayStatus({
      paused: _paused,
      syncing: activeItems.length > 0,
      activeCount: activeItems.length,
      recentFiles: _recentlySynced.slice(0, 8),
      errorCount: _status.errors.length,
    }).catch(() => {});
  }, 400);
}

export function notifyStatus(): void {
  _statusCallback?.(getSyncStatus());
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
    showNotification(
      "Proton Drive Sync — error",
      `${path.split("/").pop() ?? path}: ${error}`,
    ).catch(() => {});
  }
}

// ── File stat helper ─────────────────────────────────────────────────────────

export async function statFile(absPath: string): Promise<FileStat | null> {
  try {
    return await statLocalFile(absPath);
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
