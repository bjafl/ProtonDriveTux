import {
  getFileStateByRemoteId,
  ensureLocalDir,
  listDirRecursive,
  listLocalDir,
  getAllFileStates,
  deleteFileState,
  showNotification,
} from "../ipcApi";
import { listFolderChildren } from "../drive";
import { NodeType } from "@protontech/drive-sdk";
import {
  watchedFolderUids,
  markActive,
  markInactive,
  recordError,
  statFile,
  _fullSyncInProgress,
  setFullSyncInProgress,
  FULL_SYNC_LABEL,
} from "./state";
import type { FileState } from "./state";
import { handleRemoteNodeUpdate } from "./remote-to-local";
import { handleLocalUpsert } from "./local-to-remote";
import { downloadSemaphore, uploadSemaphore } from "./concurrency";

// ── Initial sync ─────────────────────────────────────────────────────────────

export async function initialSyncFolder(): Promise<void> {
  const toDownload: string[] = [];

  for (const [folderUid, entry] of watchedFolderUids) {
    console.log("[sync] Scanning remote folder:", entry.localDir);
    try {
      for await (const result of listFolderChildren(folderUid, { type: NodeType.File })) {
        if (!result.ok) {
          console.warn("[sync] Error enumerating child:", result.error);
          continue;
        }
        const node = result.value;
        const existing = await getFileStateByRemoteId(node.uid);
        if (existing) {
          // If activeRevision is absent, conservatively re-download — could be a draft/in-progress revision.
          const remoteRevUid = node.activeRevision?.uid;
          if (remoteRevUid && remoteRevUid === existing.etag) continue;
        }
        toDownload.push(node.uid);
      }
    } catch (err) {
      console.error("[sync] Folder scan failed for", entry.localDir, err);
    }
  }

  let downloaded = 0;
  await Promise.all(
    toDownload.map((uid) =>
      downloadSemaphore.run(async () => {
        await handleRemoteNodeUpdate(uid, true);
        downloaded++;
      }).catch((err) => console.warn("[sync] download failed for", uid, err)),
    ),
  );

  if (downloaded === 1) {
    showNotification("Proton Drive Sync", "Downloaded 1 file").catch(() => {});
  } else if (downloaded > 1) {
    showNotification("Proton Drive Sync", `Downloaded ${downloaded} files`).catch(() => {});
  }
}

export async function initialSyncLocalFolder(): Promise<void> {
  const toUpload: string[] = [];

  for (const [, entry] of watchedFolderUids) {
    console.log("[sync] Scanning local folder:", entry.localDir);
    await ensureLocalDir(entry.localDir).catch(console.error);
    try {
      if (entry.selectedRoot.mode === "recursive") {
        const files = await listDirRecursive(entry.localDir);
        for (const f of files) {
          toUpload.push(f.absPath);
        }
      } else {
        const files = await listLocalDir(entry.localDir);
        for (const absPath of files) {
          toUpload.push(absPath);
        }
      }
    } catch (err) {
      console.error("[sync] Local folder scan failed for", entry.localDir, err);
    }
  }

  let uploaded = 0;
  await Promise.all(
    toUpload.map((absPath) =>
      uploadSemaphore.run(async () => {
        const wasUploaded = await handleLocalUpsert(absPath, false, true);
        if (wasUploaded) uploaded++;
      }).catch((err) => console.warn("[sync] upload failed for", absPath, err)),
    ),
  );

  if (uploaded === 1) {
    showNotification("Proton Drive Sync", "Uploaded 1 file").catch(() => {});
  } else if (uploaded > 1) {
    showNotification("Proton Drive Sync", `Uploaded ${uploaded} files`).catch(() => {});
  }
}

// ── Full reconciliation ───────────────────────────────────────────────────────

/** @internal */
export async function cleanStaleDbEntries(): Promise<void> {
  const allFiles = await getAllFileStates();
  for (const f of allFiles) {
    const stat = await statFile(f.localPath);
    if (!stat) {
      console.log("[sync] removing stale DB entry:", f.localPath);
      await deleteFileState(f.remoteId).catch(console.error);
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
  setFullSyncInProgress(true);
  markActive(FULL_SYNC_LABEL);
  console.log("[sync] Starting full reconciliation…");
  try {
    await cleanStaleDbEntries();
    await Promise.all([initialSyncFolder(), initialSyncLocalFolder()]);
    console.log("[sync] Full reconciliation complete");
  } catch (err) {
    console.error("[sync] Full reconciliation failed:", err);
    recordError("(full sync)", String(err));
  } finally {
    setFullSyncInProgress(false);
    markInactive(FULL_SYNC_LABEL);
  }
}

// Keep FileState in scope for any local use (imported via state re-export)
export type { FileState };
