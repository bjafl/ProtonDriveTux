import { describe, it, expect } from "vitest";
import { fmtSize, applyBulkResolution } from "../lib/conflictHelpers";
import type { ConflictEntry } from "../lib/conflictHelpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConflict(
  relPath: string,
  local: { sizeBytes: number; mtimeMs: number },
  remote: { sizeBytes: number | null; mtimeMs: number | null },
): ConflictEntry {
  return { relPath, local, remote, resolution: "keepLocal" };
}

// ── fmtSize ───────────────────────────────────────────────────────────────────

describe("fmtSize", () => {
  it("returns em dash for null", () => {
    expect(fmtSize(null)).toBe("—");
  });

  it("formats bytes under 1 KB", () => {
    expect(fmtSize(0)).toBe("0 B");
    expect(fmtSize(512)).toBe("512 B");
    expect(fmtSize(1023)).toBe("1023 B");
  });

  it("formats KB values", () => {
    expect(fmtSize(1024)).toBe("1.0 KB");
    expect(fmtSize(1536)).toBe("1.5 KB");
    expect(fmtSize(1024 * 1024 - 1)).toMatch(/KB$/);
  });

  it("formats MB values", () => {
    expect(fmtSize(1024 * 1024)).toBe("1.0 MB");
    expect(fmtSize(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});

// ── applyBulkResolution ───────────────────────────────────────────────────────

describe("applyBulkResolution", () => {
  it("allLocal always sets keepLocal", () => {
    const conflicts = [
      makeConflict("a.txt", { sizeBytes: 100, mtimeMs: 1000 }, { sizeBytes: 200, mtimeMs: 2000 }),
      makeConflict("b.txt", { sizeBytes: 300, mtimeMs: 3000 }, { sizeBytes: 50, mtimeMs: 500 }),
    ];
    const result = applyBulkResolution(conflicts, "allLocal");
    expect(result.every((c) => c.resolution === "keepLocal")).toBe(true);
  });

  it("newest keeps remote when remote is newer", () => {
    const conflict = makeConflict(
      "file.txt",
      { sizeBytes: 100, mtimeMs: 1000 },
      { sizeBytes: 100, mtimeMs: 2000 },
    );
    const [result] = applyBulkResolution([conflict], "newest");
    expect(result.resolution).toBe("keepRemote");
  });

  it("newest keeps local when local is newer", () => {
    const conflict = makeConflict(
      "file.txt",
      { sizeBytes: 100, mtimeMs: 5000 },
      { sizeBytes: 100, mtimeMs: 2000 },
    );
    const [result] = applyBulkResolution([conflict], "newest");
    expect(result.resolution).toBe("keepLocal");
  });

  it("newest keeps local when remote mtimeMs is null", () => {
    const conflict = makeConflict(
      "file.txt",
      { sizeBytes: 100, mtimeMs: 1000 },
      { sizeBytes: null, mtimeMs: null },
    );
    const [result] = applyBulkResolution([conflict], "newest");
    expect(result.resolution).toBe("keepLocal");
  });

  it("largest keeps remote when remote is larger", () => {
    const conflict = makeConflict(
      "file.txt",
      { sizeBytes: 100, mtimeMs: 1000 },
      { sizeBytes: 500, mtimeMs: 1000 },
    );
    const [result] = applyBulkResolution([conflict], "largest");
    expect(result.resolution).toBe("keepRemote");
  });

  it("largest keeps local when local is larger", () => {
    const conflict = makeConflict(
      "file.txt",
      { sizeBytes: 800, mtimeMs: 1000 },
      { sizeBytes: 200, mtimeMs: 1000 },
    );
    const [result] = applyBulkResolution([conflict], "largest");
    expect(result.resolution).toBe("keepLocal");
  });

  it("largest keeps local when remote sizeBytes is null", () => {
    const conflict = makeConflict(
      "file.txt",
      { sizeBytes: 100, mtimeMs: 1000 },
      { sizeBytes: null, mtimeMs: null },
    );
    const [result] = applyBulkResolution([conflict], "largest");
    expect(result.resolution).toBe("keepLocal");
  });

  it("returns empty array unchanged", () => {
    expect(applyBulkResolution([], "newest")).toEqual([]);
  });

  it("does not mutate the original conflicts array", () => {
    const conflicts = [
      makeConflict("a.txt", { sizeBytes: 100, mtimeMs: 1000 }, { sizeBytes: 200, mtimeMs: 2000 }),
    ];
    applyBulkResolution(conflicts, "newest");
    expect(conflicts[0].resolution).toBe("keepLocal");
  });
});
