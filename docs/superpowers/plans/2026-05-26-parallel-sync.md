# Parallel Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace sequential file sync with bounded-concurrency parallel uploads and downloads, running both directions simultaneously, with per-key coalescing on live events and a queued-count display in the tray.

**Architecture:** A new `concurrency.ts` module provides a `Semaphore` (caps parallel count) and a `CoalescingQueue` (deduplicates rapid repeat events per file key). Initial sync fans out with `Promise.all` over `downloadSemaphore`/`uploadSemaphore`; live events route through `downloadQueue`/`uploadQueue`. Both initial sync phases run in parallel via `Promise.all`.

**Tech Stack:** TypeScript, Vitest, React 19, Tauri IPC (Rust struct updated for new fields)

---

## File Map

| File | Action |
|------|--------|
| `src/lib/sync/concurrency.ts` | **Create** — `Semaphore`, `CoalescingQueue`, module instances |
| `src/__tests__/concurrency.test.ts` | **Create** — unit tests for both classes |
| `src/lib/sync/remote-to-local.ts` | **Modify** — `handleRemoteNodeUpdate` gets `silent` param + `_paused` guard; `handleDriveEvent` routes node updates via `downloadQueue`, guards `TreeRefresh` with `_fullSyncInProgress` |
| `src/lib/sync/local-to-remote.ts` | **Modify** — `handleLocalUpsert` gets `silent` param + `_paused` guard |
| `src/lib/sync/reconciliation.ts` | **Modify** — two-pass collect+fan-out in `initialSyncFolder` and `initialSyncLocalFolder`; `Promise.all` in `triggerFullSync`; batch summary notifications |
| `src/lib/sync/index.ts` | **Modify** — `Promise.all` for startup phases; `uploadQueue.enqueue` for local-change events |
| `src/types/sync.ts` | **Modify** — add `queuedDown`, `queuedUp` to `TrayStatusPayload` |
| `src-tauri/src/commands/ui.rs` | **Modify** — add `queued_down`, `queued_up` to Rust `TrayStatusPayload` struct |
| `src/lib/sync/state.ts` | **Modify** — import semaphores, pass queue counts in `scheduleTrayUpdate` |
| `src/components/TrayPopup.tsx` | **Modify** — show queued count in status text when non-zero |

---

## Task 1: Semaphore — tests then implementation

**Files:**
- Create: `src/__tests__/concurrency.test.ts`
- Create: `src/lib/sync/concurrency.ts`

- [ ] **Step 1: Write failing Semaphore tests**

Create `src/__tests__/concurrency.test.ts`:

```typescript
// @vitest-environment node

import { describe, it, expect } from "vitest";
import { Semaphore } from "../lib/sync/concurrency";

describe("Semaphore", () => {
  it("runs tasks up to cap concurrently and no more", async () => {
    const sem = new Semaphore(3);
    let concurrent = 0;
    let peak = 0;

    const tasks = Array.from({ length: 5 }, () =>
      sem.run(async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise<void>((r) => setTimeout(r, 20));
        concurrent--;
      }),
    );

    await Promise.all(tasks);
    expect(peak).toBe(3);
  });

  it("queued getter returns count of tasks waiting for a slot", async () => {
    const sem = new Semaphore(1);
    let resolve1!: () => void;
    const p1 = sem.run(() => new Promise<void>((r) => { resolve1 = r; }));
    const p2 = sem.run(() => Promise.resolve());
    const p3 = sem.run(() => Promise.resolve());

    expect(sem.queued).toBe(2);

    resolve1();
    await p1;
    await new Promise((r) => setTimeout(r, 0)); // let microtasks flush
    expect(sem.queued).toBe(1);

    await Promise.all([p2, p3]);
    expect(sem.queued).toBe(0);
  });

  it("releases its slot even when fn throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    let ran = false;
    await sem.run(async () => { ran = true; });
    expect(ran).toBe(true);
  });

  it("executes queued tasks in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    let releaseFirst!: () => void;
    const first = sem.run(
      () => new Promise<void>((r) => { releaseFirst = r; }),
    );
    const t2 = sem.run(async () => { order.push(2); });
    const t3 = sem.run(async () => { order.push(3); });
    const t4 = sem.run(async () => { order.push(4); });
    releaseFirst();
    await Promise.all([first, t2, t3, t4]);
    expect(order).toEqual([2, 3, 4]);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
cd /home/bjafl/source/proton-drive-workspace/proton-drive-linux-sync
pnpm test src/__tests__/concurrency.test.ts 2>&1 | tail -20
```

