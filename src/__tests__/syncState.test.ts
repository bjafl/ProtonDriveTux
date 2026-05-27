// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  suppressPath,
  isSuppressed,
  SUPPRESS_MS,
  suppressUntil,
  addRecentlySynced,
  _recentlySynced,
  markActive,
  markInactive,
  getSyncStatus,
  pauseSync,
  resumeSync,
  isSyncPaused,
  recordError,
  scheduleTrayUpdate,
  statFile,
  setSyncStatusCallback,
  _resetSyncStateForTesting,
  _lastErrorNotificationMs,
  ERROR_NOTIFY_THROTTLE_MS,
  setLastErrorNotificationMs,
  _trayUpdateTimer,
  _status,
  setStatus,
  setStatusCallback,
  setPaused,
  setTrayUpdateTimer,
  _fullSyncInProgress,
  setFullSyncInProgress,
} from "../lib/sync/state";
import { downloadSemaphore, DOWNLOAD_CONCURRENCY } from "../lib/sync/concurrency";
import { setupIpcMocks, teardownIpcMocks } from "./helpers/syncMocks";

beforeEach(() => {
  _resetSyncStateForTesting();
  setupIpcMocks();
});

afterEach(() => {
  teardownIpcMocks();
  vi.useRealTimers();
});

// ── suppressPath / isSuppressed ──────────────────────────────────────────────

describe("suppressPath / isSuppressed", () => {
  it("returns false for unknown path", () => {
    expect(isSuppressed("/home/user/file.txt")).toBe(false);
  });

  it("returns true immediately after suppress", () => {
    suppressPath("/home/user/file.txt");
    expect(isSuppressed("/home/user/file.txt")).toBe(true);
  });

  it("returns false after suppression window expires and removes the map entry", () => {
    vi.useFakeTimers();
    suppressPath("/home/user/file.txt");
    expect(suppressUntil.has("/home/user/file.txt")).toBe(true);
    vi.advanceTimersByTime(SUPPRESS_MS + 1);
    expect(isSuppressed("/home/user/file.txt")).toBe(false);
    expect(suppressUntil.has("/home/user/file.txt")).toBe(false);
  });

  it("paths are independent — suppressing one does not affect others", () => {
    suppressPath("/a/b.txt");
    expect(isSuppressed("/a/c.txt")).toBe(false);
    expect(isSuppressed("/a/b.txt")).toBe(true);
  });
});

// ── addRecentlySynced ────────────────────────────────────────────────────────

describe("addRecentlySynced", () => {
  it("extracts the file name and records direction", () => {
    addRecentlySynced("/home/user/docs/report.pdf", "up");
    expect(_recentlySynced).toHaveLength(1);
    expect(_recentlySynced[0]).toEqual({ name: "report.pdf", direction: "up" });
  });

  it("prepends so the most recent file is first", () => {
    addRecentlySynced("/a/first.txt", "up");
    addRecentlySynced("/a/second.txt", "down");
    expect(_recentlySynced[0].name).toBe("second.txt");
    expect(_recentlySynced[1].name).toBe("first.txt");
  });

  it("caps the list at 10 items by dropping the oldest", () => {
    for (let i = 0; i < 15; i++) {
      addRecentlySynced(`/a/file${i}.txt`, "up");
    }
    expect(_recentlySynced).toHaveLength(10);
    expect(_recentlySynced[0].name).toBe("file14.txt");
  });

  it("uses the full path as name when there is no slash", () => {
    addRecentlySynced("flat-file.txt", "down");
    expect(_recentlySynced[0].name).toBe("flat-file.txt");
  });
});

// ── markActive / markInactive ────────────────────────────────────────────────

