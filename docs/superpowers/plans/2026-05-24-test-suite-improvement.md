# Test Suite Improvement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add handler integration tests for sync.ts (currently 0% coverage), extract pure
decision functions, and fill the Rust path-guard and auth testing gaps.

**Architecture:** Per-file `// @vitest-environment jsdom` on the handler test file enables
Tauri's `mockIPC`; Drive SDK mocked with `vi.mock`. Module state reset via an exported
`_resetSyncStateForTesting()`. Pure decision logic extracted to `syncDecisions.ts` for
zero-mock unit tests. Rust tests use `TempDir` and in-memory `Db`.

**Tech Stack:** Vitest 4, `@tauri-apps/api/mocks` (mockIPC/clearMocks), jsdom, TypeScript,
Rust test runtime with `tempfile::TempDir` and `rusqlite :memory:`.

**Design document:** `docs/superpowers/specs/2026-05-24-test-suite-improvement-design.md`

**All code, comments, identifiers, and string literals must be in English.**

---

## File Structure

```
src/
  lib/
    syncDecisions.ts          (new) pure: FileStat type, guessMimeType, isAlreadySynced
    sync.ts                   (modify) import from syncDecisions, export handlers + test utils
  __tests__/
    syncDecisions.test.ts     (new) 12 pure-function tests; node environment
    syncHandlers.test.ts      (new) 14+ handler integration tests; jsdom environment
    helpers/
      syncMocks.ts            (new) setupIpcMocks(), Drive SDK vi.fn() stubs
src-tauri/src/
  commands.rs                 (modify) add 7 path-guard tests
  auth.rs                     (modify) add 3 ProtonAuth::new tests
package.json                  (modify) add jsdom devDependency
docs/superpowers/specs/
  sync-level2-design.md       (new) Level 2 design notes (pinned for later)
```

---

## Task 1: Install jsdom

**Files:**
- Modify: `package.json` (pnpm adds it automatically)

- [ ] **Step 1.1: Add jsdom devDependency**

```bash
cd /home/bjafl/source/proton-drive-workspace/proton-drive-linux-sync
pnpm add -D jsdom
```

Expected: `"jsdom": "^..."` appears in devDependencies in `package.json`.

- [ ] **Step 1.2: Create a minimal jsdom smoke test**

Create `src/__tests__/jsdom_smoke.test.ts`:

```typescript
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";

describe("jsdom environment", () => {
  it("has window object", () => {
    expect(typeof window).toBe("object");
  });
});
```

- [ ] **Step 1.3: Run to verify jsdom annotation works**

```bash
pnpm test -- --reporter=verbose src/__tests__/jsdom_smoke.test.ts
```

Expected output:
```
✓ src/__tests__/jsdom_smoke.test.ts (1 test)
  ✓ jsdom environment > has window object
```

- [ ] **Step 1.4: Delete the smoke test**

```bash
rm src/__tests__/jsdom_smoke.test.ts
```

- [ ] **Step 1.5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "test: add jsdom devDependency for handler integration tests

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Extract pure functions to syncDecisions.ts

**Files:**
- Create: `src/lib/syncDecisions.ts`
- Create: `src/__tests__/syncDecisions.test.ts`
- Modify: `src/lib/sync.ts`

- [ ] **Step 2.1: Write failing tests for pure functions**

