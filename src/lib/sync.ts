/**
 * Bidirectional sync engine for Proton Drive.
 *
 * - Local → Remote: inotify watcher events (via Tauri) trigger uploads.
 * - Remote → Local: Drive event subscription triggers downloads/deletes.
 *
 * Anti-loop: when we write a file locally we suppress inotify events for
 * that path for 5 seconds so we don't re-upload what we just downloaded.
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
  getFileDownloader,
  subscribeToTreeEvents,
  getNode,
  findOrCreateFolder,
  listFolderChildren,
  persistEventAnchor,
} from "./drive";

// ── Types ────────────────────────────────────────────────────────────────────

interface WatchEvent {
  absPath: string;
  kind: "create" | "modify" | "delete";
}

export interface SyncStatus {
  active: string[]; // paths / ids currently being synced
  errors: Array<{ path: string; error: string }>;
}

interface FileState {
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
}

// ── Config ───────────────────────────────────────────────────────────────────

/**
 * Name of the Drive folder used for testing. Only files directly inside this
 * folder are synced — everything else on Drive is untouched.
 */
export const SYNC_FOLDER_NAME = "LinuxSyncTest";

// ── Module-level state ───────────────────────────────────────────────────────

/** path → timestamp until which inotify events are suppressed */
const suppressUntil = new Map<string, number>();

/** nodeUids we just uploaded — suppress their drive events */
const recentlyUploaded = new Set<string>();

const SUPPRESS_MS = 5_000;

/** UID of the remote Drive folder we sync against (resolved once on startup). */
let _syncFolderUid: string | null = null;
/** Volume event scope for the Drive tree — used with subscribeToTreeEvents. */
let _treeEventScopeId: string | null = null;

export function getSyncFolderUid(): string | null {
  return _syncFolderUid;
}

let _status: SyncStatus = { active: [], errors: [] };
let _statusCallback: ((s: SyncStatus) => void) | null = null;

export function getSyncStatus(): SyncStatus {
  return { ..._status, active: [..._status.active], errors: [..._status.errors] };
}

export function setSyncStatusCallback(cb: (s: SyncStatus) => void): void {
  _statusCallback = cb;
}

