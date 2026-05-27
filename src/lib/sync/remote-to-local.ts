import {
  ensureLocalDir,
  getFileStateByRemoteId,
  renameLocalFile,
  upsertFileState,
  deleteLocalFile,
  deleteFileState,
  getAllFileStates,
  deleteLocalDir,
  showNotification,
} from "../ipcApi";
import { getNode, streamDownloadToPath, persistEventAnchor } from "../drive";
import { NodeType, DriveEventType } from "@protontech/drive-sdk";
import type { DriveEvent } from "@protontech/drive-sdk";
import {
  watchedFolderUids,
  suppressPath,
  recentlyUploaded,
  markActive,
  markInactive,
  recordError,
  addRecentlySynced,
  _paused,
  _fullSyncInProgress,
} from "./state";
import { downloadQueue } from "./concurrency";
// ── Remote → Local ───────────────────────────────────────────────────────────

export async function handleDriveEvent(
  event: DriveEvent,
  onFullRefresh: () => Promise<void>,
): Promise<void> {
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

    downloadQueue.enqueue(event.nodeUid, () => handleRemoteNodeUpdate(event.nodeUid));
  } else if (event.type === DriveEventType.NodeDeleted) {
    await handleRemoteDelete(event.nodeUid);
  } else if (
    event.type === DriveEventType.TreeRefresh ||
    event.type === DriveEventType.FastForward
  ) {
    if (!_fullSyncInProgress) {
      console.log("[sync] received", event.type, "— triggering full folder re-scan");
      onFullRefresh().catch(console.error);
    } else {
      console.log("[sync] received", event.type, "— full sync already in progress, skipping");
    }
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

/** @internal */
export async function handleRemoteNodeUpdate(nodeUid: string, silent = false): Promise<void> {
  if (_paused) {
    console.log("[sync] paused — skipping download:", nodeUid);
    return;
  }
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
      await ensureLocalDir(localDir).catch(console.error);
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

    const existing = await getFileStateByRemoteId(nodeUid);

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
        await renameLocalFile(existing.localPath, expectedPath);
        await upsertFileState({
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
        await deleteLocalFile(existing.localPath);
      }
    }

    await streamDownloadToPath(nodeUid, expectedPath, () => suppressPath(expectedPath));
    addRecentlySynced(expectedPath, "down");

    const revision = node.activeRevision;
    await upsertFileState({
      remoteId: nodeUid,
      localPath: expectedPath,
      etag: revision?.uid ?? null,
      modifiedAt: node.modificationTime.getTime(),
      sizeBytes: revision?.claimedSize ?? null,
      syncState: "synced",
    });

    if (!silent) {
      showNotification("Proton Drive Sync", `Downloaded: ${node.name}`).catch(() => {});
    }
    console.log("[sync] downloaded remote node:", nodeUid, "→", expectedPath);
  } catch (err) {
    console.error("[sync] download failed for node", nodeUid, err);
    recordError(nodeUid, String(err));
  } finally {
    markInactive(label);
  }
}

/** @internal */
export async function handleRemoteDelete(nodeUid: string): Promise<void> {
  try {
    // 1. Known file in DB
    const fileState = await getFileStateByRemoteId(nodeUid);
    if (fileState) {
      suppressPath(fileState.localPath);
      await deleteLocalFile(fileState.localPath);
      await deleteFileState(nodeUid);
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
  const allFiles = await getAllFileStates();
  for (const f of allFiles) {
    if (f.localPath === localDir || f.localPath.startsWith(localDir + "/")) {
      await deleteFileState(f.remoteId).catch(console.error);
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
  await deleteLocalDir(localDir);
  console.log("[sync] deleted local directory:", localDir, "(remote:", folderUid, ")");
}