Create `src/__tests__/syncDecisions.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { guessMimeType, isAlreadySynced } from "../lib/syncDecisions";

describe("guessMimeType", () => {
  it("returns image/jpeg for jpg", () => {
    expect(guessMimeType("photo.jpg")).toBe("image/jpeg");
  });

  it("returns image/jpeg for jpeg", () => {
    expect(guessMimeType("photo.jpeg")).toBe("image/jpeg");
  });

  it("returns text/plain for txt", () => {
    expect(guessMimeType("notes.txt")).toBe("text/plain");
  });

  it("returns application/pdf for pdf", () => {
    expect(guessMimeType("doc.pdf")).toBe("application/pdf");
  });

  it("returns application/octet-stream for unknown extension", () => {
    expect(guessMimeType("data.xyz")).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for file with no extension", () => {
    expect(guessMimeType("Makefile")).toBe("application/octet-stream");
  });
});

describe("isAlreadySynced", () => {
  it("returns false when existing is null", () => {
    expect(isAlreadySynced({ mtimeMs: 1000, sizeBytes: 100, isDir: false }, null)).toBe(false);
  });

  it("returns false when existing.sizeBytes is null", () => {
    expect(
      isAlreadySynced(
        { mtimeMs: 1000, sizeBytes: 100, isDir: false },
        { sizeBytes: null, modifiedAt: 1000 },
      ),
    ).toBe(false);
  });

  it("returns false when existing.modifiedAt is null", () => {
    expect(
      isAlreadySynced(
        { mtimeMs: 1000, sizeBytes: 100, isDir: false },
        { sizeBytes: 100, modifiedAt: null },
      ),
    ).toBe(false);
  });

  it("returns true when size and mtime both match", () => {
    expect(
      isAlreadySynced(
        { mtimeMs: 1000, sizeBytes: 100, isDir: false },
        { sizeBytes: 100, modifiedAt: 1000 },
      ),
    ).toBe(true);
  });

  it("returns false when size differs", () => {
    expect(
      isAlreadySynced(
        { mtimeMs: 1000, sizeBytes: 200, isDir: false },
        { sizeBytes: 100, modifiedAt: 1000 },
      ),
    ).toBe(false);
  });

  it("returns false when mtime differs", () => {
    expect(
      isAlreadySynced(
        { mtimeMs: 2000, sizeBytes: 100, isDir: false },
        { sizeBytes: 100, modifiedAt: 1000 },
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2.2: Run to verify tests fail**

```bash
pnpm test -- src/__tests__/syncDecisions.test.ts
```

Expected: FAIL with "Cannot find module '../lib/syncDecisions'"

- [ ] **Step 2.3: Create src/lib/syncDecisions.ts**

```typescript
export interface FileStat {
  mtimeMs: number;
  sizeBytes: number;
  isDir: boolean;
}

export function guessMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = {
    txt: "text/plain", md: "text/markdown", csv: "text/csv",
    html: "text/html", htm: "text/html", xml: "application/xml",
    pdf: "application/pdf", json: "application/json",
    zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
    mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska",
  };
  return map[ext] ?? "application/octet-stream";
}

export function isAlreadySynced(
  stat: FileStat,
  existing: { sizeBytes: number | null; modifiedAt: number | null } | null,
): boolean {
  if (!existing) return false;
  if (existing.sizeBytes === null || existing.modifiedAt === null) return false;
  return stat.sizeBytes === existing.sizeBytes && stat.mtimeMs === existing.modifiedAt;
}
```

- [ ] **Step 2.4: Update sync.ts to import from syncDecisions**

In `src/lib/sync.ts`:

**a) Add imports at the top of the import section:**
```typescript
import { guessMimeType, isAlreadySynced } from "./syncDecisions";
import type { FileStat } from "./syncDecisions";
```

**b) Remove the local `interface FileStat` block (lines ~58–63):**
```typescript
// DELETE THIS:
interface FileStat {
  mtimeMs: number;
  sizeBytes: number;
  isDir: boolean;
}
```

**c) Remove the local `guessMimeType` function (lines ~196–209):**
```typescript
// DELETE THIS:
function guessMimeType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  const map: Record<string, string> = { ... };
  return map[ext] ?? "application/octet-stream";
}
```

**d) Replace the inline skip condition in `handleLocalUpsert`:**
```typescript
// REPLACE:
if (existing && existing.sizeBytes !== null && existing.modifiedAt !== null &&
    stat.sizeBytes === existing.sizeBytes && stat.mtimeMs === existing.modifiedAt) {
  console.log("[sync] skipping upload — size and mtime unchanged:", absPath);
  return;
}

