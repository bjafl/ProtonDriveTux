import {
  getFileStateByRemoteId,
  ensureLocalDir,
  listDirRecursive,
  listLocalDir,
  getAllFileStates,
  deleteFileState,
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

// ── Initial sync ─────────────────────────────────────────────────────────────

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
        const existing = await getFileStateByRemoteId(node.uid);
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
    await ensureLocalDir(entry.localDir).catch(console.error);
    try {
      if (entry.selectedRoot.mode === "recursive") {
        const files = await listDirRecursive(entry.localDir);
        for (const f of files) {
          await handleLocalUpsert(f.absPath, false);
        }
      } else {
        const files = await listLocalDir(entry.localDir);
        for (const absPath of files) {
          await handleLocalUpsert(absPath, false);
        }
      }
    } catch (err) {
      console.error("[sync] Local folder scan failed for", entry.localDir, err);
    }
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

// Keep FileState in scope for any local use (imported via state re-export)
export type { FileState };
