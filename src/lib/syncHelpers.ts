/**
 * Pure helpers shared between sync.ts and unit tests.
 * No Tauri, Drive SDK, or browser imports — fully testable in node.
 */

export interface SelectedFolderRecord {
  uid: string;
  name: string;
  drivePath: string; // relative to My Files root, e.g. "Work/Projects"
  mode: "files" | "recursive";
}

export interface WatchedFolderEntry {
  localDir: string; // absolute local path for this Drive folder
  selectedRoot: SelectedFolderRecord;
}

/**
 * Find the deepest-matching watched folder entry for a local absolute path.
 * The `map` parameter is injected so this is unit-testable without module state.
 */
export function findWatchedFolderByPath(
  absPath: string,
  map: Map<string, WatchedFolderEntry>,
): { uid: string; entry: WatchedFolderEntry } | null {
  let best: { uid: string; entry: WatchedFolderEntry; len: number } | null = null;
  for (const [uid, entry] of map) {
    if (absPath === entry.localDir || absPath.startsWith(entry.localDir + "/")) {
      if (!best || entry.localDir.length > best.len) {
        best = { uid, entry, len: entry.localDir.length };
      }
    }
  }
  return best ? { uid: best.uid, entry: best.entry } : null;
}