// WITH:
if (isAlreadySynced(stat, existing)) {
  console.log("[sync] skipping upload — size and mtime unchanged:", absPath);
  return;
}
```

- [ ] **Step 2.5: Run all TypeScript tests**

```bash
pnpm test
```

Expected: All tests pass including the 12 new syncDecisions tests.

- [ ] **Step 2.6: Commit**

```bash
git add src/lib/syncDecisions.ts src/__tests__/syncDecisions.test.ts src/lib/sync.ts
git commit -m "refactor: extract guessMimeType and isAlreadySynced to syncDecisions.ts

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Create IPC mock helper

**Files:**
- Create: `src/__tests__/helpers/syncMocks.ts`

- [ ] **Step 3.1: Create helpers directory and syncMocks.ts**

Create `src/__tests__/helpers/syncMocks.ts`:

```typescript
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { vi } from "vitest";
import type { FileState } from "../../lib/sync";

export type IpcHandler = (payload: Record<string, unknown>) => unknown;
export type IpcOverrides = Partial<Record<string, IpcHandler>>;

const DEFAULT_HANDLERS: Record<string, IpcHandler> = {
  get_local_root: () => "/home/test/ProtonDrive",
  get_db_sync_config: () => null,
  set_db_sync_config: () => null,
  get_all_file_states: () => [] as FileState[],
  get_file_state_by_remote_id: () => null,
  get_file_state_by_local_path: () => null,
  stat_local_file: () => null,
  upsert_file_state: () => null,
  delete_file_state: () => null,
  delete_local_file: () => null,
  delete_local_dir: () => null,
  rename_local_file: () => null,
  ensure_local_dir: () => null,
  show_notification: () => null,
  update_tray_status: () => null,
  list_local_dir: () => [] as string[],
  list_dir_recursive: () => [],
};

export function setupIpcMocks(overrides: IpcOverrides = {}): void {
  const handlers = { ...DEFAULT_HANDLERS, ...overrides };
  mockIPC((cmd, payload) => {
    const handler = handlers[cmd];
    if (handler) return handler((payload ?? {}) as Record<string, unknown>);
    throw new Error(`Unmocked IPC command called in test: "${cmd}"`);
  });
}

export function teardownIpcMocks(): void {
  clearMocks();
}

// Drive SDK vi.fn() stubs — assign to vi.mocked(importedFn) in test files
export const mockGetNode = vi.fn();
export const mockGetFileUploader = vi.fn();
export const mockGetFileRevisionUploader = vi.fn();
export const mockStreamDownloadToPath = vi.fn();
export const mockTrashNode = vi.fn();
export const mockFindOrCreateFolder = vi.fn();
export const mockListFolderChildren = vi.fn();
export const mockGetSyncRoot = vi.fn();
export const mockPersistEventAnchor = vi.fn();
export const mockSubscribeToTreeEvents = vi.fn();
```

- [ ] **Step 3.2: Run all tests to verify no regressions**

```bash
pnpm test
```

Expected: All tests still pass (new file not yet imported by any test).

---

## Task 4: Export handlers and test utilities from sync.ts

**Files:**
- Modify: `src/lib/sync.ts`

- [ ] **Step 4.1: Export WatchedFolderEntry type**

Near the top of `src/lib/sync.ts`, the import line is:
```typescript
import type { WatchedFolderEntry, SelectedFolderRecord } from "./syncHelpers";
```

Change it to also re-export `WatchedFolderEntry`:
```typescript
import type { WatchedFolderEntry, SelectedFolderRecord } from "./syncHelpers";
export type { WatchedFolderEntry };
```

- [ ] **Step 4.2: Add @internal export keyword to seven functions**

Find each declaration and add `export` + `/** @internal */`:

```typescript
// BEFORE:
async function waitForFileStable(absPath: string): Promise<FileStat | null> {
// AFTER:
/** @internal */
export async function waitForFileStable(absPath: string): Promise<FileStat | null> {
```

```typescript
// BEFORE:
async function expandFolderUids(
// AFTER:
/** @internal */
export async function expandFolderUids(
```

