/**
 * Pure helpers for the ConflictWizard.
 * No Drive SDK or Tauri imports — fully unit-testable.
 */

export type Resolution = "keepLocal" | "keepRemote";

export interface ConflictEntry {
  relPath: string;
  local: { sizeBytes: number; mtimeMs: number };
  remote: { sizeBytes: number | null; mtimeMs: number | null };
  resolution: Resolution;
}

export function fmtSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type BulkStrategy = "allLocal" | "newest" | "largest";

export function applyBulkResolution(
  conflicts: ConflictEntry[],
  strategy: BulkStrategy,
): ConflictEntry[] {
  return conflicts.map((c) => {
    let resolution: Resolution = "keepLocal";
    if (strategy === "newest") {
      resolution = (c.remote.mtimeMs ?? 0) > c.local.mtimeMs ? "keepRemote" : "keepLocal";
    } else if (strategy === "largest") {
      resolution = (c.remote.sizeBytes ?? 0) > c.local.sizeBytes ? "keepRemote" : "keepLocal";
    }
    return { ...c, resolution };
  });
}
