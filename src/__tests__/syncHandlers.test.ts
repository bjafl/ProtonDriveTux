// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleLocalChange,
  _resetSyncStateForTesting,
  _setWatchedFoldersForTesting,
  pauseSync,
  type WatchedFolderEntry,
} from "../lib/sync";
import { setupIpcMocks, teardownIpcMocks } from "./helpers/syncMocks";

vi.mock("../lib/drive", () => ({
  getSyncRoot: vi.fn(),
  getNode: vi.fn(),
  getFileUploader: vi.fn(),
  getFileRevisionUploader: vi.fn(),
  streamDownloadToPath: vi.fn(),
  trashNode: vi.fn(),
  findOrCreateFolder: vi.fn(),
  listFolderChildren: vi.fn(),
  persistEventAnchor: vi.fn(),
  subscribeToTreeEvents: vi.fn(),
}));

// sync.ts imports DriveEventType and NodeType directly from the SDK.
// Mock the SDK to avoid loading its TS source (which Vite cannot transform
// in the jsdom worker context).
vi.mock("@protontech/drive-sdk", () => ({
  DriveEventType: { Create: "create", Update: "update", Delete: "delete", Move: "move" },
  NodeType: { File: "file", Folder: "folder" },
}));

import {
  trashNode,
  findOrCreateFolder,
  streamDownloadToPath,
  getNode,
  getFileUploader,
  getFileRevisionUploader,
} from "../lib/drive";

const ROOT = "/home/test/ProtonDrive";
const FOLDER_UID = "folder-uid-1";

function makeWatchedFolders(): Map<string, WatchedFolderEntry> {
  return new Map([
    [
      FOLDER_UID,
      {
        localDir: ROOT,
        selectedRoot: {
          uid: FOLDER_UID,
          name: "ProtonDrive",
          drivePath: "",
          mode: "files",
        },
      },
    ],
  ]);
}

beforeEach(() => {
  _resetSyncStateForTesting();
  _setWatchedFoldersForTesting(makeWatchedFolders());
  setupIpcMocks({
    stat_local_file: () => ({ mtimeMs: 1000, sizeBytes: 100, isDir: false }),
  });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  teardownIpcMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ── handleLocalChange ─────────────────────────────────────────────────────────

describe("handleLocalChange", () => {
  it("returns early for .pd-tmp paths without touching IPC or fetch", async () => {
    const mockFetch = vi.mocked(fetch);
    await handleLocalChange({ absPath: `${ROOT}/file.txt.pd-tmp`, kind: "create" });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(trashNode).not.toHaveBeenCalled();
  });

  it("returns early when sync is paused", async () => {
    pauseSync();
    const mockFetch = vi.mocked(fetch);
    await handleLocalChange({ absPath: `${ROOT}/file.txt`, kind: "create" });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls trashNode for delete events on a known file", async () => {
    setupIpcMocks({
      get_file_state_by_local_path: () => ({
        remoteId: "node-1",
        localPath: `${ROOT}/file.txt`,
        etag: "rev-1",
        modifiedAt: 1000,
        sizeBytes: 100,
        syncState: "synced",
      }),
      delete_file_state: () => null,
    });
    vi.mocked(trashNode).mockResolvedValue(undefined);

    await handleLocalChange({ absPath: `${ROOT}/file.txt`, kind: "delete" });

    expect(trashNode).toHaveBeenCalledWith("node-1");
  });

  it("calls findOrCreateFolder for directory create events", async () => {
    setupIpcMocks({
      stat_local_file: () => ({ mtimeMs: 0, sizeBytes: 0, isDir: true }),
    });
    vi.mocked(findOrCreateFolder).mockResolvedValue({
      ok: true,
      value: { uid: "new-dir-uid" },
    } as never);

    await handleLocalChange({ absPath: `${ROOT}/newdir`, kind: "create" });

    expect(findOrCreateFolder).toHaveBeenCalledWith(FOLDER_UID, "newdir");
  });
});