```typescript
// BEFORE:
async function cleanStaleDbEntries(): Promise<void> {
// AFTER:
/** @internal */
export async function cleanStaleDbEntries(): Promise<void> {
```

```typescript
// BEFORE:
async function handleLocalChange(event: WatchEvent): Promise<void> {
// AFTER:
/** @internal */
export async function handleLocalChange(event: WatchEvent): Promise<void> {
```

```typescript
// BEFORE:
async function handleLocalUpsert(absPath: string, checkStability: boolean): Promise<void> {
// AFTER:
/** @internal */
export async function handleLocalUpsert(absPath: string, checkStability: boolean): Promise<void> {
```

```typescript
// BEFORE:
async function handleRemoteNodeUpdate(nodeUid: string): Promise<void> {
// AFTER:
/** @internal */
export async function handleRemoteNodeUpdate(nodeUid: string): Promise<void> {
```

```typescript
// BEFORE:
async function handleRemoteDelete(nodeUid: string): Promise<void> {
// AFTER:
/** @internal */
export async function handleRemoteDelete(nodeUid: string): Promise<void> {
```

- [ ] **Step 4.3: Add test utility exports at the end of sync.ts**

Append after the last function in `src/lib/sync.ts`:

```typescript
// ── Test utilities (not part of public API) ───────────────────────────────────

/** @internal */
export function _resetSyncStateForTesting(): void {
  suppressUntil.clear();
  recentlyUploaded.clear();
  watchedFolderUids.clear();
  _paused = false;
  _fullSyncInProgress = false;
  _status = { active: [], errors: [] };
  _statusCallback = null;
  _lastErrorNotificationMs = 0;
  if (_trayUpdateTimer) clearTimeout(_trayUpdateTimer);
  _trayUpdateTimer = null;
  _recentlySynced.length = 0;
}

/** @internal */
export function _setWatchedFoldersForTesting(entries: Map<string, WatchedFolderEntry>): void {
  watchedFolderUids.clear();
  for (const [k, v] of entries) watchedFolderUids.set(k, v);
}
```

- [ ] **Step 4.4: Type-check**

```bash
pnpm tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 4.5: Run all TypeScript tests**

```bash
pnpm test
```

Expected: All existing tests still pass (exports are additive).

- [ ] **Step 4.6: Commit**

```bash
git add src/lib/sync.ts
git commit -m "feat(tests): export sync handlers and test utilities for integration testing

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Handler tests — handleLocalChange

**Files:**
- Create: `src/__tests__/syncHandlers.test.ts`

- [ ] **Step 5.1: Write failing tests**

Create `src/__tests__/syncHandlers.test.ts`:

```typescript
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
```

- [ ] **Step 5.2: Run to verify tests fail (IPC not yet set up)**

```bash
pnpm test -- src/__tests__/syncHandlers.test.ts
```

Expected: Tests fail because mockIPC is not yet installed for the `invoke` calls inside handlers.
If the error is "Unmocked IPC command: X", add X to DEFAULT_HANDLERS in syncMocks.ts.

- [ ] **Step 5.3: Add any missing commands to DEFAULT_HANDLERS in syncMocks.ts**

If you see `"Unmocked IPC command called in test: X"`, add:
```typescript
X: () => null,
```
to `DEFAULT_HANDLERS` in `src/__tests__/helpers/syncMocks.ts`.

- [ ] **Step 5.4: Run until all 4 tests pass**

```bash
pnpm test -- src/__tests__/syncHandlers.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add src/__tests__/syncHandlers.test.ts src/__tests__/helpers/syncMocks.ts
git commit -m "test: add handleLocalChange integration tests with mockIPC

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Handler tests — handleLocalUpsert

**Files:**
- Modify: `src/__tests__/syncHandlers.test.ts`

- [ ] **Step 6.1: Add failing tests for handleLocalUpsert**

Add to `src/__tests__/syncHandlers.test.ts` (after the handleLocalChange describe block,
inside the same file with the same imports already present):

```typescript
// ── handleLocalUpsert ─────────────────────────────────────────────────────────

