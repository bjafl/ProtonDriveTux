// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanStaleDbEntries, triggerFullSync, initialSyncLocalFolder, initialSyncFolder } from "../lib/sync/reconciliation";
import { waitForFileStable } from "../lib/sync/config";
import { listFolderChildren } from "../lib/drive";
import {
  _resetSyncStateForTesting,
  _setWatchedFoldersForTesting,
  getSyncStatus,
  setFullSyncInProgress,
} from "../lib/sync/state";
import { setupIpcMocks, teardownIpcMocks } from "./helpers/syncMocks";
import type { WatchedFolderEntry } from "../lib/syncHelpers";
import { downloadSemaphore, uploadSemaphore } from "../lib/sync/concurrency";
import { handleRemoteNodeUpdate } from "../lib/sync/remote-to-local";
import { handleLocalUpsert } from "../lib/sync/local-to-remote";

vi.mock("../lib/sync/remote-to-local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sync/remote-to-local")>();
  return { ...actual, handleRemoteNodeUpdate: vi.fn() };
});

vi.mock("../lib/sync/local-to-remote", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sync/local-to-remote")>();
  return { ...actual, handleLocalUpsert: vi.fn() };
});

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

vi.mock("@protontech/drive-sdk", () => ({
  DriveEventType: { Create: "create", Update: "update", Delete: "delete", Move: "move" },
  NodeType: { File: "file", Folder: "folder" },
}));

const ROOT = "/home/test/ProtonDrive";
const FOLDER_UID = "folder-uid-1";

function makeEntry(): WatchedFolderEntry {
  return {
    localDir: ROOT,
    selectedRoot: { uid: FOLDER_UID, name: "ProtonDrive", drivePath: "", mode: "recursive" },
  };
}

beforeEach(() => {
  _resetSyncStateForTesting();
  setupIpcMocks();
});

afterEach(() => {
  teardownIpcMocks();
  vi.useRealTimers();
});

// ── cleanStaleDbEntries ──────────────────────────────────────────────────────

describe("cleanStaleDbEntries", () => {
  it("does nothing when there are no DB entries", async () => {
    const deleted: string[] = [];
    setupIpcMocks({
      get_all_file_states: () => [],
      delete_file_state: ({ remoteId }) => { deleted.push(remoteId as string); return null; },
    });
    await cleanStaleDbEntries();
    expect(deleted).toHaveLength(0);
  });

  it("deletes entries whose local file no longer exists", async () => {
    const deleted: string[] = [];
    setupIpcMocks({
      get_all_file_states: () => [
        { remoteId: "rid1", localPath: "/a/gone.txt", etag: null, modifiedAt: null, sizeBytes: null, syncState: "synced" },
      ],
      stat_local_file: () => { throw new Error("file not found"); },
      delete_file_state: ({ remoteId }) => { deleted.push(remoteId as string); return null; },
    });
    await cleanStaleDbEntries();
    expect(deleted).toEqual(["rid1"]);
  });

  it("keeps entries whose local file still exists", async () => {
    const deleted: string[] = [];
    const stat = { mtimeMs: 1_000, sizeBytes: 100 };
    setupIpcMocks({
      get_all_file_states: () => [
        { remoteId: "rid1", localPath: "/a/alive.txt", etag: null, modifiedAt: null, sizeBytes: null, syncState: "synced" },
      ],
      stat_local_file: () => stat,
      delete_file_state: ({ remoteId }) => { deleted.push(remoteId as string); return null; },
    });
    await cleanStaleDbEntries();
    expect(deleted).toHaveLength(0);
  });

  it("handles mixed entries — deletes only missing files", async () => {
    const deleted: string[] = [];
    const stat = { mtimeMs: 1_000, sizeBytes: 50 };
    setupIpcMocks({
      get_all_file_states: () => [
        { remoteId: "rid1", localPath: "/a/alive.txt", etag: null, modifiedAt: null, sizeBytes: null, syncState: "synced" },
        { remoteId: "rid2", localPath: "/a/gone.txt", etag: null, modifiedAt: null, sizeBytes: null, syncState: "synced" },
      ],
      stat_local_file: ({ absPath }) =>
        (absPath as string).includes("alive") ? stat : (() => { throw new Error("gone"); })(),
      delete_file_state: ({ remoteId }) => { deleted.push(remoteId as string); return null; },
    });
    await cleanStaleDbEntries();
    expect(deleted).toEqual(["rid2"]);
  });
});

// ── triggerFullSync guard conditions ─────────────────────────────────────────