Expected: FAIL — `Semaphore` not defined.

- [ ] **Step 3: Implement Semaphore in concurrency.ts**

Create `src/lib/sync/concurrency.ts`:

```typescript
export const DOWNLOAD_CONCURRENCY = 6;
export const UPLOAD_CONCURRENCY = 4;

export class Semaphore {
  private slots: number;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly cap: number) {
    this.slots = cap;
  }

  run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const attempt = () => {
        if (this.slots > 0) {
          this.slots--;
          fn().then(resolve, reject).finally(() => {
            this.slots++;
            const next = this.queue.shift();
            if (next) next();
          });
        } else {
          this.queue.push(attempt);
        }
      };
      attempt();
    });
  }

  get queued(): number {
    return this.queue.length;
  }

  reset(): void {
    this.slots = this.cap;
    this.queue.length = 0;
  }
}
```

- [ ] **Step 4: Run Semaphore tests — expect all pass**

```bash
pnpm test src/__tests__/concurrency.test.ts 2>&1 | tail -10
```

Expected: all 4 Semaphore tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/__tests__/concurrency.test.ts src/lib/sync/concurrency.ts
git commit -m "feat(sync): add Semaphore with cap, FIFO queue, and queued getter"
```

---

## Task 2: CoalescingQueue — tests then implementation

**Files:**
- Modify: `src/__tests__/concurrency.test.ts`
- Modify: `src/lib/sync/concurrency.ts`

- [ ] **Step 1: Append CoalescingQueue tests to concurrency.test.ts**

Add after the closing `});` of the `Semaphore` describe block:

```typescript
import { CoalescingQueue } from "../lib/sync/concurrency";

