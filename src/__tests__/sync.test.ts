import { describe, it, expect } from "vitest";
import { findWatchedFolderByPath } from "../lib/syncHelpers";
import type { WatchedFolderEntry, SelectedFolderRecord } from "../lib/syncHelpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRecord(uid: string, drivePath: string, mode: "files" | "recursive" = "recursive"): SelectedFolderRecord {
  return { uid, name: uid, drivePath, mode };
}

function makeEntry(localDir: string, uid = "uid"): WatchedFolderEntry {
  return { localDir, selectedRoot: makeRecord(uid, localDir) };
}

function makeMap(entries: Array<[string, WatchedFolderEntry]>): Map<string, WatchedFolderEntry> {
  return new Map(entries);
}

// ── findWatchedFolderByPath ───────────────────────────────────────────────────

describe("findWatchedFolderByPath", () => {
  it("returns null for an empty map", () => {
    const result = findWatchedFolderByPath("/home/user/ProtonDrive/Work", new Map());
    expect(result).toBeNull();
  });

  it("returns null when path is not under any watched folder", () => {
    const map = makeMap([["uid1", makeEntry("/home/user/ProtonDrive/Work")]]);
    expect(findWatchedFolderByPath("/home/user/Other/file.txt", map)).toBeNull();
  });

  it("matches when path equals the watched directory exactly", () => {
    const entry = makeEntry("/home/user/ProtonDrive/Work");
    const map = makeMap([["uid1", entry]]);
    const result = findWatchedFolderByPath("/home/user/ProtonDrive/Work", map);
    expect(result).not.toBeNull();
    expect(result!.uid).toBe("uid1");
    expect(result!.entry).toBe(entry);
  });

  it("matches a file inside a watched directory", () => {
    const entry = makeEntry("/home/user/ProtonDrive/Work");
    const map = makeMap([["uid1", entry]]);
    const result = findWatchedFolderByPath("/home/user/ProtonDrive/Work/report.pdf", map);
    expect(result).not.toBeNull();
    expect(result!.uid).toBe("uid1");
  });

  it("does not match a path that is a prefix but not a parent directory", () => {
    // "/home/user/ProtonDriveBackup" should NOT match "/home/user/ProtonDrive"
    const map = makeMap([["uid1", makeEntry("/home/user/ProtonDrive")]]);
    expect(findWatchedFolderByPath("/home/user/ProtonDriveBackup/file.txt", map)).toBeNull();
  });

  it("picks the deepest match when multiple entries overlap", () => {
    const parentEntry = makeEntry("/home/user/ProtonDrive", "parent");
    const childEntry = makeEntry("/home/user/ProtonDrive/Work", "child");
    const map = makeMap([
      ["parent", parentEntry],
      ["child", childEntry],
    ]);
    const result = findWatchedFolderByPath("/home/user/ProtonDrive/Work/notes.md", map);
    expect(result!.uid).toBe("child");
  });

  it("returns the shallow match when only it matches", () => {
    const parentEntry = makeEntry("/home/user/ProtonDrive", "parent");
    const childEntry = makeEntry("/home/user/ProtonDrive/Work", "child");
    const map = makeMap([
      ["parent", parentEntry],
      ["child", childEntry],
    ]);
    const result = findWatchedFolderByPath("/home/user/ProtonDrive/Photos/image.png", map);
    expect(result!.uid).toBe("parent");
  });

  it("picks the deepest match regardless of map iteration order", () => {
    // Insert deeper entry first to ensure order doesn't affect the result
    const deepEntry = makeEntry("/home/user/ProtonDrive/Work/Projects", "deep");
    const shallowEntry = makeEntry("/home/user/ProtonDrive/Work", "shallow");
    const map = makeMap([
      ["deep", deepEntry],
      ["shallow", shallowEntry],
    ]);
    const result = findWatchedFolderByPath(
      "/home/user/ProtonDrive/Work/Projects/app/src/main.ts",
      map,
    );
    expect(result!.uid).toBe("deep");
  });
});
