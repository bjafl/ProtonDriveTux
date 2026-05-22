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
  getFileDownloader,
  subscribeToTreeEvents,
  getNode,
  listFolderChildren,
  persistEventAnchor,
} from "./drive";

// ── Types ────────────────────────────────────────────────────────────────────

interface WatchEvent {
  absPath: string;
  kind: "create" | "modify" | "delete";
}

export interface SyncStatus {
  active: string[];
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

export interface SelectedFolderRecord {
  uid: string;
  name: string;
  drivePath: string; // relative to My Files root, e.g. "Work/Projects"
  mode: "files" | "recursive";
}

interface WatchedFolderEntry {
  localDir: string;            // absolute local path for this Drive folder
  selectedRoot: SelectedFolderRecord;
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

let _localRoot: string | null = null;

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

async function waitForFileStable(absPath: string): Promise<FileStat | null> {
  const first = await statFile(absPath);
  if (!first) return null;
  await new Promise<void>((r) => setTimeout(r, 1_000));
  const second = await statFile(absPath);
  if (!second) return null;
  if (second.mtimeMs === first.mtimeMs && second.sizeBytes === first.sizeBytes) return second;
  await new Promise<void>((r) => setTimeout(r, 1_000));
  return statFile(absPath);
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

/** Find the best-matching watched folder entry for a local absolute path. */
function findWatchedFolderByLocalPath(
  absPath: string,
): { uid: string; entry: WatchedFolderEntry } | null {
  let best: { uid: string; entry: WatchedFolderEntry; len: number } | null = null;
  for (const [uid, entry] of watchedFolderUids) {
    if (absPath === entry.localDir || absPath.startsWith(entry.localDir + "/")) {
      if (!best || entry.localDir.length > best.len) {
        best = { uid, entry, len: entry.localDir.length };
      }
    }
  }
  return best ? { uid: best.uid, entry: best.entry } : null;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startSync(): Promise<() => void> {
  console.log("[sync] Loading sync config from DB…");
  const { localRoot, selectedFolders, treeEventScopeId } = await loadSyncConfig();
  _localRoot = localRoot;

  console.log(
    "[sync] Building watched folder map,",
    selectedFolders.length,
    "selected folder(s)…",
  );
  await buildWatchedFolderMap(selectedFolders, localRoot);
  console.log("[sync] Watching", watchedFolderUids.size, "Drive folder(s)");

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

  return () => {
    unlisten();
    subscription.dispose();
    watchedFolderUids.clear();
    _localRoot = null;
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
    try {
      const files = await invoke<string[]>("list_local_dir", { absPath: entry.localDir });
      for (const absPath of files) {
        await handleLocalUpsert(absPath, false);
      }
    } catch (err) {
      console.error("[sync] Local folder scan failed for", entry.localDir, err);
    }
  }
}

// ── Local → Remote ───────────────────────────────────────────────────────────

async function handleLocalChange(event: WatchEvent): Promise<void> {
  const { absPath, kind } = event;

  if (isSuppressed(absPath)) {
    console.log("[sync] suppressed local event for", absPath);
    return;
  }

  if (kind === "delete") {
    console.log("[sync] skipping local delete (MVP safety):", absPath);
    return;
  }

  await handleLocalUpsert(absPath, true);
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

    if (existing?.sizeBytes !== null && existing && stat.sizeBytes === existing.sizeBytes) {
      console.log("[sync] skipping upload — size unchanged:", absPath);
      return;
    }

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
      try {
        const uploader = await getFileRevisionUploader(existing.remoteId, metadata);
        const controller = await uploader.uploadFromFile(file, [], () => {});
        ({ nodeUid, nodeRevisionUid } = await controller.completion());
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

async function handleDriveEvent(event: DriveEvent): Promise<void> {
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

  if ("treeEventScopeId" in event && "eventId" in event) {
    persistEventAnchor(event.treeEventScopeId, event.eventId).catch(() => {});
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

    if (node.type !== NodeType.File) {
      console.log("[sync] skipping non-file node:", nodeUid, node.type);
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
        await invoke("trash_local_file", {
          absPath: existing.localPath,
          syncRoot: _localRoot ?? "",
        });
      }
    }

    const downloader = await getFileDownloader(nodeUid);
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(new Uint8Array(chunk));
      },
    });
    const dlController = downloader.downloadToStream(writable, () => {});
    await dlController.completion();

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

async function handleRemoteDelete(nodeUid: string): Promise<void> {
  try {
    const fileState = await invoke<FileState | null>("get_file_state_by_remote_id", {
      remoteId: nodeUid,
    });

    if (!fileState) {
      console.log("[sync] remote delete for unknown node (not tracked):", nodeUid);
      return;
    }

    suppressPath(fileState.localPath);
    await invoke("trash_local_file", {
      absPath: fileState.localPath,
      syncRoot: _localRoot ?? "",
    });
    await invoke("set_file_sync_state", { remoteId: nodeUid, syncState: "deleted" });

    console.log("[sync] trashed local file:", fileState.localPath, "(remote:", nodeUid, ")");
  } catch (err) {
    console.error("[sync] remote delete failed for", nodeUid, err);
    recordError(nodeUid, String(err));
  }
}
