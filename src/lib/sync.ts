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
  getFileDownloader,
  subscribeToDriveEvents,
  getNode,
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

// ── Module-level state ───────────────────────────────────────────────────────

/** path → timestamp until which inotify events are suppressed */
const suppressUntil = new Map<string, number>();

/** nodeUids we just uploaded — suppress their drive events */
const recentlyUploaded = new Set<string>();

const SUPPRESS_MS = 5_000;

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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the bidirectional sync engine.
 *
 * @returns A cleanup function that stops both the Drive event subscription
 *          and the local-change listener.
 */
export async function startSync(syncRoot: string): Promise<() => void> {
  console.log("[sync] Starting sync engine, syncRoot:", syncRoot);

  // Subscribe to remote Drive events.
  const subscription = await subscribeToDriveEvents(async (event: DriveEvent) => {
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

  // create | modify
  await handleLocalUpsert(absPath, syncRoot);
}

async function handleLocalUpsert(absPath: string, _syncRoot: string): Promise<void> {
  const label = absPath;
  markActive(label);
  try {
    // Guard: if this path is already tracked in the DB, skip the upload.
    // Uploading a file we already synced would create a duplicate node on Drive.
    // Revision-based updates can be added once the sync logic is proven correct.
    const existing = await invoke<FileState | null>("get_file_state_by_local_path", {
      localPath: absPath,
    });
    if (existing) {
      console.log("[sync] skipping upload — path already tracked (remoteId:", existing.remoteId, "):", absPath);
      return;
    }

    // Read file as base64.
    let contentB64: string;
    try {
      contentB64 = await invoke<string>("read_local_file", { absPath });
    } catch (err) {
      // Could be a directory or a file we can't read — skip silently.
      console.log("[sync] skipping (unreadable):", absPath, err);
      return;
    }

    // Decode to get byte count.
    const raw = atob(contentB64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const filename = absPath.split("/").pop() ?? absPath;

    // Get sync root.
    const rootResult = await getSyncRoot();
    if (!rootResult.ok) {
      throw new Error("Could not get sync root: " + String(rootResult.error));
    }
    const rootUid = rootResult.value.uid;

    // Build a File object from the raw bytes.
    const blob = new Blob([bytes]);
    const file = new File([blob], filename, { lastModified: Date.now() });

    // Upload.
    const uploader = await getFileUploader(rootUid, filename, {
      mediaType: "application/octet-stream",
      expectedSize: bytes.length,
      modificationTime: new Date(),
    });

    const controller = await uploader.uploadFromFile(file, [], () => {});
    const { nodeUid } = await controller.completion();

    // Suppress the drive event for our own upload.
    recentlyUploaded.add(nodeUid);
    setTimeout(() => recentlyUploaded.delete(nodeUid), SUPPRESS_MS);

    // Persist to DB.
    await invoke("upsert_file_state", {
      remoteId: nodeUid,
      localPath: absPath,
      etag: null,
      modifiedAt: Date.now(),
      sizeBytes: bytes.length,
      syncState: "synced",
    });

    invoke("show_notification", {
      title: "Proton Drive Sync",
      body: `Lastet opp: ${filename}`,
    }).catch(() => {});
    console.log("[sync] uploaded:", absPath, "→", nodeUid);
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
    const { nodeUid } = event;
    if (recentlyUploaded.has(nodeUid)) {
      console.log("[sync] suppressed drive event for own upload:", nodeUid);
      return;
    }
    await handleRemoteNodeUpdate(nodeUid, syncRoot);
  } else if (event.type === DriveEventType.NodeDeleted) {
    await handleRemoteDelete(event.nodeUid, syncRoot);
  } else {
    console.log("[sync] skipping drive event type:", event.type);
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

    // Only handle files in MVP.
    if (node.type !== NodeType.File) {
      console.log("[sync] skipping non-file node:", nodeUid, node.type);
      return;
    }

    // Download.
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

    // Flat layout for MVP: syncRoot/filename
    const absPath = `${syncRoot}/${node.name}`;

    // Suppress inotify so we don't re-upload what we just wrote.
    suppressPath(absPath);

    await invoke("write_local_file", { absPath, contentB64: b64 });

    const revision = node.activeRevision;
    await invoke("upsert_file_state", {
      remoteId: nodeUid,
      localPath: absPath,
      etag: revision?.uid ?? null,
      modifiedAt: node.modificationTime.getTime(),
      sizeBytes: revision?.claimedSize ?? null,
      syncState: "synced",
    });

    invoke("show_notification", {
      title: "Proton Drive Sync",
      body: `Lastet ned: ${node.name}`,
    }).catch(() => {});
    console.log("[sync] downloaded remote node:", nodeUid, "→", absPath);
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
