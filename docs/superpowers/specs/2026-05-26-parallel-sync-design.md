# Parallel Sync — Design Spec

**Date:** 2026-05-26
**Status:** Approved

## Problem

Downloads and uploads are fully sequential. Every file waits for the previous one to complete
before starting. For a folder with 200 files this means 200 HTTP round trips in series —
the bottleneck is pure request latency, not bandwidth.

## Goal

Parallelize both downloads and uploads with bounded concurrency, run the two directions
simultaneously, and surface meaningful progress in the tray UI.

---

## Architecture

### New file: `src/lib/sync/concurrency.ts`

A `Semaphore` class with a fixed cap. Module-level instances:

```ts
export const downloadSemaphore = new Semaphore(DOWNLOAD_CONCURRENCY); // 6
export const uploadSemaphore   = new Semaphore(UPLOAD_CONCURRENCY);   // 4
```

Constants `DOWNLOAD_CONCURRENCY = 6` and `UPLOAD_CONCURRENCY = 4` defined at the top.
Separate caps because uploads are heavier (CPU for encryption, full file read into memory)
while downloads are mostly network-bound.

`Semaphore` API:
```ts
class Semaphore {
  constructor(cap: number)
  /** Runs fn(), acquiring a slot before and releasing after (even on throw). */
  run<T>(fn: () => Promise<T>): Promise<T>
  /** Number of tasks currently waiting for a slot. */
  get queued(): number
  /** Reset to initial state (for tests). */
  reset(): void
}
```

**`CoalescingQueue`** — used for live events only (not batch). Ensures at most one
in-flight + one pending operation per key (node UID for downloads, local path for uploads).
If a second event arrives for a key already in-flight, it is marked pending; when the
in-flight completes it runs once more with a fresh `fn` call (picking up the latest state).
Any number of intermediate events collapse into that single re-run. Internally uses a
`Semaphore` for the actual concurrency cap.

```ts
class CoalescingQueue {
  constructor(semaphore: Semaphore)
  /** Fire-and-forget. Deduplicates by key; at most one in-flight + one pending per key. */
  enqueue(key: string, fn: () => Promise<void>): void
  /** Number of keys currently in-flight. */
  get activeCount(): number
  /** Reset to initial state (for tests). */
  reset(): void
}
```

### `src/lib/sync/concurrency.ts` — module exports

```
Semaphore           (class)
CoalescingQueue     (class)
downloadSemaphore   (Semaphore instance, cap 6)
uploadSemaphore     (Semaphore instance, cap 4)
downloadQueue       (CoalescingQueue wrapping downloadSemaphore)
uploadQueue         (CoalescingQueue wrapping uploadSemaphore)
DOWNLOAD_CONCURRENCY
UPLOAD_CONCURRENCY
```

### Changes to existing files

| File | Change |
|------|--------|
| `src/lib/sync/reconciliation.ts` | Two-pass download fan-out; `Promise.all` for up+down |
| `src/lib/sync/remote-to-local.ts` | `handleRemoteNodeUpdate` acquires `downloadSemaphore` |
| `src/lib/sync/local-to-remote.ts` | `handleLocalUpsert` acquires `uploadSemaphore` |
| `src/lib/sync/index.ts` | `Promise.all([initialSyncFolder(), initialSyncLocalFolder()])` |
| `src/types/sync.ts` | Add `queuedDown` and `queuedUp` to `TrayStatusPayload` |
| `src/lib/sync/state.ts` | Pass `queuedDown`/`queuedUp` in `scheduleTrayUpdate` |

---

## Data Flow

### Initial sync (startup + periodic full sync)

```
Promise.all([
  initialSyncFolder(),        ← downloads, up to 6 concurrent
  initialSyncLocalFolder(),   ← uploads,   up to 4 concurrent
])
```

`initialSyncFolder()` works in two passes:

1. **Collect pass** — iterate `listFolderChildren` for all watched folders, compare revision UID
   against DB. Build `toDownload: string[]` (node UIDs that need downloading). Fast — metadata only.
2. **Fan-out pass** — `Promise.all(toDownload.map(uid => downloadSemaphore.run(() => handleRemoteNodeUpdate(uid))))`.
   Tray gets `total = toDownload.length` upfront; a counter tracks completed for progress display.

`initialSyncLocalFolder()` does the same: collect paths needing upload, then fan out with `uploadSemaphore`.

### Live events (ongoing)

The two event listeners (`subscribeToTreeEvents` and `listen("sync://local-change")`) are already
on separate callbacks and already interleave freely. The change: callbacks enqueue work into the
`CoalescingQueue` instead of awaiting directly:

```ts
subscribeToTreeEvents(scopeId, (event) => {
  if (event type is NodeCreated/NodeUpdated)
    downloadQueue.enqueue(event.nodeUid, () => handleRemoteNodeUpdate(event.nodeUid));
});

listen("sync://local-change", (e) => {
  uploadQueue.enqueue(e.payload.absPath, () => handleLocalChange(e.payload));
});
```

The `CoalescingQueue` guarantees: if the same node UID or path fires twice before the first
completes, the second becomes a single re-run after the first finishes — no concurrent writes
to the same file, no missed updates. The internal `Semaphore` caps total concurrency across all
live events of each direction.

Live events keep individual desktop notifications (they arrive spaced out; user expects immediate feedback).

### Tray status

`activeCount` already reflects live concurrency via `markActive`/`markInactive`.
New fields `queuedDown` and `queuedUp` are read from `downloadSemaphore.queued` and
`uploadSemaphore.queued` in `scheduleTrayUpdate`. `TrayPopup.tsx` shows these counts
when non-zero: "Syncing 6, 14 queued" during a large batch, collapsing to the existing
"Syncing N files" display when the queue is empty.