import { handleLocalUpsert } from "../lib/sync";

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
    const fileBytes = new Blob(["hello"]);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(fileBytes),
    } as Response);

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
      expect.objectContaining({ mediaType: "text/plain", expectedSize: 5 }),
    );
    expect(upsertedState).toMatchObject({
      remoteId: "new-uid",
      localPath: `${ROOT}/file.txt`,
      etag: "new-rev",
      syncState: "synced",
    });
  });

  it("calls getFileRevisionUploader for an existing file", async () => {
    const fileBytes = new Blob(["updated"]);
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      blob: () => Promise.resolve(fileBytes),
    } as Response);

    const mockController = {
      completion: vi.fn().mockResolvedValue({ nodeUid: "node-1", nodeRevisionUid: "rev-2" }),
    };
    vi.mocked(getFileRevisionUploader).mockResolvedValue({
      uploadFromFile: vi.fn().mockResolvedValue(mockController),
    } as never);

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
      upsert_file_state: () => null,
      show_notification: () => null,
    });

    await handleLocalUpsert(`${ROOT}/file.txt`, false);

    expect(getFileRevisionUploader).toHaveBeenCalledWith("node-1", expect.any(Object));
  });

  it("skips upload when waitForFileStable returns null (file disappeared)", async () => {
    setupIpcMocks({
      stat_local_file: () => null,
    });
    const mockFetch = vi.mocked(fetch);
    await handleLocalUpsert(`${ROOT}/file.txt`, true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
```

Note: `waitForFileStable` polls with `setTimeout(r, 1_000)` internally. For the "file
disappeared" test, mocking `stat_local_file: () => null` is sufficient because `statFile`
returns `null` immediately, causing `waitForFileStable` to return `null` on the first poll.
Use `vi.useFakeTimers()` only if you need to test the retry logic specifically.

- [ ] **Step 6.2: Run to verify new tests fail**

```bash
pnpm test -- src/__tests__/syncHandlers.test.ts
```

Expected: The 5 new tests appear in the output. Some may fail due to missing IPC handlers.

- [ ] **Step 6.3: Fix any missing IPC commands and run until all pass**

```bash
pnpm test -- src/__tests__/syncHandlers.test.ts
```

Expected: All 9 tests pass (4 from Task 5 + 5 new).

- [ ] **Step 6.4: Commit**

```bash
git add src/__tests__/syncHandlers.test.ts src/__tests__/helpers/syncMocks.ts
git commit -m "test: add handleLocalUpsert integration tests

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 7: Handler tests — handleRemoteDelete

**Files:**
- Modify: `src/__tests__/syncHandlers.test.ts`

- [ ] **Step 7.1: Add failing tests for handleRemoteDelete**

Add after the handleLocalUpsert describe block in `src/__tests__/syncHandlers.test.ts`.
`handleRemoteDelete` is already exported from `../lib/sync` — add it to the imports at the top:

```typescript
// Add to existing sync import line:
import { ..., handleRemoteDelete } from "../lib/sync";
```

Then add the describe block:

```typescript
// ── handleRemoteDelete ────────────────────────────────────────────────────────

import { NodeType } from "@protontech/drive-sdk";

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

    expect(deletedPaths).toContain(`${ROOT}/file.txt`);
    expect(deletedIds).toContain("node-1");
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
```

- [ ] **Step 7.2: Run to verify new tests fail**

```bash
pnpm test -- src/__tests__/syncHandlers.test.ts
```

- [ ] **Step 7.3: Fix any missing IPC handlers and run until all tests pass**

```bash
pnpm test -- src/__tests__/syncHandlers.test.ts
```

Expected: 12 tests pass (9 from Tasks 5–6 + 3 new).

- [ ] **Step 7.4: Commit**

```bash
git add src/__tests__/syncHandlers.test.ts
git commit -m "test: add handleRemoteDelete integration tests

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 8: Handler tests — handleRemoteNodeUpdate

**Files:**
- Modify: `src/__tests__/syncHandlers.test.ts`

- [ ] **Step 8.1: Add failing tests for handleRemoteNodeUpdate**

Add `handleRemoteNodeUpdate` to the sync import at the top of the file, then add:

```typescript
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
    setupIpcMocks({
      get_file_state_by_remote_id: () => ({
        remoteId: "node-1",
        localPath: `${ROOT}/file.txt`,
        etag: "rev-1",
        modifiedAt: 1000,
        sizeBytes: 100,
        syncState: "synced",
      }),
      upsert_file_state: () => null,
      show_notification: () => null,
    });

    await handleRemoteNodeUpdate("node-1");

    expect(streamDownloadToPath).toHaveBeenCalledWith(
      "node-1",
      `${ROOT}/file.txt`,
      expect.any(Function),
    );
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

    expect(ensuredDirs).toContain(`${ROOT}/subdir`);
  });
});
```

- [ ] **Step 8.2: Run to verify new tests fail**

```bash
pnpm test -- src/__tests__/syncHandlers.test.ts
```

- [ ] **Step 8.3: Fix any missing IPC handlers and run until all tests pass**

```bash
pnpm test -- src/__tests__/syncHandlers.test.ts
```

Expected: 16 tests pass (12 from earlier tasks + 4 new).

- [ ] **Step 8.4: Run the full TypeScript test suite**

```bash
pnpm test
```

Expected: All tests pass. Summary should show:
- `syncDecisions.test.ts` — 12 tests
- `syncHandlers.test.ts` — 16 tests
- Existing `sync.test.ts`, `conflictResolution.test.ts`, `folderTree.test.ts`, `i18n.test.ts` — 53 tests
- Total: 81+ TypeScript tests

- [ ] **Step 8.5: Commit**

```bash
git add src/__tests__/syncHandlers.test.ts
git commit -m "test: add handleRemoteNodeUpdate integration tests — completes Level 1 handler coverage

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 9: Rust — within_sync_root and canonical tests

