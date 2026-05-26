import type { FileStat } from "../types/sync";

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