---

## Notifications

| Scenario | Behaviour |
|----------|-----------|
| Initial sync / full sync batch | Per-file notifications suppressed; one summary fires at the end: "Downloaded N files" / "Uploaded N files". Summary suppressed if N = 0. |
| Live single-file event | Per-file notification kept (individual feedback expected). |
| N = 1 in a batch | Treat as individual — show the filename. |

Batch mode works as follows: `initialSyncFolder` and `initialSyncLocalFolder` suppress
per-file notifications internally — they do not pass a flag into the handler. Instead,
after all fan-out promises resolve, they call `showNotification` once with the final
count (tracked via a local `let downloaded = 0` counter incremented inside each
`downloadSemaphore.run()` call on success). `handleRemoteNodeUpdate` and
`handleLocalUpsert` receive an optional `silent: boolean` parameter (default `false`)
that skips their internal `showNotification` call when true. Batch callers pass `silent: true`.

---

## Error Handling

No change to the per-file error model. Each `handleRemoteNodeUpdate` and `handleLocalUpsert`
has its own try/catch → `recordError`. A failed download does not block the remaining semaphore slots.

`Semaphore.run()` releases the slot in a `finally` block — no deadlock possible even if the
task throws or hangs. A hung task holds one slot indefinitely (network stall), but the other
5 slots keep running. This is acceptable for a personal sync client with no explicit timeout
requirement.

---

## Known Limitations & Edge Cases

### Event anchor advancement
`persistEventAnchor` is called in the `handleDriveEvent` callback immediately after routing
the event to the CoalescingQueue — before the download completes. If the app crashes mid-download,
that event's anchor is already advanced and the event will not replay on restart. The file will
be picked up by the next 5-minute `triggerFullSync`. Accepted trade-off for simplicity.

### Pause behavior
`_paused` is checked at the top of `handleDriveEvent` and `handleLocalChange` (at enqueue time).
Tasks already in the CoalescingQueue when pause is requested will still execute. To stop
mid-queue, `_paused` is also checked at the start of `handleRemoteNodeUpdate` and
`handleLocalUpsert` (at execution time). This means pause takes effect within one in-flight
operation's completion rather than instantly.

### `TreeRefresh` / `FastForward` events
These trigger a full `initialSyncFolder()` re-scan, not a single-node download. They bypass
the CoalescingQueue and call `onFullRefresh()` directly. The `_fullSyncInProgress` guard
prevents stacking: if a full sync is already running when a `TreeRefresh` arrives, the
event is acknowledged (anchor advanced) but the redundant re-scan is skipped.

### Batch vs live overlap
`triggerFullSync` (periodic) uses `downloadSemaphore.run()` directly; simultaneous live events
use `downloadQueue` (which wraps the same semaphore). They do not share per-key deduplication.
A live event arriving for a node that is also being downloaded in a concurrent full sync could
result in two downloads of the same file. This is safe: `streamDownloadToPath` writes to
`.pd-tmp` then renames atomically, and the DB upsert is idempotent. Accepted as a known
low-frequency edge case.

---

## Testing

### `concurrency.test.ts` (new)

**Semaphore:**
- Respects cap: dispatch cap+2 tasks, verify no more than cap run simultaneously
  (counter increments on entry, asserts ≤ cap, decrements on exit).
- Queue ordering: tasks queued beyond cap execute in FIFO order.
- Release on throw: a task that throws still releases its slot; subsequent tasks proceed.
- `queued` getter: returns correct count before and after tasks complete.

**CoalescingQueue:**
- Deduplication: enqueue the same key twice while first is in-flight → only two total
  executions (the in-flight one + one re-run), not three.
- No duplicate concurrent writes: verify the same key is never running more than once at a time.
- Independent keys run in parallel up to the semaphore cap.
- A key that throws in its fn still allows re-run on next enqueue.

### Updated reconciliation / handler tests

- Mock `downloadSemaphore` and `uploadSemaphore` — verify `run()` is called once per file.
- Verify `initialSyncFolder` + `initialSyncLocalFolder` are launched with `Promise.all`
  (assert both start before either finishes by tracking call order with fake timers).
- Summary notification test: N files processed → exactly one notification with "Downloaded N files".

### Existing tests

No changes required. They mock `handleRemoteNodeUpdate` and `handleLocalUpsert` at the function
boundary, so the semaphore is never entered.

---

## File Map

| File | Action |
|------|--------|
| `src/lib/sync/concurrency.ts` | Create — `Semaphore`, `CoalescingQueue`, instances, constants |
| `src/lib/sync/reconciliation.ts` | Modify — two-pass fan-out, `Promise.all`, batch notification |
| `src/lib/sync/remote-to-local.ts` | Modify — acquire `downloadSemaphore` in `handleRemoteNodeUpdate` |
| `src/lib/sync/local-to-remote.ts` | Modify — acquire `uploadSemaphore` in `handleLocalUpsert` |
| `src/lib/sync/index.ts` | Modify — `Promise.all` for initial sync phases, `CoalescingQueue` for live events |
| `src/types/sync.ts` | Modify — add `queuedDown`, `queuedUp` to `TrayStatusPayload` |
| `src/lib/sync/state.ts` | Modify — pass queue counts in `scheduleTrayUpdate` |
| `src/__tests__/concurrency.test.ts` | Create — Semaphore unit tests |
| `src/components/TrayPopup.tsx` | Modify — show queued counts when non-zero |