**Files:**
- Modify: `src-tauri/src/commands.rs`

- [ ] **Step 9.1: Check the in-memory Db constructor name**

```bash
grep -n "open_in_memory\|fn open\|pub fn new" src-tauri/src/db.rs | head -10
```

Note the exact method name. The tests below use `Db::open_in_memory()` — adjust if different.

- [ ] **Step 9.2: Write failing path guard tests**

Add inside the `#[cfg(test)] mod tests` block in `src-tauri/src/commands.rs` (after the
last existing test):

```rust
// ── canonical ────────────────────────────────────────────────────────────────

#[test]
fn canonical_returns_canonical_path_for_existing_file() {
    let dir = TempDir::new().unwrap();
    let file = dir.path().join("real.txt");
    fs::write(&file, "data").unwrap();
    let result = canonical(file.to_str().unwrap()).unwrap();
    assert!(result.is_absolute());
    assert!(result.exists());
}

#[test]
fn canonical_resolves_nonexistent_file_in_existing_parent() {
    let dir = TempDir::new().unwrap();
    let ghost = dir.path().join("ghost.txt");
    let result = canonical(ghost.to_str().unwrap()).unwrap();
    assert_eq!(result.file_name().unwrap(), "ghost.txt");
    assert!(!result.exists());
}

#[test]
fn canonical_fails_when_parent_directory_does_not_exist() {
    let result = canonical("/does/not/exist/anywhere/file.txt");
    assert!(result.is_err());
    assert!(
        result.unwrap_err().to_string().contains("canonicalize parent"),
        "expected 'canonicalize parent' in error"
    );
}

// ── within_sync_root ──────────────────────────────────────────────────────────

fn make_db_with_root(root: &str) -> Db {
    let db = Db::open_in_memory().unwrap();
    db.set_sync_config("local_root", root).unwrap();
    db
}

#[test]
fn within_sync_root_accepts_path_inside_root() {
    let dir = TempDir::new().unwrap();
    let db = make_db_with_root(dir.path().to_str().unwrap());
    let file = dir.path().join("file.txt");
    fs::write(&file, "x").unwrap();
    assert!(within_sync_root(file.to_str().unwrap(), &db).is_ok());
}

#[test]
fn within_sync_root_rejects_path_outside_root() {
    let root_dir = TempDir::new().unwrap();
    let other_dir = TempDir::new().unwrap();
    let db = make_db_with_root(root_dir.path().to_str().unwrap());
    let outside = other_dir.path().join("secret.txt");
    fs::write(&outside, "x").unwrap();
    let result = within_sync_root(outside.to_str().unwrap(), &db);
    assert!(result.is_err());
    assert!(
        result.unwrap_err().to_string().contains("outside sync root"),
        "expected 'outside sync root' in error"
    );
}

#[test]
fn within_sync_root_rejects_dotdot_traversal() {
    let dir = TempDir::new().unwrap();
    let db = make_db_with_root(dir.path().to_str().unwrap());
    let traversal = format!("{}/../../../etc/passwd", dir.path().display());
    let result = within_sync_root(&traversal, &db);
    assert!(result.is_err(), "dotdot traversal should be rejected");
}

#[test]
fn within_sync_root_returns_error_when_root_not_configured() {
    let db = Db::open_in_memory().unwrap();
    let result = within_sync_root("/any/path/file.txt", &db);
    assert!(result.is_err());
    assert!(
        result.unwrap_err().to_string().contains("not configured"),
        "expected 'not configured' in error"
    );
}
```

