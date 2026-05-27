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
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { ensureLocalDir } from "../ipcApi";
import { subscribeToTreeEvents } from "../drive";
import type { DriveEvent } from "@protontech/drive-sdk";
import { findWatchedFolderByPath } from "../syncHelpers";

import { loadSyncConfig, buildWatchedFolderMap } from "./config";
import { handleLocalChange } from "./local-to-remote";
import { handleDriveEvent } from "./remote-to-local";
import {
  initialSyncFolder,
  initialSyncLocalFolder,
  triggerFullSync,
} from "./reconciliation";
import {
  suppressUntil,
  recentlyUploaded,
  watchedFolderUids,
} from "./state";
import { uploadQueue } from "./concurrency";
import type { WatchEvent } from "./state";

// ── Re-export entire public API ──────────────────────────────────────────────
export type { WatchEvent, SyncStatus, FileState } from "./state";
export type { WatchedFolderEntry, SelectedFolderRecord } from "./state";
export {
  pauseSync,
  resumeSync,
  isSyncPaused,
  getSyncStatus,
  setSyncStatusCallback,
  _resetSyncStateForTesting,
  _setWatchedFoldersForTesting,
} from "./state";
export { expandFolderUids, waitForFileStable } from "./config";
export { handleLocalChange, handleLocalUpsert } from "./local-to-remote";
export { handleRemoteNodeUpdate, handleRemoteDelete } from "./remote-to-local";
export { triggerFullSync, cleanStaleDbEntries } from "./reconciliation";
export { findWatchedFolderByPath };

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
    await ensureLocalDir(entry.localDir).catch(console.error);
  }

  await Promise.all([initialSyncFolder(), initialSyncLocalFolder()]);

  const subscription = await subscribeToTreeEvents(
    treeEventScopeId,
    (event: DriveEvent) => {
      return handleDriveEvent(event, initialSyncFolder).catch((err) => {
        console.error("[sync] Unhandled error in drive event handler:", err);
      });
    },
  );

  const unlisten: UnlistenFn = await listen<WatchEvent>("sync://local-change", (e) => {
    if (e.payload.absPath.endsWith(".pd-tmp")) return;
    uploadQueue.enqueue(e.payload.absPath, () => handleLocalChange(e.payload));
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