describe("markActive / markInactive", () => {
  it("adds label to active list", () => {
    markActive("upload://file.txt");
    expect(getSyncStatus().active).toContain("upload://file.txt");
  });

  it("does not duplicate labels", () => {
    markActive("upload://file.txt");
    markActive("upload://file.txt");
    const active = getSyncStatus().active.filter((x) => x === "upload://file.txt");
    expect(active).toHaveLength(1);
  });

  it("removes label with markInactive", () => {
    markActive("upload://file.txt");
    markInactive("upload://file.txt");
    expect(getSyncStatus().active).not.toContain("upload://file.txt");
  });

  it("markInactive on non-existent label is a no-op", () => {
    markInactive("ghost");
    expect(getSyncStatus().active).toHaveLength(0);
  });

  it("notifies the status callback on markActive", () => {
    const cb = vi.fn();
    setSyncStatusCallback(cb);
    markActive("test");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("notifies the status callback on markInactive", () => {
    const cb = vi.fn();
    markActive("test");
    setSyncStatusCallback(cb);
    markInactive("test");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("multiple independent labels coexist", () => {
    markActive("a");
    markActive("b");
    markInactive("a");
    expect(getSyncStatus().active).toContain("b");
    expect(getSyncStatus().active).not.toContain("a");
  });
});

// ── pauseSync / resumeSync ───────────────────────────────────────────────────

describe("pauseSync / resumeSync", () => {
  it("starts unpaused", () => {
    expect(isSyncPaused()).toBe(false);
  });

  it("pauses sync", () => {
    pauseSync();
    expect(isSyncPaused()).toBe(true);
  });

  it("pause is idempotent — callback fires only once", () => {
    const cb = vi.fn();
    setSyncStatusCallback(cb);
    pauseSync();
    pauseSync();
    expect(cb).toHaveBeenCalledOnce();
  });

  it("resumes sync after pausing", () => {
    pauseSync();
    resumeSync();
    expect(isSyncPaused()).toBe(false);
  });

  it("resume is idempotent when not paused — callback not fired", () => {
    const cb = vi.fn();
    setSyncStatusCallback(cb);
    resumeSync();
    expect(cb).not.toHaveBeenCalled();
  });

  it("resume fires the callback after actual pause", () => {
    pauseSync();
    const cb = vi.fn();
    setSyncStatusCallback(cb);
    resumeSync();
    expect(cb).toHaveBeenCalledOnce();
  });
});

// ── getSyncStatus ────────────────────────────────────────────────────────────

describe("getSyncStatus", () => {
  it("returns shallow copies of active and errors arrays", () => {
    markActive("upload://file.txt");
    const status = getSyncStatus();
    status.active.push("mutated");
    expect(getSyncStatus().active).not.toContain("mutated");
  });

  it("reflects both active labels and recorded errors", () => {
    markActive("test-label");
    _status.errors.push({ path: "/a/b.txt", error: "oops" });
    const status = getSyncStatus();
    expect(status.active).toContain("test-label");
    expect(status.errors).toHaveLength(1);
  });
});

// ── setSyncStatusCallback ────────────────────────────────────────────────────

describe("setSyncStatusCallback", () => {
  it("replaces a previous callback", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    setSyncStatusCallback(cb1);
    setSyncStatusCallback(cb2);
    markActive("x");
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalled();
  });

  it("clears callback when null is passed", () => {
    const cb = vi.fn();
    setSyncStatusCallback(cb);
    setSyncStatusCallback(null);
    markActive("x");
    expect(cb).not.toHaveBeenCalled();
  });
});

// ── recordError ──────────────────────────────────────────────────────────────

describe("recordError", () => {
  it("appends error to the status", () => {
    recordError("/a/b.txt", "something failed");
    const { errors } = getSyncStatus();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({ path: "/a/b.txt", error: "something failed" });
  });

  it("caps error list at 20 by dropping oldest entries", () => {
    for (let i = 0; i < 25; i++) {
      recordError(`/a/file${i}.txt`, "err");
    }
    const { errors } = getSyncStatus();
    expect(errors).toHaveLength(20);
    expect(errors[0].path).toBe("/a/file5.txt");
  });

  it("updates _lastErrorNotificationMs on first error", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    expect(_lastErrorNotificationMs).toBe(0);
    recordError("/a/file.txt", "disk full");
    expect(_lastErrorNotificationMs).toBe(50_000);
  });

  it("does not update notification timestamp again within throttle window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    recordError("/a/file.txt", "first");
    vi.setSystemTime(50_000 + ERROR_NOTIFY_THROTTLE_MS - 1);
    recordError("/a/file2.txt", "second");
    expect(_lastErrorNotificationMs).toBe(50_000);
  });

  it("sends another notification after the throttle window expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(50_000);
    recordError("/a/file.txt", "first");
    vi.setSystemTime(50_000 + ERROR_NOTIFY_THROTTLE_MS);
    recordError("/a/file2.txt", "second");
    expect(_lastErrorNotificationMs).toBe(50_000 + ERROR_NOTIFY_THROTTLE_MS);
  });
});

// ── scheduleTrayUpdate ───────────────────────────────────────────────────────