- [ ] **Step 9.3: Run to verify tests fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | grep -E "^error|FAILED" | head -10
```

Expected: Compilation error if `Db::open_in_memory` is named differently, or test failures
if `make_db_with_root` method names are wrong. Fix method names to match `db.rs`.

- [ ] **Step 9.4: Run path guard tests until they pass**

```bash
cargo test --manifest-path src-tauri/Cargo.toml canonical within_sync_root 2>&1 | tail -15
```

Expected: 7 new tests pass.

- [ ] **Step 9.5: Run full Rust test suite**

```bash
cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: All tests pass (previous 52 + 7 new = 59+).

- [ ] **Step 9.6: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "test(security): add unit tests for canonical() and within_sync_root() path guards

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 10: Rust — auth.rs tests

**Files:**
- Modify: `src-tauri/src/auth.rs`

- [ ] **Step 10.1: Write failing auth tests**

Append to `src-tauri/src/auth.rs` after the last `impl` block:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_succeeds_with_valid_app_version() {
        let result = ProtonAuth::new(
            "https://api.proton.me",
            "external-drive-protondrive-linux@0.1.0-alpha",
        );
        assert!(result.is_ok());
    }

    #[test]
    fn new_returns_error_for_app_version_with_newline() {
        let result = ProtonAuth::new("https://api.proton.me", "version\nnewline");
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("invalid header characters"),
            "expected 'invalid header characters' in error, got: {msg}"
        );
    }

    #[test]
    fn new_returns_error_for_app_version_with_null_byte() {
        let result = ProtonAuth::new("https://api.proton.me", "version\0null");
        assert!(result.is_err());
    }
}
```

- [ ] **Step 10.2: Run to verify tests fail (module not yet present)**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- auth::tests 2>&1 | grep -E "error|FAILED" | head -5
```

Expected: Compile error "no test module" or test failures — confirms the tests are new.

- [ ] **Step 10.3: Run until tests pass**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -- auth::tests 2>&1 | tail -10
```

Expected: 3 tests pass.

- [ ] **Step 10.4: Run full Rust test suite**

```bash
cargo test --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: All tests pass (59+ + 3 new = 62+).

- [ ] **Step 10.5: Commit**

```bash
git add src-tauri/src/auth.rs
git commit -m "test: add ProtonAuth::new tests for valid and invalid app_version headers

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 11: Level 2 design notes (pinned for later)

**Files:**
- Create: `docs/superpowers/specs/sync-level2-design.md`

- [ ] **Step 11.1: Write the Level 2 design notes**

Create `docs/superpowers/specs/sync-level2-design.md`:

```markdown
# Sync Engine Level 2 Test Design (Pinned)