function notifyStatus(): void {
  _statusCallback?.(getSyncStatus());
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
  // Keep last 20 errors
  if (_status.errors.length > 20) _status.errors.shift();
  notifyStatus();
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

// ── File stability helpers ───────────────────────────────────────────────────

async function statFile(absPath: string): Promise<FileStat | null> {
  try {
    return await invoke<FileStat>("stat_local_file", { absPath });
  } catch {
    return null;
  }
}

/**
 * Waits until the file's mtime and size stop changing, up to ~2 s.
 * Returns the stable stat, or null if the file vanished.
 */
async function waitForFileStable(absPath: string): Promise<FileStat | null> {
  const first = await statFile(absPath);
  if (!first) return null;
  await new Promise<void>((r) => setTimeout(r, 1_000));
  const second = await statFile(absPath);
  if (!second) return null;
  if (second.mtimeMs === first.mtimeMs && second.sizeBytes === first.sizeBytes) {
    return second;
  }
  // Still changing — wait one more second and proceed regardless.
  await new Promise<void>((r) => setTimeout(r, 1_000));
  return statFile(absPath);
}

// ── Sync folder resolution ───────────────────────────────────────────────────

/**
 * Resolves the remote Drive folder UID for SYNC_FOLDER_NAME, creating the
 * folder if it doesn't exist. Caches the result in the DB so it survives
 * restarts without an extra API round-trip.
 */
async function resolveSyncFolder(): Promise<string> {
  // Check DB cache first (both folder UID and tree event scope).
  const [cached, cachedScope] = await Promise.all([
    invoke<string | null>("get_db_sync_config", { key: "sync_folder_uid" }),
    invoke<string | null>("get_db_sync_config", { key: "tree_event_scope_id" }),
  ]);
  if (cached && cachedScope) {
    _syncFolderUid = cached;
    _treeEventScopeId = cachedScope;
    return cached;
  }

  const rootResult = await getSyncRoot();
  if (!rootResult.ok) {
    throw new Error("Could not get Drive root: " + String(rootResult.error));
  }

  // Capture the volume's event scope from the root node.
  _treeEventScopeId = rootResult.value.treeEventScopeId;
  await invoke("set_db_sync_config", { key: "tree_event_scope_id", value: _treeEventScopeId });

  const folderResult = await findOrCreateFolder(rootResult.value, SYNC_FOLDER_NAME);
  if (!folderResult.ok) {
    throw new Error("Could not find/create sync folder: " + String(folderResult.error));
  }

  const uid = folderResult.value.uid;
  await invoke("set_db_sync_config", { key: "sync_folder_uid", value: uid });
  _syncFolderUid = uid;
  console.log("[sync] Sync folder resolved:", SYNC_FOLDER_NAME, "→", uid, "scope:", _treeEventScopeId);
  return uid;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the bidirectional sync engine.
 *
 * @returns A cleanup function that stops both the Drive event subscription
 *          and the local-change listener.
 */
export async function startSync(syncRoot: string): Promise<() => void> {
  console.log("[sync] Starting sync engine, syncRoot:", syncRoot);

  // Resolve (or create) the test folder before accepting any events.
  await resolveSyncFolder();

  // Initial sync: download any pre-existing remote files and upload untracked local files.
  await initialSyncFolder(syncRoot);
  await initialSyncLocalFolder(syncRoot);

  // Subscribe to the volume's tree event scope for file-level events (NodeCreated, etc.).
  if (!_treeEventScopeId) throw new Error("Tree event scope ID not resolved");
  const subscription = await subscribeToTreeEvents(_treeEventScopeId, async (event: DriveEvent) => {
    try {
      await handleDriveEvent(event, syncRoot);
    } catch (err) {
      console.error("[sync] Unhandled error in drive event handler:", err);
    }
  });

  // Listen for local inotify events from Rust.
  const unlisten: UnlistenFn = await listen<WatchEvent>(
    "sync://local-change",
    async (e) => {
      try {
        await handleLocalChange(e.payload, syncRoot);
      } catch (err) {
        console.error("[sync] Unhandled error in local-change handler:", err);
      }
    },
  );

  console.log("[sync] Sync engine started");

  return () => {
    unlisten();
    subscription.dispose();
    console.log("[sync] Sync engine stopped");
  };
}

// ── Initial sync ─────────────────────────────────────────────────────────────

/**
 * Enumerate all files in the sync folder. Downloads files that are not yet
 * tracked locally, and re-downloads files whose remote revision has changed.
 * Also called when TreeRefresh/FastForward signals the event stream has gaps.
 */
async function initialSyncFolder(syncRoot: string): Promise<void> {
  if (!_syncFolderUid) return;
  console.log("[sync] Scanning remote sync folder…");
  let downloaded = 0;
  try {
    for await (const result of listFolderChildren(_syncFolderUid, { type: NodeType.File })) {
      if (!result.ok) {
        console.warn("[sync] Error enumerating child:", result.error);
        continue;
      }
      const node = result.value;
      const existing = await invoke<FileState | null>("get_file_state_by_remote_id", {
        remoteId: node.uid,
      });

      if (existing) {
        // Skip if we already have the same revision.
        const remoteRevUid = node.activeRevision?.uid;
        if (remoteRevUid && remoteRevUid === existing.etag) continue;
      }

      await handleRemoteNodeUpdate(node.uid, syncRoot);
      downloaded++;
    }
  } catch (err) {
    console.error("[sync] Initial folder scan failed:", err);
  }
  console.log("[sync] Remote scan complete, synced", downloaded, "file(s)");
}

/**
 * Enumerate local files and upload those not yet tracked or whose content has
 * changed since the last sync.
 */
async function initialSyncLocalFolder(syncRoot: string): Promise<void> {
  console.log("[sync] Scanning local sync folder…");
  let uploaded = 0;
  try {
    const files = await invoke<string[]>("list_local_dir", { absPath: syncRoot });
    for (const absPath of files) {
      // handleLocalUpsert handles its own "skip if unchanged" logic.
      const before = _status.active.length;
      await handleLocalUpsert(absPath, syncRoot, false);
      if (_status.active.length !== before || _status.errors.some((e) => e.path === absPath)) {
        uploaded++;
      }
    }
  } catch (err) {
    console.error("[sync] Local folder scan failed:", err);
  }
  console.log("[sync] Local scan complete, processed", uploaded, "file(s)");
}

// ── Local → Remote ───────────────────────────────────────────────────────────

async function handleLocalChange(event: WatchEvent, syncRoot: string): Promise<void> {
  const { absPath, kind } = event;

  if (isSuppressed(absPath)) {
    console.log("[sync] suppressed local event for", absPath);
    return;
  }

  if (kind === "delete") {
    // Safety: don't propagate deletes to remote in MVP (last-write-wins).
    console.log("[sync] skipping local delete (MVP safety):", absPath);
    return;
  }

  // create | modify — stability check before uploading.
  await handleLocalUpsert(absPath, syncRoot, true);
}

/**
 * Uploads a local file to Drive, creating a new revision if the file already
 * exists remotely. Skips the upload if the file is unchanged (same size).
 *
 * @param checkStability - When true, waits for the file to stop changing
 *   before reading it (prevents uploading partial writes). Pass false during
 *   the startup scan where files are already at rest.
 */
async function handleLocalUpsert(
  absPath: string,
  _syncRoot: string,
  checkStability: boolean,
): Promise<void> {
  const label = absPath;
  markActive(label);
  try {
    // Get a stable snapshot of the file's metadata.
    const stat = checkStability
      ? await waitForFileStable(absPath)
      : await statFile(absPath);

    if (!stat) {
      console.log("[sync] skipping (file disappeared or unreadable):", absPath);
      return;
    }

    const existing = await invoke<FileState | null>("get_file_state_by_local_path", {
      localPath: absPath,
    });

    if (existing) {
      // Skip if size is unchanged — cheapest signal for "probably the same content".
      if (existing.sizeBytes !== null && stat.sizeBytes === existing.sizeBytes) {
        console.log("[sync] skipping upload — size unchanged:", absPath);
        return;
      }
    }

    // Read file as base64.
    let contentB64: string;
    try {
      contentB64 = await invoke<string>("read_local_file", { absPath });
    } catch (err) {
      console.log("[sync] skipping (unreadable):", absPath, err);
      return;
    }

    const raw = atob(contentB64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const filename = absPath.split("/").pop() ?? absPath;
    if (!_syncFolderUid) throw new Error("Sync folder not resolved — cannot upload");

    const blob = new Blob([bytes]);
    const file = new File([blob], filename, { lastModified: stat.mtimeMs });
    const metadata = {
      mediaType: "application/octet-stream",
      expectedSize: bytes.length,
      modificationTime: new Date(stat.mtimeMs),
    };

    let nodeUid: string;
    let nodeRevisionUid: string;

    if (existing) {
      // Upload a new revision of the existing Drive node.
      const uploader = await getFileRevisionUploader(existing.remoteId, metadata);
      const controller = await uploader.uploadFromFile(file, [], () => {});
      ({ nodeUid, nodeRevisionUid } = await controller.completion());
      console.log("[sync] uploaded revision:", absPath, "→", nodeUid, "rev:", nodeRevisionUid);
    } else {
      // Upload a brand-new file.
      const uploader = await getFileUploader(_syncFolderUid, filename, metadata);
      const controller = await uploader.uploadFromFile(file, [], () => {});
      ({ nodeUid, nodeRevisionUid } = await controller.completion());

      // Suppress the drive event for our own upload.
      recentlyUploaded.add(nodeUid);
      setTimeout(() => recentlyUploaded.delete(nodeUid), SUPPRESS_MS);

      console.log("[sync] uploaded new file:", absPath, "→", nodeUid, "rev:", nodeRevisionUid);
    }

    await invoke("upsert_file_state", {
      remoteId: nodeUid,
      localPath: absPath,
      etag: nodeRevisionUid,
      modifiedAt: stat.mtimeMs,
      sizeBytes: bytes.length,
      syncState: "synced",
    });

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

async function handleDriveEvent(event: DriveEvent, syncRoot: string): Promise<void> {
  if (
    event.type === DriveEventType.NodeCreated ||
    event.type === DriveEventType.NodeUpdated
  ) {
    // A trashed node event means the file was moved to trash — treat as deletion.
    if (event.isTrashed) {
      await handleRemoteDelete(event.nodeUid, syncRoot);
      return;
    }

    // Early filter: if parentNodeUid is known and not our sync folder, skip without API call.
    if (event.parentNodeUid && event.parentNodeUid !== _syncFolderUid) {
      console.log("[sync] skipping node outside sync folder (by parentUid):", event.nodeUid);
      return;
    }

    if (recentlyUploaded.has(event.nodeUid)) {
      console.log("[sync] suppressed drive event for own upload:", event.nodeUid);
      return;
    }

    await handleRemoteNodeUpdate(event.nodeUid, syncRoot);

  } else if (event.type === DriveEventType.NodeDeleted) {
    await handleRemoteDelete(event.nodeUid, syncRoot);

  } else if (
    event.type === DriveEventType.TreeRefresh ||
    event.type === DriveEventType.FastForward
  ) {
    // The event stream has a gap — re-scan the sync folder to catch up.
    console.log("[sync] received", event.type, "— triggering full folder re-scan");
    await initialSyncFolder(syncRoot);

  } else {
    // TreeRemove, SharedWithMeUpdated, etc. — not relevant to our sync folder.
    console.log("[sync] ignoring drive event type:", event.type);
  }

  // Persist the anchor after successful handling so the subscription resumes
  // from this point on next startup instead of replaying from scratch.
  if ("treeEventScopeId" in event && "eventId" in event) {
    persistEventAnchor(event.treeEventScopeId, event.eventId).catch(() => {});
  }
}

async function handleRemoteNodeUpdate(nodeUid: string, syncRoot: string): Promise<void> {
  const label = nodeUid;
  markActive(label);
  try {
    const nodeResult = await getNode(nodeUid);
    if (!nodeResult.ok) {
      console.warn("[sync] could not get node:", nodeUid, nodeResult.error);
      return;
    }
    const node = nodeResult.value;

    // Only handle nodes that live directly inside the test sync folder.
    if (node.parentUid !== _syncFolderUid) {
      console.log("[sync] skipping node outside sync folder:", nodeUid, "parent:", node.parentUid);
      return;
    }

    // Only handle files in MVP.
    if (node.type !== NodeType.File) {
      console.log("[sync] skipping non-file node:", nodeUid, node.type);
      return;
    }

    const existing = await invoke<FileState | null>("get_file_state_by_remote_id", {
      remoteId: nodeUid,
    });

    const activeRevisionUid = node.activeRevision?.uid ?? null;
    const expectedPath = `${syncRoot}/${node.name}`;

    if (existing) {
      const isRename = existing.localPath !== expectedPath;
      const isContentSame = activeRevisionUid !== null && activeRevisionUid === existing.etag;

      if (!isRename && isContentSame) {
        console.log("[sync] skipping download — no changes for", nodeUid);
        return;
      }

      if (isRename && isContentSame) {
        // Pure rename: move the local file and update the DB record.
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

      // Content changed (possibly also renamed): trash the old local file if path differs.
      if (isRename) {
        suppressPath(existing.localPath);
        await invoke("trash_local_file", { absPath: existing.localPath, syncRoot });
      }
    }

    // Download the file to its new (or unchanged) path.
    const downloader = await getFileDownloader(nodeUid);
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
      },
    });
    const dlController = downloader.downloadToStream(writable, () => {});
    await dlController.completion();

    // Merge chunks → base64.
    const totalLength = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    let binary = "";
    for (let i = 0; i < merged.length; i++) binary += String.fromCharCode(merged[i]);
    const b64 = btoa(binary);

    // Suppress inotify so we don't re-upload what we just wrote.
    suppressPath(expectedPath);

    await invoke("write_local_file", { absPath: expectedPath, contentB64: b64 });

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

async function handleRemoteDelete(nodeUid: string, syncRoot: string): Promise<void> {
  try {
    const fileState = await invoke<FileState | null>("get_file_state_by_remote_id", {
      remoteId: nodeUid,
    });

    if (!fileState) {
      console.log("[sync] remote delete for unknown node (not tracked):", nodeUid);
      return;
    }

    suppressPath(fileState.localPath);
    // Move to trash instead of permanently deleting — safeguard while sync logic is unverified.
    await invoke("trash_local_file", { absPath: fileState.localPath, syncRoot });
    await invoke("set_file_sync_state", { remoteId: nodeUid, syncState: "deleted" });

    console.log("[sync] trashed local file:", fileState.localPath, "(remote:", nodeUid, ")");
  } catch (err) {
    console.error("[sync] remote delete failed for", nodeUid, err);
    recordError(nodeUid, String(err));
  }
}
