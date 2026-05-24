/**
 * Bidirectional sync engine for Proton Drive.
 *
 * - Local → Remote: inotify watcher events (via Tauri) trigger uploads.
 * - Remote → Local: Drive event subscription triggers downloads/deletes.
 *
 * Anti-loop: when we write a file locally we suppress inotify events for
 * that path for 5 seconds so we don't re-upload what we just downloaded.
 *
 * Config is read from the DB at startup (set via onboarding):
 *   local_root       — absolute local path
 *   selected_folders — JSON: SelectedFolderRecord[]
 */
import { DriveEventType, NodeType } from "@protontech/drive-sdk";
import type { DriveEvent } from "@protontech/drive-sdk";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import {
  getSyncRoot,
  getFileUploader,
  getFileRevisionUploader,
  subscribeToTreeEvents,
  getNode,
  listFolderChildren,
  persistEventAnchor,
  trashNode,
  findOrCreateFolder,
  streamDownloadToPath,
} from "./drive";
import { findWatchedFolderByPath } from "./syncHelpers";
import type { WatchedFolderEntry, SelectedFolderRecord } from "./syncHelpers";
export type { SelectedFolderRecord };
export { findWatchedFolderByPath };

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

interface FileStat {
  mtimeMs: number;
  sizeBytes: number;
  isDir: boolean;
}