*Date: 2026-05-24*

## What is Level 2

Level 1 tests (implemented in Task 5–8) cover individual handler functions called in
isolation. Level 2 tests cover the full startup and subscription lifecycle:
`startSync`, `initialSyncLocalFolder`, `initialSyncRemoteFolder`, `triggerFullSync`.

## Why Pinned

`startSync` calls `listen("sync://local-change", ...)` from `@tauri-apps/api/event`.
To fire synthetic local-change events in tests we need mockIPC with `shouldMockEvents: true`
and `emit("sync://local-change", payload)`. This is available in @tauri-apps/api/mocks
since version 2.7.0, but requires careful setup.

## Flows to Test

### startSync() lifecycle
- Calls `get_local_root` and `get_db_sync_config("selected_folders")` via IPC
- Calls `getSyncRoot()` from Drive SDK
- Calls `buildWatchedFolderMap` → `expandFolderUids` → `listFolderChildren`
- Registers Drive event subscription via `subscribeToTreeEvents`
- Registers local-change Tauri listener via `listen("sync://local-change", ...)`
- Returns a cleanup function that calls `unlisten()`, `subscription.dispose()`,
  and `clearInterval(periodicInterval)`

### initialSyncLocalFolder()
- Calls `list_dir_recursive` for `mode === "recursive"` folders
- Calls `list_local_dir` for `mode === "files"` folders
- Calls `handleLocalUpsert(path, false)` for each returned entry

### initialSyncRemoteFolder()
- Calls `listFolderChildren` for each watched folder
- Skips files where `etag` matches the existing DB revision uid
- Calls `handleRemoteNodeUpdate` for changed/new files

### triggerFullSync()
- Is a no-op when `watchedFolderUids` is empty
- Is a no-op when `_fullSyncInProgress` is already true (concurrent call guard)
- Calls `cleanStaleDbEntries` → `initialSyncFolder` → `initialSyncLocalFolder`

## Mock Setup for Level 2

```typescript
// @vitest-environment jsdom
import { mockIPC, clearMocks } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";

mockIPC(myHandler, { shouldMockEvents: true });

// Simulate a local-change event:
await emit("sync://local-change", { absPath: "/home/test/ProtonDrive/file.txt", kind: "create" });
```

## Prerequisite

Verify `@tauri-apps/api` version supports `shouldMockEvents`:
```bash
node -e "const m = require('./node_modules/@tauri-apps/api/mocks.d.ts'); console.log('ok')" 2>/dev/null || grep shouldMockEvents node_modules/@tauri-apps/api/mocks.d.ts
```

`shouldMockEvents` was added in @tauri-apps/api 2.7.0.
```

- [ ] **Step 11.2: Commit**

```bash
git add docs/superpowers/specs/sync-level2-design.md
git commit -m "docs: add Level 2 sync test design notes (pinned for later session)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Self-Review

| Spec requirement | Task | Has executable code |
|-----------------|------|-------------------|
| jsdom installation and verification | 1 | Yes |
| syncDecisions.ts pure functions | 2 | Yes |
| IPC mock infrastructure | 3 | Yes |
| @internal exports from sync.ts | 4 | Yes |
| handleLocalChange: pd-tmp, paused, delete, dir-create | 5 | Yes |
| handleLocalUpsert: no-folder, already-synced, new upload, revision, disappeared | 6 | Yes |
| handleRemoteDelete: file, dir, unknown via getNode | 7 | Yes |
| handleRemoteNodeUpdate: skip revision, skip parent, download, folder | 8 | Yes |
| within_sync_root + canonical Rust tests | 9 | Yes |
| auth.rs header validation tests | 10 | Yes |
| Level 2 pinned and documented | 11 | Yes |

No placeholder steps, no TBD items, no missing type references.
