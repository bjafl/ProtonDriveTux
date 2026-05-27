import {
  getFileStateByLocalPath,
  getAllFileStates,
  deleteFileState,
  readLocalFile,
  upsertFileState,
  showNotification,
} from "../ipcApi";
import {
  getFileUploader,
  getFileRevisionUploader,
  trashNode,
  findOrCreateFolder,
} from "../drive";
import { findWatchedFolderByPath } from "../syncHelpers";
import { guessMimeType, isAlreadySynced } from "../syncDecisions";
import {
  watchedFolderUids,
  isSuppressed,
  markUploaded,
  markActive,
  markInactive,
  recordError,
  addRecentlySynced,
  statFile,
  _paused,
} from "./state";
import type { WatchEvent } from "./state";
import { waitForFileStable } from "./config";

export type { WatchEvent };

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

// ── Local → Remote ───────────────────────────────────────────────────────────

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

  const existing = await getFileStateByLocalPath(absPath);
  if (!existing) {
    console.log("[sync] local delete: no DB entry for", absPath, "— skipping");
    return;
  }
  const label = absPath;
  markActive(label);
  try {
    await trashNode(existing.remoteId);
    await deleteFileState(existing.remoteId);
    console.log("[sync] trashed remote node for deleted local file:", absPath);
  } catch (err) {
    console.error("[sync] Failed to trash remote node for", absPath, err);
    recordError(absPath, String(err));
  } finally {
    markInactive(label);
  }
}

async function handleLocalDirDeleteToRemote(
  folderUid: string,
  localDir: string,
): Promise<void> {
  markActive(localDir);
  try {
    await trashNode(folderUid);
    // Prune watchedFolderUids for this dir and all its subdirs.
    for (const [uid, entry] of watchedFolderUids) {
      if (
        entry.localDir === localDir ||
        entry.localDir.startsWith(localDir + "/")
      ) {
        watchedFolderUids.delete(uid);
      }
    }
    // Clean up any remaining DB rows under this tree (files may already be gone).
    const allFiles = await getAllFileStates();
    for (const f of allFiles) {
      if (f.localPath === localDir || f.localPath.startsWith(localDir + "/")) {
        await deleteFileState(f.remoteId).catch(console.error);
      }
    }
    console.log(
      "[sync] trashed remote dir for deleted local dir:",
      localDir,
      "(uid:",
      folderUid,
      ")",
    );
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
      watchedFolderUids.set(folderUid, {
        localDir: absPath,
        selectedRoot: match.entry.selectedRoot,
      });
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
export async function handleLocalUpsert(
  absPath: string,
  checkStability: boolean,
  silent = false,
): Promise<boolean> {
  if (_paused) {
    console.log("[sync] paused — skipping upload:", absPath);
    return false;
  }

  const match = findWatchedFolderByLocalPath(absPath);
  if (!match) {
    console.log("[sync] file not in any watched folder, skipping:", absPath);
    return false;
  }
  const targetFolderUid = match.uid;

  const label = absPath;
  markActive(label);
  try {
    const stat = checkStability
      ? await waitForFileStable(absPath)
      : await statFile(absPath);
    if (!stat) {
      console.log("[sync] skipping (file disappeared or unreadable):", absPath);
      return false;
    }

    const existing = await getFileStateByLocalPath(absPath);

    if (isAlreadySynced(stat, existing)) {
      console.log(
        "[sync] skipping upload — size and mtime unchanged:",
        absPath,
      );
      return false;
    }

    const fileRawData = await readLocalFile(absPath);
    const filename = absPath.split("/").pop() ?? absPath;
    const file = new File([fileRawData], filename, {
      lastModified: stat.mtimeMs,
    });
    const metadata = {
      mediaType: guessMimeType(filename),
      expectedSize: file.size,
      modificationTime: new Date(stat.mtimeMs),
    };

    let nodeUid: string;
    let nodeRevisionUid: string;

    if (existing) {
      try {
        const uploader = await getFileRevisionUploader(
          existing.remoteId,
          metadata,
        );
        const controller = await uploader.uploadFromFile(file, [], () => {});
        ({ nodeUid, nodeRevisionUid } = await controller.completion());
        markUploaded(nodeUid);
        console.log(
          "[sync] uploaded revision:",
          absPath,
          "→",
          nodeUid,
          "rev:",
          nodeRevisionUid,
        );
      } catch (err) {
        const msg = String(err);
        if (
          msg.includes("not enabled for Documents") ||
          msg.includes("Revision is currently")
        ) {
          console.log(
            "[sync] skipping Docs node (revision upload not supported):",
            absPath,
          );
          return false;
        }
        throw err;
      }
    } else {
      const uploader = await getFileUploader(
        targetFolderUid,
        filename,
        metadata,
      );
      const controller = await uploader.uploadFromFile(file, [], () => {});
      ({ nodeUid, nodeRevisionUid } = await controller.completion());
      markUploaded(nodeUid);
      console.log(
        "[sync] uploaded new file:",
        absPath,
        "→",
        nodeUid,
        "rev:",
        nodeRevisionUid,
      );
    }

    await upsertFileState({
      remoteId: nodeUid,
      localPath: absPath,
      etag: nodeRevisionUid,
      modifiedAt: stat.mtimeMs,
      sizeBytes: file.size,
      syncState: "synced",
    });

    addRecentlySynced(absPath, "up");

    if (!silent) {
      showNotification(
        "Proton Drive Sync",
        `${existing ? "Updated" : "Uploaded"}: ${filename}`,
      ).catch(() => {});
    }

    return true;
  } catch (err) {
    console.error("[sync] upload failed for", absPath, err);
    recordError(absPath, String(err));
    return false;
  } finally {
    markInactive(label);
  }
}
