import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  startSync, setSyncStatusCallback, triggerFullSync, pauseSync, resumeSync, isSyncPaused,
} from "../lib/sync";
import type { SyncStatus, WatchEvent, SelectedFolderRecord } from "../lib/sync";
import { setSessionExpiredCallback, releaseDriveClient } from "../lib/drive";
import { defaultSyncPath } from "../lib/paths";

interface LocalEvent {
  absPath: string;
  kind: string;
  time: string;
}

interface SyncStatusHookResult {
  syncStatus: SyncStatus;
  syncPaused: boolean;
  syncPath: string;
  driveFolders: string[];
  localEvents: LocalEvent[];
  syncingFull: boolean;
  handleLogout: () => Promise<void>;
  handleFullSync: () => Promise<void>;
  togglePause: () => void;
}

export function useSyncStatus(
  onSessionExpired: () => void,
  onFileStatesChanged: () => void,
): SyncStatusHookResult {
  const [syncPath, setSyncPath] = useState<string>("");
  const [driveFolders, setDriveFolders] = useState<string[]>([]);
  const [localEvents, setLocalEvents] = useState<LocalEvent[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ active: [], errors: [] });
  const [syncingFull, setSyncingFull] = useState(false);
  const [syncPaused, setSyncPaused] = useState(false);
  const stopSyncRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlistenLocal: (() => void) | null = null;
    let unlistenPauseTray: (() => void) | null = null;

    // Wire up session-expired callback so a dead refresh token triggers re-login.
    setSessionExpiredCallback(onSessionExpired);

    async function init() {
      const [localRoot, selectedFoldersJson] = await Promise.all([
        invoke<string | null>("get_local_root"),
        invoke<string | null>("get_db_sync_config", { key: "selected_folders" }),
      ]);
      if (cancelled) return;

      if (selectedFoldersJson) {
        try {
          const folders = JSON.parse(selectedFoldersJson) as SelectedFolderRecord[];
          setDriveFolders(folders.map((f) => f.name));
        } catch { /* ignore malformed JSON */ }
      }

      // No root configured yet — onboarding will set one.
      if (!localRoot) {
        setSyncPath(await defaultSyncPath());
        return;
      }
      setSyncPath(localRoot);

      setSyncStatusCallback((s) => {
        if (!cancelled) {
          setSyncStatus({ ...s });
          onFileStatesChanged();
        }
      });

      await invoke("start_file_watcher", { path: localRoot }).catch(console.error);
      const stop = await startSync();
      if (cancelled) { stop(); return; }
      stopSyncRef.current = stop;

      onFileStatesChanged();

      unlistenPauseTray = await listen("sync://pause-toggle", () => {
        if (cancelled) return;
        if (isSyncPaused()) {
          resumeSync();
          setSyncPaused(false);
        } else {
          pauseSync();
          setSyncPaused(true);
        }
      });

      unlistenLocal = await listen<WatchEvent>("sync://local-change", (e) => {
        if (cancelled) return;
        setLocalEvents((prev) =>
          [
            { absPath: e.payload.absPath, kind: e.payload.kind, time: new Date().toLocaleTimeString() },
            ...prev,
          ].slice(0, 30),
        );
      });
    }

    init().catch(console.error);

    return () => {
      cancelled = true;
      setSessionExpiredCallback(null);
      unlistenPauseTray?.();
      unlistenLocal?.();
      stopSyncRef.current?.();
      stopSyncRef.current = null;
    };
  }, [onSessionExpired, onFileStatesChanged]);

  const handleLogout = async () => {
    await invoke("logout").catch(console.error);
    releaseDriveClient();
    window.location.reload();
  };

  const handleFullSync = async () => {
    setSyncingFull(true);
    try {
      await triggerFullSync();
    } finally {
      setSyncingFull(false);
    }
  };

  const togglePause = () => {
    if (syncPaused) { resumeSync(); setSyncPaused(false); }
    else { pauseSync(); setSyncPaused(true); }
  };

  return { syncStatus, syncPaused, syncPath, driveFolders, localEvents, syncingFull, handleLogout, handleFullSync, togglePause };
}