describe("scheduleTrayUpdate", () => {
  it("fires the update_tray_status IPC command after 400 ms debounce", async () => {
    const calls: Array<Record<string, unknown>> = [];
    setupIpcMocks({ update_tray_status: (payload) => { calls.push(payload); return null; } });

    vi.useFakeTimers();
    scheduleTrayUpdate();
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
  });

  it("coalesces rapid calls — only fires once after the last call", async () => {
    const calls: Array<Record<string, unknown>> = [];
    setupIpcMocks({ update_tray_status: (payload) => { calls.push(payload); return null; } });

    vi.useFakeTimers();
    scheduleTrayUpdate();
    scheduleTrayUpdate();
    scheduleTrayUpdate();
    await vi.advanceTimersByTimeAsync(400);
    expect(calls).toHaveLength(1);
  });

  it("includes correct syncing and paused state in the payload", async () => {
    const calls: Array<Record<string, unknown>> = [];
    setupIpcMocks({ update_tray_status: (payload) => { calls.push(payload); return null; } });

    markActive("upload://file.txt");
    pauseSync();
    vi.useFakeTimers();
    scheduleTrayUpdate();
    await vi.advanceTimersByTimeAsync(400);

    expect(calls[0]).toMatchObject({ paused: true, syncing: true, activeCount: 1 });
  });

  it("forwards queuedDown from downloadSemaphore into the tray status payload", async () => {
    const calls: Array<Record<string, unknown>> = [];
    setupIpcMocks({ update_tray_status: (payload) => { calls.push(payload); return null; } });

    // Fill all slots so the next task must queue
    let releaseSlot!: () => void;
    const blocker = downloadSemaphore.run(
      () => new Promise<void>((r) => { releaseSlot = r; }),
    );
    const fillerReleasers: Array<() => void> = [];
    const fillers = Array.from({ length: DOWNLOAD_CONCURRENCY - 1 }, () =>
      downloadSemaphore.run(() => new Promise<void>((r) => { fillerReleasers.push(r); })),
    );

    // Enqueue one more — it must wait (queued = 1).
    // Its resolver is only assigned once a slot opens, so we just discard the promise.
    const queued = downloadSemaphore.run(() => Promise.resolve());

    expect(downloadSemaphore.queued).toBe(1);

    vi.useFakeTimers();
    scheduleTrayUpdate();
    await vi.advanceTimersByTimeAsync(400);

    expect(calls).toHaveLength(1);
    expect(calls[0]["queuedDown"]).toBe(1);

    // Cleanup: release all held slots so the semaphore drains
    releaseSlot();
    fillerReleasers.forEach((r) => r());
    vi.useRealTimers();
    await Promise.allSettled([blocker, queued, ...fillers]);
    downloadSemaphore.reset();
  });
});

// ── Module-level setters ─────────────────────────────────────────────────────

describe("module-level setters", () => {
  it("setStatus replaces the status object", () => {
    setStatus({ active: ["test"], errors: [] });
    expect(getSyncStatus().active).toContain("test");
  });

  it("setStatusCallback replaces the callback", () => {
    const cb = vi.fn();
    setStatusCallback(cb);
    markActive("x");
    expect(cb).toHaveBeenCalled();
  });

  it("setLastErrorNotificationMs updates the throttle timestamp", () => {
    setLastErrorNotificationMs(99_999);
    expect(_lastErrorNotificationMs).toBe(99_999);
  });

  it("setPaused sets the paused flag without calling notifyStatus", () => {
    const cb = vi.fn();
    setSyncStatusCallback(cb);
    setPaused(true);
    expect(isSyncPaused()).toBe(true);
    expect(cb).not.toHaveBeenCalled();
  });

  it("setTrayUpdateTimer replaces the timer reference", () => {
    vi.useFakeTimers();
    const t = setTimeout(() => {}, 5_000);
    setTrayUpdateTimer(t);
    expect(_trayUpdateTimer).toBe(t);
    clearTimeout(t);
  });

  it("setFullSyncInProgress updates the flag", () => {
    setFullSyncInProgress(true);
    expect(_fullSyncInProgress).toBe(true);
  });
});

// ── statFile ─────────────────────────────────────────────────────────────────

describe("statFile", () => {
  it("returns the stat from IPC on success", async () => {
    const stat = { mtimeMs: 1_000_000, sizeBytes: 42 };
    setupIpcMocks({ stat_local_file: () => stat });
    const result = await statFile("/home/user/file.txt");
    expect(result).toEqual(stat);
  });

  it("returns null when IPC throws", async () => {
    setupIpcMocks({
      stat_local_file: () => { throw new Error("file not found"); },
    });
    const result = await statFile("/home/user/missing.txt");
    expect(result).toBeNull();
  });
});