describe("triggerFullSync", () => {
  it("returns early with no active label when no folders are watched", async () => {
    await triggerFullSync();
    expect(getSyncStatus().active).toHaveLength(0);
  });

  it("returns early when a full sync is already in progress", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));
    setFullSyncInProgress(true);
    await triggerFullSync();
    expect(getSyncStatus().active).toHaveLength(0);
  });

  it("runs a full cycle and clears the active label when folders are watched", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));
    vi.mocked(listFolderChildren).mockReturnValue(
      (async function* () {})() as ReturnType<typeof listFolderChildren>,
    );

    await triggerFullSync();

    expect(getSyncStatus().errors).toHaveLength(0);
    expect(getSyncStatus().active).not.toContain("__full_sync__");
  });
});

// ── initialSyncLocalFolder ───────────────────────────────────────────────────

describe("initialSyncLocalFolder", () => {
  it("creates local dir and scans files (files mode, empty dir)", async () => {
    const entry: WatchedFolderEntry = {
      localDir: ROOT,
      selectedRoot: { uid: FOLDER_UID, name: "ProtonDrive", drivePath: "", mode: "files" },
    };
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, entry]]));

    const ensured: string[] = [];
    setupIpcMocks({
      ensure_local_dir: ({ absPath }) => { ensured.push(absPath as string); return null; },
      list_local_dir: () => [],
    });

    await initialSyncLocalFolder();
    expect(ensured).toContain(ROOT);
  });

  it("creates local dir and scans recursive files (recursive mode, empty)", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));

    const ensured: string[] = [];
    setupIpcMocks({
      ensure_local_dir: ({ absPath }) => { ensured.push(absPath as string); return null; },
      list_dir_recursive: () => [],
    });

    await initialSyncLocalFolder();
    expect(ensured).toContain(ROOT);
  });
});

// ── waitForFileStable ────────────────────────────────────────────────────────

describe("waitForFileStable", () => {
  it("returns null immediately when the file does not exist on the first stat", async () => {
    setupIpcMocks({ stat_local_file: () => { throw new Error("not found"); } });
    const result = await waitForFileStable("/a/missing.txt");
    expect(result).toBeNull();
  });

  it("returns the stat when size and mtime are unchanged after the first 1 s wait", async () => {
    const stat = { mtimeMs: 1_000_000, sizeBytes: 42 };
    setupIpcMocks({ stat_local_file: () => stat });

    vi.useFakeTimers();
    const promise = waitForFileStable("/a/stable.txt");
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;
    expect(result).toEqual(stat);
  });

  it("returns null when the file disappears between the first and second stat", async () => {
    let callCount = 0;
    const stat = { mtimeMs: 1_000_000, sizeBytes: 42 };
    setupIpcMocks({
      stat_local_file: () => {
        callCount++;
        if (callCount === 1) return stat;
        throw new Error("disappeared");
      },
    });

    vi.useFakeTimers();
    const promise = waitForFileStable("/a/flaky.txt");
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;
    expect(result).toBeNull();
  });

  it("waits a second 1 s window when stats differ on the first check", async () => {
    let callCount = 0;
    const stat1 = { mtimeMs: 1_000_000, sizeBytes: 42 };
    const stat2 = { mtimeMs: 1_001_000, sizeBytes: 42 }; // still writing
    const stat3 = { mtimeMs: 1_001_000, sizeBytes: 42 }; // settled
    setupIpcMocks({
      stat_local_file: () => {
        callCount++;
        if (callCount === 1) return stat1;
        if (callCount === 2) return stat2;
        return stat3;
      },
    });

    vi.useFakeTimers();
    const promise = waitForFileStable("/a/writing.txt");
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;
    expect(result).toEqual(stat3);
  });

  it("returns null when the file is still changing after the second wait", async () => {
    let callCount = 0;
    setupIpcMocks({
      stat_local_file: () => {
        callCount++;
        return { mtimeMs: callCount * 1_000, sizeBytes: callCount * 10 };
      },
    });

    vi.useFakeTimers();
    const promise = waitForFileStable("/a/busy.txt");
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await promise;
    expect(result).toBeNull();
  });
});

// ── initialSyncFolder — parallel fan-out ─────────────────────────────────────