interface LocalFileEntry {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

// ── Module-level state ───────────────────────────────────────────────────────

const suppressUntil = new Map<string, number>();
const recentlyUploaded = new Set<string>();
const SUPPRESS_MS = 5_000;

/**
 * Maps Drive folder UID → its local directory and which top-level selection it
 * belongs to. Built at startup and used by both event handlers to derive paths.
 */
const watchedFolderUids = new Map<string, WatchedFolderEntry>();

let _status: SyncStatus = { active: [], errors: [] };
let _statusCallback: ((s: SyncStatus) => void) | null = null;
let _lastErrorNotificationMs = 0;
let _fullSyncInProgress = false;
let _paused = false;
const FULL_SYNC_LABEL = "__full_sync__";
const ERROR_NOTIFY_THROTTLE_MS = 30_000;

// ── Recently-synced ring buffer (max 10 items) ───────────────────────────────
interface RecentFile { name: string; direction: "up" | "down" }
const _recentlySynced: RecentFile[] = [];
let _trayUpdateTimer: ReturnType<typeof setTimeout> | null = null;

function addRecentlySynced(absPath: string, direction: "up" | "down"): void {
  const name = absPath.split("/").pop() ?? absPath;
  _recentlySynced.unshift({ name, direction });
  if (_recentlySynced.length > 10) _recentlySynced.pop();
}

function scheduleTrayUpdate(): void {
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

export function pauseSync(): void {
  if (_paused) return;
  _paused = true;
  scheduleTrayUpdate();
}

export function resumeSync(): void {
  if (!_paused) return;
  _paused = false;
  // Catch up on any changes made while paused.
  triggerFullSync().catch(console.error);
  scheduleTrayUpdate();
}

export function isSyncPaused(): boolean {
  return _paused;
}

export function getSyncStatus(): SyncStatus {
  return { ..._status, active: [..._status.active], errors: [..._status.errors] };
}

export function setSyncStatusCallback(cb: (s: SyncStatus) => void): void {
  _statusCallback = cb;
}

function notifyStatus(): void {
  _statusCallback?.(getSyncStatus());
  scheduleTrayUpdate();
}

function markActive(label: string): void {
  if (!_status.active.includes(label)) {
    _status.active.push(label);
    notifyStatus();
  }
}

function markInactive(label: string): void {
  _status.active = _status.active.filter((x) => x !== label);
  notifyStatus();
}

function recordError(path: string, error: string): void {
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

// ── Anti-loop helpers ────────────────────────────────────────────────────────

function suppressPath(absPath: string): void {
  suppressUntil.set(absPath, Date.now() + SUPPRESS_MS);
}

function isSuppressed(absPath: string): boolean {
  const until = suppressUntil.get(absPath);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  suppressUntil.delete(absPath);
  return false;
}

function markUploaded(nodeUid: string): void {
  recentlyUploaded.add(nodeUid);
  setTimeout(() => recentlyUploaded.delete(nodeUid), SUPPRESS_MS);
}

// ── MIME type helper ─────────────────────────────────────────────────────────

function guessMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", csv: "text/csv",
    html: "text/html", htm: "text/html", xml: "application/xml",
    pdf: "application/pdf", json: "application/json",
    zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
  };
  return map[ext] ?? "application/octet-stream";
}

// ── File stability helpers ───────────────────────────────────────────────────

async function statFile(absPath: string): Promise<FileStat | null> {
  try {
    return await invoke<FileStat>("stat_local_file", { absPath });
  } catch {
    return null;
  }
}

async function waitForFileStable(absPath: string): Promise<FileStat | null> {
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

// ── Config loading ───────────────────────────────────────────────────────────

async function loadSyncConfig(): Promise<{
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
  await invoke("set_db_sync_config", { key: "tree_event_scope_id", value: treeEventScopeId });

  return { localRoot, selectedFolders, treeEventScopeId };
}

// ── Watched folder map ───────────────────────────────────────────────────────

async function expandFolderUids(
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

async function buildWatchedFolderMap(
  selectedFolders: SelectedFolderRecord[],
  localRoot: string,
): Promise<void> {
  watchedFolderUids.clear();
  for (const folder of selectedFolders) {
    const localDir = folder.drivePath ? `${localRoot}/${folder.drivePath}` : localRoot;
    await expandFolderUids(folder.uid, localDir, folder, folder.mode);
  }
}

function findWatchedFolderByLocalPath(absPath: string) {
  return findWatchedFolderByPath(absPath, watchedFolderUids);
}

/** Exact-match reverse lookup: returns the Drive UID whose localDir === absPath. */
function findWatchedDirUidByLocalPath(absPath: string): string | undefined {
  for (const [uid, entry] of watchedFolderUids) {
    if (entry.localDir === absPath) return uid;
  }
  return undefined;
}

// ── Full reconciliation ───────────────────────────────────────────────────────

async function cleanStaleDbEntries(): Promise<void> {
  const allFiles = await invoke<FileState[]>("get_all_file_states");
  for (const f of allFiles) {
    const stat = await statFile(f.localPath);
    if (!stat) {
      console.log("[sync] removing stale DB entry:", f.localPath);
      await invoke("delete_file_state", { remoteId: f.remoteId }).catch(console.error);
    }
  }
}

/**
 * Runs a full bidirectional reconciliation: cleans stale DB entries, then
 * re-scans both the remote Drive folders and the local filesystem. Safe to
 * call from a button or a periodic timer — concurrent calls are no-ops.
 */
export async function triggerFullSync(): Promise<void> {
  if (_fullSyncInProgress || watchedFolderUids.size === 0) return;
  _fullSyncInProgress = true;
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
    _fullSyncInProgress = false;
    markInactive(FULL_SYNC_LABEL);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startSync(): Promise<() => void> {
  // Clear transient state from any previous run to prevent stale entries.
  suppressUntil.clear();
  recentlyUploaded.clear();
  console.log("[sync] Loading sync config from DB…");
  const { localRoot, selectedFolders, treeEventScopeId } = await loadSyncConfig();
  console.log(
    "[sync] Building watched folder map,",
    selectedFolders.length,
    "selected folder(s)…",
  );
  await buildWatchedFolderMap(selectedFolders, localRoot);
  console.log("[sync] Watching", watchedFolderUids.size, "Drive folder(s)");

  // Ensure all Drive-mapped directories exist locally (covers dirs created while offline)
  for (const [, entry] of watchedFolderUids) {
    await invoke("ensure_local_dir", { absPath: entry.localDir }).catch(console.error);
  }

  await initialSyncFolder();
  await initialSyncLocalFolder();

  const subscription = await subscribeToTreeEvents(
    treeEventScopeId,
    async (event: DriveEvent) => {
      try {
        await handleDriveEvent(event);
      } catch (err) {
        console.error("[sync] Unhandled error in drive event handler:", err);
      }
    },
  );

  const unlisten: UnlistenFn = await listen<WatchEvent>("sync://local-change", async (e) => {
    try {
      await handleLocalChange(e.payload);
    } catch (err) {
      console.error("[sync] Unhandled error in local-change handler:", err);
    }
  });

  console.log("[sync] Sync engine started");

  const periodicInterval = setInterval(() => {
    // Evict expired suppress entries to prevent unbounded map growth.
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

// ── Initial sync ─────────────────────────────────────────────────────────────

async function initialSyncFolder(): Promise<void> {
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

async function initialSyncLocalFolder(): Promise<void> {
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

// ── Local → Remote ───────────────────────────────────────────────────────────

async function handleLocalChange(event: WatchEvent): Promise<void> {
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

  // Check if the path is a directory — dirs need different handling
  const stat = await statFile(absPath);
  if (stat?.isDir) {
    if (kind === "create") await handleLocalDirCreate(absPath);
    // Modify on a dir fires when its contents change — handled by the file events
    return;
  }

  await handleLocalUpsert(absPath, true);
}

async function handleLocalDelete(absPath: string): Promise<void> {
  // Check if the deleted path is a watched directory.
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
    // Prune watchedFolderUids for this dir and all its subdirs.
    for (const [uid, entry] of watchedFolderUids) {
      if (entry.localDir === localDir || entry.localDir.startsWith(localDir + "/")) {
        watchedFolderUids.delete(uid);
      }
    }
    watchedFolderUids.delete(folderUid);
    // Clean up any remaining DB rows under this tree (files may already be gone).
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

async function handleLocalUpsert(absPath: string, checkStability: boolean): Promise<void> {
  const match = findWatchedFolderByLocalPath(absPath);
  if (!match) {
    console.log("[sync] file not in any watched folder, skipping:", absPath);
    return;
  }
  const targetFolderUid = match.uid;

  const label = absPath;
  markActive(label);
  try {
    const stat = checkStability ? await waitForFileStable(absPath) : await statFile(absPath);
    if (!stat) {
      console.log("[sync] skipping (file disappeared or unreadable):", absPath);
      return;
    }

    const existing = await invoke<FileState | null>("get_file_state_by_local_path", {
      localPath: absPath,
    });

    if (existing && existing.sizeBytes !== null && existing.modifiedAt !== null &&
        stat.sizeBytes === existing.sizeBytes && stat.mtimeMs === existing.modifiedAt) {
      console.log("[sync] skipping upload — size and mtime unchanged:", absPath);
      return;
    }

    // Fetch raw file bytes via pd-file:// to avoid base64 encoding the entire file
    // over IPC — large files would otherwise OOM the WebView.
    let blob: Blob;
    try {
      const response = await fetch(`pd-file://${absPath}`);
      if (!response.ok) throw new Error(`pd-file fetch ${response.status}`);
      blob = await response.blob();
    } catch (err) {
      console.log("[sync] skipping (unreadable via pd-file://):", absPath, err);
      return;
    }

    const filename = absPath.split("/").pop() ?? absPath;
    const file = new File([blob], filename, { lastModified: stat.mtimeMs });
    const metadata = {
      mediaType: guessMimeType(filename),
      expectedSize: blob.size,
      modificationTime: new Date(stat.mtimeMs),
    };

    let nodeUid: string;
    let nodeRevisionUid: string;

    if (existing) {
      try {
        const uploader = await getFileRevisionUploader(existing.remoteId, metadata);
        const controller = await uploader.uploadFromFile(file, [], () => {});
        ({ nodeUid, nodeRevisionUid } = await controller.completion());
        markUploaded(nodeUid);
        console.log("[sync] uploaded revision:", absPath, "→", nodeUid, "rev:", nodeRevisionUid);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("not enabled for Documents") || msg.includes("Revision is currently")) {
          console.log("[sync] skipping Docs node (revision upload not supported):", absPath);
          return;
        }
        throw err;
      }
    } else {
      const uploader = await getFileUploader(targetFolderUid, filename, metadata);
      const controller = await uploader.uploadFromFile(file, [], () => {});
      ({ nodeUid, nodeRevisionUid } = await controller.completion());
      markUploaded(nodeUid);
      console.log("[sync] uploaded new file:", absPath, "→", nodeUid, "rev:", nodeRevisionUid);
    }

    await invoke("upsert_file_state", {
      remoteId: nodeUid,
      localPath: absPath,
      etag: nodeRevisionUid,
      modifiedAt: stat.mtimeMs,
      sizeBytes: blob.size,
      syncState: "synced",
    });

    addRecentlySynced(absPath, "up");

    invoke("show_notification", {
      title: "Proton Drive Sync",
      body: `${existing ? "Oppdatert" : "Lastet opp"}: ${filename}`,
    }).catch(() => {});
  } catch (err) {
    console.error("[sync] upload failed for", absPath, err);
    recordError(absPath, String(err));
  } finally {
    markInactive(label);
  }
}

// ── Remote → Local ───────────────────────────────────────────────────────────

async function handleDriveEvent(event: DriveEvent): Promise<void> {
  if (_paused) {
    console.log("[sync] paused — ignoring drive event:", event.type);
    return;
  }
  if (
    event.type === DriveEventType.NodeCreated ||
    event.type === DriveEventType.NodeUpdated
  ) {
    if (event.isTrashed) {
      await handleRemoteDelete(event.nodeUid);
      return;
    }

    if (event.parentNodeUid && !watchedFolderUids.has(event.parentNodeUid)) {
      console.log("[sync] skipping node outside watched folders (by parentUid):", event.nodeUid);
      return;
    }

    if (recentlyUploaded.has(event.nodeUid)) {
      console.log("[sync] suppressed drive event for own upload:", event.nodeUid);
      return;
    }

    await handleRemoteNodeUpdate(event.nodeUid);
  } else if (event.type === DriveEventType.NodeDeleted) {
    await handleRemoteDelete(event.nodeUid);
  } else if (
    event.type === DriveEventType.TreeRefresh ||
    event.type === DriveEventType.FastForward
  ) {
    console.log("[sync] received", event.type, "— triggering full folder re-scan");
    await initialSyncFolder();
  } else {
    console.log("[sync] ignoring drive event type:", event.type);
  }

  // Capture type before the `in`-check narrows the union to never in the else branch.
  const eventType = event.type;
  if ("treeEventScopeId" in event && "eventId" in event) {
    persistEventAnchor(event.treeEventScopeId, event.eventId).catch(() => {});
  } else if (
    eventType === DriveEventType.TreeRefresh ||
    eventType === DriveEventType.FastForward
  ) {
    // These event types did not carry eventId — anchor not advanced.
    // Events since the refresh may replay from before it on restart (harmless but redundant).
    console.warn("[sync]", eventType, "did not carry eventId — event anchor not updated");
  }
}

async function handleRemoteNodeUpdate(nodeUid: string): Promise<void> {
  const label = nodeUid;
  markActive(label);
  try {
    const nodeResult = await getNode(nodeUid);
    if (!nodeResult.ok) {
      console.warn("[sync] could not get node:", nodeUid, nodeResult.error);
      return;
    }
    const node = nodeResult.value;

    const watchedEntry = node.parentUid ? watchedFolderUids.get(node.parentUid) : undefined;
    if (!watchedEntry) {
      console.log("[sync] skipping node outside watched folders:", nodeUid, "parent:", node.parentUid);
      return;
    }

    if (node.type === NodeType.Folder) {
      const localDir = `${watchedEntry.localDir}/${node.name}`;
      await invoke("ensure_local_dir", { absPath: localDir }).catch(console.error);
      if (!watchedFolderUids.has(nodeUid)) {
        watchedFolderUids.set(nodeUid, { localDir, selectedRoot: watchedEntry.selectedRoot });
      }
      console.log("[sync] created local dir:", localDir, "(remote:", nodeUid, ")");
      return;
    }

    if (node.type !== NodeType.File) {
      console.log("[sync] skipping unsupported node type:", nodeUid, node.type);
      return;
    }

    const existing = await invoke<FileState | null>("get_file_state_by_remote_id", {
      remoteId: nodeUid,
    });

    const activeRevisionUid = node.activeRevision?.uid ?? null;
    const expectedPath = `${watchedEntry.localDir}/${node.name}`;

    if (existing) {
      const isRename = existing.localPath !== expectedPath;
      const isContentSame = activeRevisionUid !== null && activeRevisionUid === existing.etag;

      if (!isRename && isContentSame) {
        console.log("[sync] skipping download — no changes for", nodeUid);
        return;
      }

      if (isRename && isContentSame) {
        suppressPath(existing.localPath);
        suppressPath(expectedPath);
        await invoke("rename_local_file", { fromPath: existing.localPath, toPath: expectedPath });
        await invoke("upsert_file_state", {
          remoteId: nodeUid,
          localPath: expectedPath,
          etag: existing.etag,
          modifiedAt: existing.modifiedAt,
          sizeBytes: existing.sizeBytes,
          syncState: "synced",
        });
        console.log("[sync] renamed local file:", existing.localPath, "→", expectedPath);
        return;
      }

      if (isRename) {
        suppressPath(existing.localPath);
        await invoke("delete_local_file", { absPath: existing.localPath });
      }
    }

    await streamDownloadToPath(nodeUid, expectedPath, () => suppressPath(expectedPath));
    addRecentlySynced(expectedPath, "down");

    const revision = node.activeRevision;
    await invoke("upsert_file_state", {
      remoteId: nodeUid,
      localPath: expectedPath,
      etag: revision?.uid ?? null,
      modifiedAt: node.modificationTime.getTime(),
      sizeBytes: revision?.claimedSize ?? null,
      syncState: "synced",
    });

    invoke("show_notification", {
      title: "Proton Drive Sync",
      body: `Lastet ned: ${node.name}`,
    }).catch(() => {});
    console.log("[sync] downloaded remote node:", nodeUid, "→", expectedPath);
  } catch (err) {
    console.error("[sync] download failed for node", nodeUid, err);
    recordError(nodeUid, String(err));
  } finally {
    markInactive(label);
  }
}

async function handleRemoteDelete(nodeUid: string): Promise<void> {
  try {
    // 1. Known file in DB
    const fileState = await invoke<FileState | null>("get_file_state_by_remote_id", {
      remoteId: nodeUid,
    });
    if (fileState) {
      suppressPath(fileState.localPath);
      await invoke("delete_local_file", { absPath: fileState.localPath });
      await invoke("set_file_sync_state", { remoteId: nodeUid, syncState: "deleted" });
      console.log("[sync] deleted local file:", fileState.localPath, "(remote:", nodeUid, ")");
      return;
    }

    // 2. Known directory (in watched folder map from startup expansion)
    const watchedEntry = watchedFolderUids.get(nodeUid);
    if (watchedEntry) {
      await handleRemoteDirDelete(nodeUid, watchedEntry.localDir);
      return;
    }

    // 3. Unknown node — resolve via SDK (covers dirs created after startup)
    const nodeResult = await getNode(nodeUid).catch(() => null);
    if (nodeResult?.ok) {
      const node = nodeResult.value;
      const parentEntry = node.parentUid ? watchedFolderUids.get(node.parentUid) : undefined;
      if (parentEntry && node.type === NodeType.Folder) {
        const localDir = `${parentEntry.localDir}/${node.name}`;
        await handleRemoteDirDelete(nodeUid, localDir);
        return;
      }
    }

    console.log("[sync] remote delete for unknown node (not tracked):", nodeUid);
  } catch (err) {
    console.error("[sync] remote delete failed for", nodeUid, err);
    recordError(nodeUid, String(err));
  }
}

async function handleRemoteDirDelete(folderUid: string, localDir: string): Promise<void> {
  // Clean up all DB rows under this directory tree
  const allFiles = await invoke<FileState[]>("get_all_file_states");
  for (const f of allFiles) {
    if (f.localPath === localDir || f.localPath.startsWith(localDir + "/")) {
      await invoke("delete_file_state", { remoteId: f.remoteId }).catch(console.error);
    }
  }
  // Remove this folder and all its watched subdirs from the in-memory map
  for (const [uid, entry] of watchedFolderUids) {
    if (entry.localDir === localDir || entry.localDir.startsWith(localDir + "/")) {
      watchedFolderUids.delete(uid);
    }
  }
  watchedFolderUids.delete(folderUid);
  suppressPath(localDir);
  await invoke("delete_local_dir", { absPath: localDir });
  console.log("[sync] deleted local directory:", localDir, "(remote:", folderUid, ")");
}
