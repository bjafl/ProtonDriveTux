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