describe("initialSyncFolder — parallel fan-out", () => {
  beforeEach(() => {
    downloadSemaphore.reset();
    vi.mocked(handleRemoteNodeUpdate).mockClear();
    vi.mocked(handleRemoteNodeUpdate).mockResolvedValue(undefined);
  });

  it("calls handleRemoteNodeUpdate once per node that needs downloading", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));

    function makeNode(uid: string, revUid: string) {
      return { ok: true, value: { uid, activeRevision: { uid: revUid } } };
    }
    const nodes = [makeNode("node-1", "rev-1"), makeNode("node-2", "rev-2")];

    vi.mocked(listFolderChildren).mockReturnValue(
      (async function* () {
        for (const n of nodes) yield n;
      })() as ReturnType<typeof listFolderChildren>,
    );

    // DB returns null for both → both need downloading
    setupIpcMocks({ get_file_state_by_remote_id: () => null });

    await initialSyncFolder();

    expect(handleRemoteNodeUpdate).toHaveBeenCalledTimes(2);
    expect(handleRemoteNodeUpdate).toHaveBeenCalledWith("node-1", true);
    expect(handleRemoteNodeUpdate).toHaveBeenCalledWith("node-2", true);
  });

  it("skips nodes whose etag already matches", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));

    const revUid = "rev-already-synced";
    vi.mocked(listFolderChildren).mockReturnValue(
      (async function* () {
        yield { ok: true, value: { uid: "node-synced", activeRevision: { uid: revUid } } };
      })() as ReturnType<typeof listFolderChildren>,
    );

    // DB has matching etag → should be skipped
    setupIpcMocks({
      get_file_state_by_remote_id: () => ({
        remoteId: "node-synced",
        localPath: `${ROOT}/file.txt`,
        etag: revUid,
        modifiedAt: null,
        sizeBytes: null,
        syncState: "synced",
      }),
    });

    await initialSyncFolder();

    expect(handleRemoteNodeUpdate).not.toHaveBeenCalled();
  });

  it("fires one summary notification after batch completes", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));

    const nodes = [
      { ok: true, value: { uid: "n1", activeRevision: { uid: "r1" } } },
      { ok: true, value: { uid: "n2", activeRevision: { uid: "r2" } } },
      { ok: true, value: { uid: "n3", activeRevision: { uid: "r3" } } },
    ];
    vi.mocked(listFolderChildren).mockReturnValue(
      (async function* () {
        for (const n of nodes) yield n;
      })() as ReturnType<typeof listFolderChildren>,
    );

    const notifications: Array<{ title: string; body: string }> = [];
    setupIpcMocks({
      get_file_state_by_remote_id: () => null,
      show_notification: ({ title, body }) => {
        notifications.push({ title: title as string, body: body as string });
        return null;
      },
    });

    await initialSyncFolder();

    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toMatch(/3 files/);
  });

  it("does not increment downloaded counter when handleRemoteNodeUpdate throws", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));

    const notifications: Array<{ title: string; body: string }> = [];
    setupIpcMocks({
      get_file_state_by_remote_id: () => null,
      show_notification: ({ title, body }) => {
        notifications.push({ title: title as string, body: body as string });
        return null;
      },
    });
    vi.mocked(listFolderChildren).mockImplementation(async function* () {
      yield { ok: true as const, value: { uid: "n1", activeRevision: null } };
      yield { ok: true as const, value: { uid: "n2", activeRevision: null } };
    });
    vi.mocked(handleRemoteNodeUpdate)
      .mockRejectedValueOnce(new Error("network error")) // n1 fails
      .mockResolvedValue(undefined); // n2 succeeds

    await initialSyncFolder();

    // Only 1 success → notification should say "1 file", not "2 files"
    expect(notifications).toHaveLength(1);
    expect(notifications[0].body).toBe("Downloaded 1 file");
  });
});

// ── initialSyncLocalFolder — parallel fan-out ────────────────────────────────

describe("initialSyncLocalFolder — parallel fan-out", () => {
  beforeEach(() => {
    uploadSemaphore.reset();
    vi.mocked(handleLocalUpsert).mockClear();
    vi.mocked(handleLocalUpsert).mockResolvedValue(undefined);
  });

  it("calls handleLocalUpsert with silent=true for each file in files mode", async () => {
    const entry: WatchedFolderEntry = {
      localDir: ROOT,
      selectedRoot: { uid: FOLDER_UID, name: "ProtonDrive", drivePath: "", mode: "files" },
    };
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, entry]]));

    setupIpcMocks({
      ensure_local_dir: () => null,
      list_local_dir: () => [`${ROOT}/a.txt`, `${ROOT}/b.txt`],
    });

    await initialSyncLocalFolder();

    expect(handleLocalUpsert).toHaveBeenCalledTimes(2);
    expect(handleLocalUpsert).toHaveBeenCalledWith(`${ROOT}/a.txt`, false, true);
    expect(handleLocalUpsert).toHaveBeenCalledWith(`${ROOT}/b.txt`, false, true);
  });

  it("calls handleLocalUpsert with silent=true for each file in recursive mode", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));

    setupIpcMocks({
      ensure_local_dir: () => null,
      list_dir_recursive: () => [
        { absPath: `${ROOT}/sub/c.txt`, relPath: "sub/c.txt", mtimeMs: 1000, sizeBytes: 10 },
        { absPath: `${ROOT}/sub/d.txt`, relPath: "sub/d.txt", mtimeMs: 1000, sizeBytes: 10 },
      ],
    });

    await initialSyncLocalFolder();

    expect(handleLocalUpsert).toHaveBeenCalledTimes(2);
    expect(handleLocalUpsert).toHaveBeenCalledWith(`${ROOT}/sub/c.txt`, false, true);
    expect(handleLocalUpsert).toHaveBeenCalledWith(`${ROOT}/sub/d.txt`, false, true);
  });
});
