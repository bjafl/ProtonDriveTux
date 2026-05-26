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

### `src/lib/sync/concurrency.ts` — module exports

```
Semaphore         (class)
downloadSemaphore (instance, cap 6)
uploadSemaphore   (instance, cap 4)
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
on separate callbacks and already interleave freely. The change: callbacks fire-and-forget instead
of awaiting:

```ts
subscribeToTreeEvents(scopeId, (event) => {
  handleDriveEvent(event, initialSyncFolder).catch(console.error);
});
```

The semaphore inside `handleRemoteNodeUpdate` / `handleLocalUpsert` controls actual concurrency.
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

## Testing

### `concurrency.test.ts` (new)

- `Semaphore` respects cap: dispatch cap+2 tasks, verify no more than cap run simultaneously
  (use a counter that increments on entry, asserts ≤ cap, decrements on exit).
- Queue ordering: tasks queued beyond cap execute in FIFO order.
- Release on throw: a task that throws still releases its slot; subsequent tasks proceed.
- `queued` getter: returns correct count before and after tasks complete.

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
| `src/lib/sync/concurrency.ts` | Create — `Semaphore`, instances, constants |
| `src/lib/sync/reconciliation.ts` | Modify — two-pass fan-out, `Promise.all`, batch notification |
| `src/lib/sync/remote-to-local.ts` | Modify — acquire `downloadSemaphore` in `handleRemoteNodeUpdate` |
| `src/lib/sync/local-to-remote.ts` | Modify — acquire `uploadSemaphore` in `handleLocalUpsert` |
| `src/lib/sync/index.ts` | Modify — `Promise.all` for initial sync phases, fire-and-forget live events |
| `src/types/sync.ts` | Modify — add `queuedDown`, `queuedUp` to `TrayStatusPayload` |
| `src/lib/sync/state.ts` | Modify — pass queue counts in `scheduleTrayUpdate` |
| `src/__tests__/concurrency.test.ts` | Create — Semaphore unit tests |
| `src/components/TrayPopup.tsx` | Modify — show queued counts when non-zero |
