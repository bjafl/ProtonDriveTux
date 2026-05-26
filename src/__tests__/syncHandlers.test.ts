// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleLocalChange,
  handleLocalUpsert,
  handleRemoteDelete,
  handleRemoteNodeUpdate,
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
  getFileUploader,
  getFileRevisionUploader,
  getNode,
  streamDownloadToPath,
} from "../lib/drive";
import { NodeType } from "@protontech/drive-sdk";

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

// ── handleLocalUpsert ─────────────────────────────────────────────────────────

describe("handleLocalUpsert", () => {
  it("skips file not in any watched folder", async () => {
    const mockFetch = vi.mocked(fetch);
    await handleLocalUpsert("/home/test/outside-root/file.txt", false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("skips upload when size and mtime are unchanged", async () => {
    setupIpcMocks({
      stat_local_file: () => ({ mtimeMs: 1000, sizeBytes: 100, isDir: false }),
      get_file_state_by_local_path: () => ({
        remoteId: "node-1",
        localPath: `${ROOT}/file.txt`,
        etag: "rev-1",
        modifiedAt: 1000,
        sizeBytes: 100,
        syncState: "synced",
      }),
    });
    const mockFetch = vi.mocked(fetch);
    await handleLocalUpsert(`${ROOT}/file.txt`, false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls getFileUploader for a new file (no DB entry) and upserts DB", async () => {
    const mockController = {
      completion: vi.fn().mockResolvedValue({ nodeUid: "new-uid", nodeRevisionUid: "new-rev" }),
    };
    vi.mocked(getFileUploader).mockResolvedValue({
      uploadFromFile: vi.fn().mockResolvedValue(mockController),
    } as never);

    let upsertedState: unknown;
    setupIpcMocks({
      stat_local_file: () => ({ mtimeMs: 2000, sizeBytes: 5, isDir: false }),
      get_file_state_by_local_path: () => null,
      read_local_file: () => new Uint8Array(5),
      upsert_file_state: (args) => {
        upsertedState = args;
        return null;
      },
      show_notification: () => null,
    });

    await handleLocalUpsert(`${ROOT}/file.txt`, false);

    expect(getFileUploader).toHaveBeenCalledWith(
      FOLDER_UID,
      "file.txt",
      expect.objectContaining({
        mediaType: "text/plain",
        expectedSize: 5,
        modificationTime: expect.any(Date),
      }),
    );
    expect(upsertedState).toMatchObject({
      remoteId: "new-uid",
      localPath: `${ROOT}/file.txt`,
      etag: "new-rev",
      modifiedAt: 2000,
      sizeBytes: 5,
      syncState: "synced",
    });
  });

  it("calls getFileRevisionUploader for an existing file", async () => {
    const mockController = {
      completion: vi.fn().mockResolvedValue({ nodeUid: "node-1", nodeRevisionUid: "rev-2" }),
    };
    vi.mocked(getFileRevisionUploader).mockResolvedValue({
      uploadFromFile: vi.fn().mockResolvedValue(mockController),
    } as never);

    let upsertedRevState: unknown;
    setupIpcMocks({
      stat_local_file: () => ({ mtimeMs: 3000, sizeBytes: 7, isDir: false }),
      get_file_state_by_local_path: () => ({
        remoteId: "node-1",
        localPath: `${ROOT}/file.txt`,
        etag: "rev-1",
        modifiedAt: 1000,
        sizeBytes: 5,
        syncState: "synced",
      }),
      read_local_file: () => new Uint8Array(7),
      upsert_file_state: (args) => {
        upsertedRevState = args;
        return null;
      },
      show_notification: () => null,
    });

    await handleLocalUpsert(`${ROOT}/file.txt`, false);

    expect(getFileRevisionUploader).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({
        mediaType: "text/plain",
        expectedSize: 7,
        modificationTime: expect.any(Date),
      }),
    );
    expect(upsertedRevState).toMatchObject({
      remoteId: "node-1",
      etag: "rev-2",
      modifiedAt: 3000,
      sizeBytes: 7,
      syncState: "synced",
    });
  });

  it("skips upload when waitForFileStable returns null (file disappeared)", async () => {
    // null on first stat triggers waitForFileStable's fast-exit (no setTimeout delay needed)
    setupIpcMocks({
      stat_local_file: () => null,
    });
    const mockFetch = vi.mocked(fetch);
    await handleLocalUpsert(`${ROOT}/file.txt`, true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── handleRemoteDelete ────────────────────────────────────────────────────────

describe("handleRemoteDelete", () => {
  it("deletes local file and DB entry when node is a known file", async () => {
    const deletedPaths: string[] = [];
    const deletedIds: string[] = [];
    setupIpcMocks({
      get_file_state_by_remote_id: ({ remoteId }) =>
        remoteId === "node-1"
          ? {
              remoteId: "node-1",
              localPath: `${ROOT}/file.txt`,
              etag: "rev-1",
              modifiedAt: 1000,
              sizeBytes: 100,
              syncState: "synced",
            }
          : null,
      delete_local_file: ({ absPath }) => {
        deletedPaths.push(absPath as string);
        return null;
      },
      delete_file_state: ({ remoteId }) => {
        deletedIds.push(remoteId as string);
        return null;
      },
    });

    await handleRemoteDelete("node-1");

    expect(deletedPaths).toEqual([`${ROOT}/file.txt`]);
    expect(deletedIds).toEqual(["node-1"]);
  });

  it("deletes local directory when node is in watchedFolderUids", async () => {
    const subDirUid = "subdir-uid";
    _setWatchedFoldersForTesting(
      new Map([
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
        [
          subDirUid,
          {
            localDir: `${ROOT}/subdir`,
            selectedRoot: {
              uid: FOLDER_UID,
              name: "ProtonDrive",
              drivePath: "",
              mode: "files",
            },
          },
        ],
      ]),
    );

    const deletedDirs: string[] = [];
    setupIpcMocks({
      get_file_state_by_remote_id: () => null,
      get_all_file_states: () => [],
      delete_local_dir: ({ absPath }) => {
        deletedDirs.push(absPath as string);
        return null;
      },
    });

    await handleRemoteDelete(subDirUid);

    expect(deletedDirs).toContain(`${ROOT}/subdir`);

    // Verify the entry was removed from the in-memory watched-folder map:
    // a second call should not trigger delete_local_dir again.
    await handleRemoteDelete(subDirUid);
    expect(deletedDirs).toHaveLength(1);
  });

  it("resolves unknown node via getNode and deletes inferred local directory", async () => {
    vi.mocked(getNode).mockResolvedValue({
      ok: true,
      value: {
        uid: "unknown-dir",
        name: "discovered",
        type: NodeType.Folder,
        parentUid: FOLDER_UID,
        activeRevision: null,
        modificationTime: new Date(),
      },
    } as never);

    const deletedDirs: string[] = [];
    setupIpcMocks({
      get_file_state_by_remote_id: () => null,
      get_all_file_states: () => [],
      delete_local_dir: ({ absPath }) => {
        deletedDirs.push(absPath as string);
        return null;
      },
    });

    await handleRemoteDelete("unknown-dir");

    expect(getNode).toHaveBeenCalledWith("unknown-dir");
    expect(deletedDirs).toContain(`${ROOT}/discovered`);
  });
});

// ── handleRemoteNodeUpdate ────────────────────────────────────────────────────

describe("handleRemoteNodeUpdate", () => {
  it("skips node whose parentUid is not in watchedFolderUids", async () => {
    vi.mocked(getNode).mockResolvedValue({
      ok: true,
      value: {
        uid: "node-1",
        name: "file.txt",
        type: NodeType.File,
        parentUid: "unknown-folder",
        activeRevision: { uid: "rev-1", claimedSize: 100 },
        modificationTime: new Date(1000),
      },
    } as never);

    await handleRemoteNodeUpdate("node-1");

    expect(streamDownloadToPath).not.toHaveBeenCalled();
  });

  it("skips download when revision matches existing DB entry", async () => {
    vi.mocked(getNode).mockResolvedValue({
      ok: true,
      value: {
        uid: "node-1",
        name: "file.txt",
        type: NodeType.File,
        parentUid: FOLDER_UID,
        activeRevision: { uid: "rev-1", claimedSize: 100 },
        modificationTime: new Date(1000),
      },
    } as never);
    setupIpcMocks({
      get_file_state_by_remote_id: () => ({
        remoteId: "node-1",
        localPath: `${ROOT}/file.txt`,
        etag: "rev-1",
        modifiedAt: 1000,
        sizeBytes: 100,
        syncState: "synced",
      }),
    });

    await handleRemoteNodeUpdate("node-1");

    expect(streamDownloadToPath).not.toHaveBeenCalled();
  });

  it("downloads file when revision differs from DB", async () => {
    vi.mocked(getNode).mockResolvedValue({
      ok: true,
      value: {
        uid: "node-1",
        name: "file.txt",
        type: NodeType.File,
        parentUid: FOLDER_UID,
        activeRevision: { uid: "rev-2", claimedSize: 200 },
        modificationTime: new Date(2000),
      },
    } as never);
    vi.mocked(streamDownloadToPath).mockResolvedValue(undefined);
    let upsertedState: unknown;
    setupIpcMocks({
      get_file_state_by_remote_id: () => ({
        remoteId: "node-1",
        localPath: `${ROOT}/file.txt`,
        etag: "rev-1",
        modifiedAt: 1000,
        sizeBytes: 100,
        syncState: "synced",
      }),
      upsert_file_state: (args) => { upsertedState = args; return null; },
      show_notification: () => null,
    });

    await handleRemoteNodeUpdate("node-1");

    expect(streamDownloadToPath).toHaveBeenCalledWith(
      "node-1",
      `${ROOT}/file.txt`,
      expect.any(Function),
    );
    expect(upsertedState).toMatchObject({
      remoteId: "node-1",
      localPath: `${ROOT}/file.txt`,
      etag: "rev-2",
      modifiedAt: 2000,
      sizeBytes: 200,
      syncState: "synced",
    });
  });

  it("creates local directory for Folder nodes", async () => {
    vi.mocked(getNode).mockResolvedValue({
      ok: true,
      value: {
        uid: "folder-node",
        name: "subdir",
        type: NodeType.Folder,
        parentUid: FOLDER_UID,
        activeRevision: null,
        modificationTime: new Date(),
      },
    } as never);

    const ensuredDirs: string[] = [];
    setupIpcMocks({
      get_file_state_by_remote_id: () => null,
      ensure_local_dir: ({ absPath }) => {
        ensuredDirs.push(absPath as string);
        return null;
      },
    });

    await handleRemoteNodeUpdate("folder-node");

    expect(ensuredDirs).toEqual([`${ROOT}/subdir`]);

    // Verify the new folder entry was added to watchedFolderUids:
    // a child file node under "folder-node" should now be processed (not skipped).
    vi.mocked(getNode).mockResolvedValue({
      ok: true,
      value: {
        uid: "child-file",
        name: "child.txt",
        type: NodeType.File,
        parentUid: "folder-node",
        activeRevision: { uid: "rev-1", claimedSize: 10 },
        modificationTime: new Date(1000),
      },
    } as never);
    vi.mocked(streamDownloadToPath).mockResolvedValue(undefined);
    setupIpcMocks({
      get_file_state_by_remote_id: () => null,
      ensure_local_dir: ({ absPath }) => {
        ensuredDirs.push(absPath as string);
        return null;
      },
      upsert_file_state: () => null,
      show_notification: () => null,
    });

    await handleRemoteNodeUpdate("child-file");

    expect(streamDownloadToPath).toHaveBeenCalledWith(
      "child-file",
      `${ROOT}/subdir/child.txt`,
      expect.any(Function),
    );
  });

  it("suppresses notification when silent=true", async () => {
    const notifications: string[] = [];
    setupIpcMocks({
      get_file_state_by_remote_id: () => null,
      upsert_file_state: () => null,
      show_notification: (_p: Record<string, unknown>) => {
        notifications.push(_p["body"] as string);
        return null;
      },
    });
    _setWatchedFoldersForTesting(
      new Map([[FOLDER_UID, { localDir: ROOT, selectedRoot: { uid: FOLDER_UID, name: "My Files", drivePath: "", mode: "files" as const } }]]),
    );
    vi.mocked(getNode).mockResolvedValue({
      ok: true,
      value: {
        uid: "node-1", name: "file.txt", type: NodeType.File,
        parentUid: FOLDER_UID, modificationTime: new Date(1000),
        activeRevision: { uid: "rev-1", claimedSize: 100 },
      },
    } as never);
    vi.mocked(streamDownloadToPath).mockResolvedValue(undefined);

    await handleRemoteNodeUpdate("node-1", true);
    expect(notifications).toHaveLength(0);
  });

  it("shows notification when silent=false (default)", async () => {
    const notifications: string[] = [];
    setupIpcMocks({
      get_file_state_by_remote_id: () => null,
      upsert_file_state: () => null,
      show_notification: (_p: Record<string, unknown>) => {
        notifications.push(_p["body"] as string);
        return null;
      },
    });
    _setWatchedFoldersForTesting(
      new Map([[FOLDER_UID, { localDir: ROOT, selectedRoot: { uid: FOLDER_UID, name: "My Files", drivePath: "", mode: "files" as const } }]]),
    );
    vi.mocked(getNode).mockResolvedValue({
      ok: true,
      value: {
        uid: "node-1", name: "file.txt", type: NodeType.File,
        parentUid: FOLDER_UID, modificationTime: new Date(1000),
        activeRevision: { uid: "rev-1", claimedSize: 100 },
      },
    } as never);
    vi.mocked(streamDownloadToPath).mockResolvedValue(undefined);

    await handleRemoteNodeUpdate("node-1"); // no silent param = default false
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("file.txt");
  });

  it("returns early without downloading when _paused", async () => {
    pauseSync();
    await handleRemoteNodeUpdate("node-1");
    expect(getNode).not.toHaveBeenCalled();
  });
});