describe("CoalescingQueue", () => {
  it("runs at most one task per key concurrently", async () => {
    const sem = new Semaphore(10);
    const queue = new CoalescingQueue(sem);
    let concurrent = 0;
    let peak = 0;
    let release!: () => void;
    const block = new Promise<void>((r) => { release = r; });

    queue.enqueue("k", async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await block;
      concurrent--;
    });
    queue.enqueue("k", async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      concurrent--;
    });

    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(peak).toBe(1);
  });

  it("collapses multiple pending enqueues — only latest fn re-runs", async () => {
    const sem = new Semaphore(10);
    const queue = new CoalescingQueue(sem);
    const ran: string[] = [];
    let release!: () => void;
    const block = new Promise<void>((r) => { release = r; });

    queue.enqueue("k", async () => { await block; ran.push("first"); });
    queue.enqueue("k", async () => { ran.push("second"); });  // pending
    queue.enqueue("k", async () => { ran.push("third"); });   // overwrites pending

    release();
    await new Promise((r) => setTimeout(r, 30));
    // "second" was overwritten before it ever ran
    expect(ran).toEqual(["first", "third"]);
  });

  it("independent keys run in parallel up to semaphore cap", async () => {
    const sem = new Semaphore(10);
    const queue = new CoalescingQueue(sem);
    let concurrent = 0;
    let peak = 0;
    const barrier = new Promise<void>((r) => setTimeout(r, 20));
    const task = async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await barrier;
      concurrent--;
    };

    queue.enqueue("a", task);
    queue.enqueue("b", task);
    queue.enqueue("c", task);

    await new Promise((r) => setTimeout(r, 50));
    expect(peak).toBe(3);
  });

  it("allows re-enqueue for same key after first run completes", async () => {
    const sem = new Semaphore(10);
    const queue = new CoalescingQueue(sem);
    let ran = 0;

    queue.enqueue("k", async () => { ran++; });
    await new Promise((r) => setTimeout(r, 20));
    queue.enqueue("k", async () => { ran++; });
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(2);
  });

  it("allows re-enqueue after fn throws", async () => {
    const sem = new Semaphore(10);
    const queue = new CoalescingQueue(sem);

    queue.enqueue("k", () => Promise.reject(new Error("fail")));
    await new Promise((r) => setTimeout(r, 20));

    let ran = false;
    queue.enqueue("k", async () => { ran = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect CoalescingQueue tests to fail**

```bash
pnpm test src/__tests__/concurrency.test.ts 2>&1 | tail -15
```

Expected: FAIL — `CoalescingQueue` not defined.

- [ ] **Step 3: Implement CoalescingQueue and module instances**

Append to `src/lib/sync/concurrency.ts` after the `Semaphore` class:

```typescript
export class CoalescingQueue {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly pendingFns = new Map<string, () => Promise<void>>();

  constructor(private readonly semaphore: Semaphore) {}

  enqueue(key: string, fn: () => Promise<void>): void {
    if (this.inFlight.has(key)) {
      this.pendingFns.set(key, fn);
      return;
    }
    this._run(key, fn);
  }

  private _run(key: string, fn: () => Promise<void>): void {
    const p = this.semaphore.run(fn).finally(() => {
      this.inFlight.delete(key);
      const nextFn = this.pendingFns.get(key);
      if (nextFn) {
        this.pendingFns.delete(key);
        this._run(key, nextFn);
      }
    });
    this.inFlight.set(key, p);
  }

  /** Resolves when all currently in-flight tasks (and any they trigger) complete. */
  async flush(): Promise<void> {
    const snapshot = [...this.inFlight.values()];
    if (snapshot.length === 0) return;
    await Promise.allSettled(snapshot);
    await this.flush();
  }

  get activeCount(): number {
    return this.inFlight.size;
  }

  reset(): void {
    this.inFlight.clear();
    this.pendingFns.clear();
  }
}

export const downloadSemaphore = new Semaphore(DOWNLOAD_CONCURRENCY);
export const uploadSemaphore = new Semaphore(UPLOAD_CONCURRENCY);
export const downloadQueue = new CoalescingQueue(downloadSemaphore);
export const uploadQueue = new CoalescingQueue(uploadSemaphore);
```

Also add the `CoalescingQueue` import in `concurrency.test.ts` at the top alongside `Semaphore`:

```typescript
import { Semaphore, CoalescingQueue } from "../lib/sync/concurrency";
```

- [ ] **Step 4: Run all concurrency tests — expect all pass**

```bash
pnpm test src/__tests__/concurrency.test.ts 2>&1 | tail -10
```

Expected: all 9 tests PASS (4 Semaphore + 5 CoalescingQueue).

- [ ] **Step 5: Run full suite to check for regressions**

```bash
pnpm test 2>&1 | tail -8
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/concurrency.test.ts src/lib/sync/concurrency.ts
git commit -m "feat(sync): add CoalescingQueue — deduplicates rapid repeat events per key"
```

---

## Task 3: handleRemoteNodeUpdate — silent param and _paused guard

**Files:**
- Modify: `src/lib/sync/remote-to-local.ts:82-171`
- Modify: `src/__tests__/syncHandlers.test.ts`

Context: `handleRemoteNodeUpdate` currently always calls `showNotification` on success. It has no `_paused` check (only `handleDriveEvent` checks pause at the top). With parallel batch calls, we need `silent=true` to suppress per-file notifications. The `_paused` check prevents queued tasks from running after sync is paused.

- [ ] **Step 1: Write failing tests for silent and _paused**

Add to `src/__tests__/syncHandlers.test.ts` inside the existing `describe("handleRemoteNodeUpdate", ...)` block:

```typescript
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
  });
  vi.mocked(streamDownloadToPath).mockResolvedValue(undefined as never);

  await handleRemoteNodeUpdate("node-1", true);
  expect(notifications).toHaveLength(0);
});

it("returns early without downloading when _paused", async () => {
  pauseSync();
  _setWatchedFoldersForTesting(
    new Map([[FOLDER_UID, { localDir: ROOT, selectedRoot: { uid: FOLDER_UID, name: "My Files", drivePath: "", mode: "files" as const } }]]),
  );
  await handleRemoteNodeUpdate("node-1");
  expect(getNode).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect failures**

```bash
pnpm test src/__tests__/syncHandlers.test.ts 2>&1 | tail -15
```

Expected: 2 new tests FAIL.

- [ ] **Step 3: Update handleRemoteNodeUpdate signature and body**

In `src/lib/sync/remote-to-local.ts`, change lines 82–171:

```typescript
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
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
pnpm test src/__tests__/syncHandlers.test.ts 2>&1 | tail -10
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/remote-to-local.ts src/__tests__/syncHandlers.test.ts
git commit -m "feat(sync): handleRemoteNodeUpdate — add silent param and _paused guard"
```

---

## Task 4: handleLocalUpsert — silent param and _paused guard

**Files:**
- Modify: `src/lib/sync/local-to-remote.ts:170-299`
- Modify: `src/__tests__/syncHandlers.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/__tests__/syncHandlers.test.ts` inside the existing `describe("handleLocalUpsert", ...)` block (or create one if absent):

```typescript
it("suppresses upload notification when silent=true", async () => {
  const notifications: string[] = [];
  setupIpcMocks({
    get_file_state_by_local_path: () => null,
    stat_local_file: () => ({ mtimeMs: 1000, sizeBytes: 100, isDir: false }),
    read_local_file: () => new Uint8Array(10),
    upsert_file_state: () => null,
    show_notification: (_p: Record<string, unknown>) => {
      notifications.push(_p["body"] as string);
      return null;
    },
  });
  _setWatchedFoldersForTesting(
    new Map([[FOLDER_UID, { localDir: ROOT, selectedRoot: { uid: FOLDER_UID, name: "My Files", drivePath: "", mode: "files" as const } }]]),
  );
  const absPath = `${ROOT}/file.txt`;
  vi.mocked(getFileUploader).mockResolvedValue({
    uploadFromFile: vi.fn().mockResolvedValue({ completion: vi.fn().mockResolvedValue({ nodeUid: "n1", nodeRevisionUid: "r1" }) }),
  } as never);

  await handleLocalUpsert(absPath, false, true);
  expect(notifications).toHaveLength(0);
});

it("returns early without uploading when _paused", async () => {
  pauseSync();
  _setWatchedFoldersForTesting(
    new Map([[FOLDER_UID, { localDir: ROOT, selectedRoot: { uid: FOLDER_UID, name: "My Files", drivePath: "", mode: "files" as const } }]]),
  );
  await handleLocalUpsert(`${ROOT}/file.txt`, false);
  expect(getFileUploader).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run — expect failures**

```bash
pnpm test src/__tests__/syncHandlers.test.ts 2>&1 | tail -15
```

Expected: 2 new tests FAIL.

- [ ] **Step 3: Update handleLocalUpsert signature and body**

In `src/lib/sync/local-to-remote.ts`, change the function signature at line 170:

```typescript
/** @internal */
export async function handleLocalUpsert(
  absPath: string,
  checkStability: boolean,
  silent = false,
): Promise<void> {
  if (_paused) {
    console.log("[sync] paused — skipping upload:", absPath);
    return;
  }
  // ... rest of function unchanged until the notification line ...
```

Change the notification at the end of the try block (currently lines 289-293):

```typescript
    showNotification(
      "Proton Drive Sync",
      `${existing ? "Updated" : "Uploaded"}: ${filename}`,
    ).catch(() => {});
```

Replace with:

```typescript
    if (!silent) {
      showNotification(
        "Proton Drive Sync",
        `${existing ? "Updated" : "Uploaded"}: ${filename}`,
      ).catch(() => {});
    }
```

- [ ] **Step 4: Run tests — expect all pass**

```bash
pnpm test src/__tests__/syncHandlers.test.ts 2>&1 | tail -10
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/local-to-remote.ts src/__tests__/syncHandlers.test.ts
git commit -m "feat(sync): handleLocalUpsert — add silent param and _paused guard"
```

---

## Task 5: Parallel fan-out in reconciliation.ts

**Files:**
- Modify: `src/lib/sync/reconciliation.ts`
- Modify: `src/__tests__/reconciliation.test.ts`

Context: `initialSyncFolder` currently iterates files and `await`s each download serially. The new version collects all node UIDs needing download in a first pass, then fans them out in parallel via `downloadSemaphore`. Same for `initialSyncLocalFolder`. `triggerFullSync` changes `await A; await B` to `Promise.all([A, B])`.

- [ ] **Step 1: Write failing tests for parallel fan-out and batch notification**

Add to `src/__tests__/reconciliation.test.ts`:

```typescript
import { initialSyncFolder, initialSyncLocalFolder } from "../lib/sync/reconciliation";
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

describe("initialSyncFolder — parallel fan-out", () => {
  beforeEach(() => {
    downloadSemaphore.reset();
    vi.mocked(handleRemoteNodeUpdate).mockResolvedValue(undefined);
  });

  it("calls handleRemoteNodeUpdate once per node that needs downloading", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));
    vi.mocked(listFolderChildren).mockImplementation(async function* () {
      yield { ok: true, value: { uid: "n1", activeRevision: { uid: "rev1" } } };
      yield { ok: true, value: { uid: "n2", activeRevision: { uid: "rev2" } } };
    });
    setupIpcMocks({ get_file_state_by_remote_id: () => null });

    await initialSyncFolder();

    expect(handleRemoteNodeUpdate).toHaveBeenCalledTimes(2);
    expect(handleRemoteNodeUpdate).toHaveBeenCalledWith("n1", true);
    expect(handleRemoteNodeUpdate).toHaveBeenCalledWith("n2", true);
  });

  it("skips nodes whose etag already matches", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));
    vi.mocked(listFolderChildren).mockImplementation(async function* () {
      yield { ok: true, value: { uid: "n1", activeRevision: { uid: "rev1" } } };
    });
    setupIpcMocks({
      get_file_state_by_remote_id: () => ({
        remoteId: "n1", localPath: `${ROOT}/file.txt`, etag: "rev1",
        modifiedAt: 1000, sizeBytes: 100, syncState: "synced",
      }),
    });

    await initialSyncFolder();
    expect(handleRemoteNodeUpdate).not.toHaveBeenCalled();
  });

  it("fires one summary notification after batch completes", async () => {
    const notifications: string[] = [];
    setupIpcMocks({
      get_file_state_by_remote_id: () => null,
      show_notification: (_p: Record<string, unknown>) => {
        notifications.push(_p["body"] as string);
        return null;
      },
    });
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));
    vi.mocked(listFolderChildren).mockImplementation(async function* () {
      yield { ok: true, value: { uid: "n1", activeRevision: null } };
      yield { ok: true, value: { uid: "n2", activeRevision: null } };
      yield { ok: true, value: { uid: "n3", activeRevision: null } };
    });

    await initialSyncFolder();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toBe("Downloaded 3 files");
  });
});

describe("initialSyncLocalFolder — parallel fan-out", () => {
  beforeEach(() => {
    uploadSemaphore.reset();
    vi.mocked(handleLocalUpsert).mockResolvedValue(undefined);
  });

  it("calls handleLocalUpsert with silent=true for each file", async () => {
    _setWatchedFoldersForTesting(new Map([[FOLDER_UID, makeEntry()]]));
    setupIpcMocks({
      list_dir_recursive: () => [
        { relPath: "a.txt", absPath: `${ROOT}/a.txt`, mtimeMs: 1, sizeBytes: 1 },
        { relPath: "b.txt", absPath: `${ROOT}/b.txt`, mtimeMs: 1, sizeBytes: 1 },
      ],
    });

    await initialSyncLocalFolder();

    expect(handleLocalUpsert).toHaveBeenCalledTimes(2);
    expect(handleLocalUpsert).toHaveBeenCalledWith(`${ROOT}/a.txt`, false, true);
    expect(handleLocalUpsert).toHaveBeenCalledWith(`${ROOT}/b.txt`, false, true);
  });
});
```

- [ ] **Step 2: Run — expect failures**

```bash
pnpm test src/__tests__/reconciliation.test.ts 2>&1 | tail -20
```

Expected: new tests FAIL.

- [ ] **Step 3: Rewrite initialSyncFolder and initialSyncLocalFolder, update triggerFullSync**

Replace all of `src/lib/sync/reconciliation.ts` with:

```typescript
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

  // Collect pass — metadata only, no downloads yet
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
        if (existing?.etag && existing.etag === node.activeRevision?.uid) continue;
        toDownload.push(node.uid);
      }
    } catch (err) {
      console.error("[sync] Folder scan failed for", entry.localDir, err);
    }
  }

  if (toDownload.length === 0) return;

  // Fan-out pass — parallel downloads bounded by semaphore
  let downloaded = 0;
  await Promise.all(
    toDownload.map((uid) =>
      downloadSemaphore.run(async () => {
        await handleRemoteNodeUpdate(uid, true);
        downloaded++;
      }).catch(() => {}),
    ),
  );

  if (downloaded > 0) {
    showNotification(
      "Proton Drive Sync",
      downloaded === 1 ? "Downloaded 1 file" : `Downloaded ${downloaded} files`,
    ).catch(() => {});
  }
}

export async function initialSyncLocalFolder(): Promise<void> {
  const toUpload: string[] = [];

  for (const [, entry] of watchedFolderUids) {
    console.log("[sync] Scanning local folder:", entry.localDir);
    await ensureLocalDir(entry.localDir).catch(console.error);
    try {
      const files =
        entry.selectedRoot.mode === "recursive"
          ? await listDirRecursive(entry.localDir).then((fs) => fs.map((f) => f.absPath))
          : await listLocalDir(entry.localDir);
      toUpload.push(...files);
    } catch (err) {
      console.error("[sync] Local folder scan failed for", entry.localDir, err);
    }
  }

  if (toUpload.length === 0) return;

  let uploaded = 0;
  await Promise.all(
    toUpload.map((absPath) =>
      uploadSemaphore.run(async () => {
        await handleLocalUpsert(absPath, false, true);
        uploaded++;
      }).catch(() => {}),
    ),
  );

  if (uploaded > 0) {
    showNotification(
      "Proton Drive Sync",
      uploaded === 1 ? "Uploaded 1 file" : `Uploaded ${uploaded} files`,
    ).catch(() => {});
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

export type { FileState };
```

- [ ] **Step 4: Run reconciliation tests — expect all pass**

```bash
pnpm test src/__tests__/reconciliation.test.ts 2>&1 | tail -15
```

Expected: all tests PASS.

- [ ] **Step 5: Run full suite**

```bash
pnpm test 2>&1 | tail -8
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/sync/reconciliation.ts src/__tests__/reconciliation.test.ts
git commit -m "feat(sync): parallel fan-out in initialSyncFolder/LocalFolder, Promise.all in triggerFullSync"
```

---

## Task 6: Wire CoalescingQueue into live events in index.ts and handleDriveEvent

**Files:**
- Modify: `src/lib/sync/index.ts`
- Modify: `src/lib/sync/remote-to-local.ts`

Context: `handleDriveEvent` currently `await`s `handleRemoteNodeUpdate` directly. We change it to call `downloadQueue.enqueue(nodeUid, ...)`. `TreeRefresh`/`FastForward` events bypass the queue and call `onFullRefresh()` directly, guarded by `_fullSyncInProgress`. In `index.ts`, the startup phases become `Promise.all` and local-change events route through `uploadQueue`.

- [ ] **Step 1: Update handleDriveEvent in remote-to-local.ts**

Add `downloadQueue` and `_fullSyncInProgress` to imports:

```typescript
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
```

Replace the entire `handleDriveEvent` function body:

```typescript
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
    } else if (event.parentNodeUid && !watchedFolderUids.has(event.parentNodeUid)) {
      console.log("[sync] skipping node outside watched folders (by parentUid):", event.nodeUid);
    } else if (recentlyUploaded.has(event.nodeUid)) {
      console.log("[sync] suppressed drive event for own upload:", event.nodeUid);
    } else {
      downloadQueue.enqueue(event.nodeUid, () => handleRemoteNodeUpdate(event.nodeUid));
    }
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

  const eventType = event.type;
  if ("treeEventScopeId" in event && "eventId" in event) {
    persistEventAnchor(event.treeEventScopeId, event.eventId).catch(() => {});
  } else if (
    eventType === DriveEventType.TreeRefresh ||
    eventType === DriveEventType.FastForward
  ) {
    console.warn("[sync]", eventType, "did not carry eventId — event anchor not updated");
  }
}
```

- [ ] **Step 2: Update index.ts**

In `src/lib/sync/index.ts`:

Add `uploadQueue` to imports from `./concurrency` (or create a new import line):

```typescript
import { uploadQueue } from "./concurrency";
```

Change the startup sequence (lines 76–77):

```typescript
// Before:
await initialSyncFolder();
await initialSyncLocalFolder();

// After:
await Promise.all([initialSyncFolder(), initialSyncLocalFolder()]);
```

Change the `subscribeToTreeEvents` callback (remove `async`, fire-and-forget):

```typescript
const subscription = await subscribeToTreeEvents(
  treeEventScopeId,
  (event: DriveEvent) => {
    handleDriveEvent(event, initialSyncFolder).catch((err) => {
      console.error("[sync] Unhandled error in drive event handler:", err);
    });
  },
);
```

Change the local-change listener (remove `async`, route through `uploadQueue`):

```typescript
const unlisten: UnlistenFn = await listen<WatchEvent>("sync://local-change", (e) => {
  if (e.payload.absPath.endsWith(".pd-tmp")) return;
  uploadQueue.enqueue(e.payload.absPath, () => handleLocalChange(e.payload));
});
```

- [ ] **Step 3: Type-check**

```bash
pnpm tsc --noEmit 2>&1
```

Expected: no errors.

- [ ] **Step 4: Run full test suite**

```bash
pnpm test 2>&1 | tail -10
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sync/remote-to-local.ts src/lib/sync/index.ts
git commit -m "feat(sync): route live events through CoalescingQueue; Promise.all startup; _fullSyncInProgress guard on TreeRefresh"
```

---

## Task 7: Tray status — queued counts in UI

**Files:**
- Modify: `src/types/sync.ts`
- Modify: `src-tauri/src/commands/ui.rs`
- Modify: `src/lib/sync/state.ts`
- Modify: `src/components/TrayPopup.tsx`

- [ ] **Step 1: Add fields to TypeScript TrayStatusPayload**

In `src/types/sync.ts`, update `TrayStatusPayload`:

```typescript
export interface TrayStatusPayload {
  paused: boolean;
  syncing: boolean;
  activeCount: number;
  recentFiles: TrayRecentFile[];
  errorCount: number;
  queuedDown: number;
  queuedUp: number;
}
```

- [ ] **Step 2: Add fields to Rust TrayStatusPayload**

In `src-tauri/src/commands/ui.rs`, update the struct:

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TrayStatusPayload {
    pub paused: bool,
    pub syncing: bool,
    pub active_count: usize,
    pub recent_files: Vec<RecentFile>,
    pub error_count: usize,
    pub queued_down: usize,
    pub queued_up: usize,
}
```

- [ ] **Step 3: Run Rust tests to verify struct change is clean**

```bash
cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: all Rust tests PASS (serde change is additive).

- [ ] **Step 4: Pass queue counts in scheduleTrayUpdate**

In `src/lib/sync/state.ts`, add import:

```typescript
import { downloadSemaphore, uploadSemaphore } from "./concurrency";
```

Update the `scheduleTrayUpdate` function body — change the `updateTrayStatus` call:

```typescript
updateTrayStatus({
  paused: _paused,
  syncing: activeItems.length > 0,
  activeCount: activeItems.length,
  recentFiles: _recentlySynced.slice(0, 8),
  errorCount: _status.errors.length,
  queuedDown: downloadSemaphore.queued,
  queuedUp: uploadSemaphore.queued,
}).catch(() => {});
```

- [ ] **Step 5: Update TrayPopup.tsx to show queued count**

In `src/components/TrayPopup.tsx`, add after the existing `const activeCount` line:

```typescript
const queuedDown = status?.queuedDown ?? 0;
const queuedUp = status?.queuedUp ?? 0;
const totalQueued = queuedDown + queuedUp;
```

Update the `statusText` variable:

```typescript
const statusText = paused
  ? "Sync paused"
  : syncing
  ? totalQueued > 0
    ? `Syncing ${activeCount} item${activeCount !== 1 ? "s" : ""}… (${totalQueued} queued)`
    : `Syncing ${activeCount} item${activeCount !== 1 ? "s" : ""}…`
  : errorCount > 0
  ? `${errorCount} error${errorCount !== 1 ? "s" : ""}`
  : "Up to date";
```

- [ ] **Step 6: Type-check and run all tests**

```bash
pnpm tsc --noEmit 2>&1 && pnpm test 2>&1 | tail -10
```

Expected: no type errors, all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/types/sync.ts src-tauri/src/commands/ui.rs src/lib/sync/state.ts src/components/TrayPopup.tsx
git commit -m "feat(sync): surface queued download/upload counts in tray status display"
```
