/**
 * Conflict resolution wizard shown when the chosen local root is not empty
 * and Drive has files in the selected folders.
 *
 * Conflict types:
 *   local only             → will be uploaded (auto, not shown)
 *   remote only            → will be downloaded (auto, not shown)
 *   both, same size+mtime  → treated as identical, skipped (not shown)
 *   both, different        → user decides per row
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NodeType } from "@protontech/drive-sdk";
import { listFolderChildren, streamDownloadToPath } from "../lib/drive";
import type { SelectedFolderRecord } from "../lib/sync";
import { useLang } from "../lib/i18n";

// ── Types ─────────────────────────────────────────────────────────────────────

interface LocalFileEntry {
  relPath: string;
  absPath: string;
  mtimeMs: number;
  sizeBytes: number;
}

interface RemoteFile {
  uid: string;
  name: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
  parentLocalDir: string;
}

type Resolution = "keepLocal" | "keepRemote";

interface ConflictFile {
  relPath: string;
  local: { absPath: string; sizeBytes: number; mtimeMs: number };
  remote: RemoteFile;
  resolution: Resolution;
}

export interface ConflictWizardProps {
  localRoot: string;
  selectedFolders: SelectedFolderRecord[];
  onComplete: () => void;
  onBack: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtSize(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString();
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ConflictWizard({ localRoot, selectedFolders, onComplete, onBack }: ConflictWizardProps) {
  const [conflicts, setConflicts] = useState<ConflictFile[] | null>(null);
  const [resolving, setResolving] = useState(false);
  const { t } = useLang();

  useEffect(() => {
    let cancelled = false;
    async function detect() {
      const found = await detectConflicts(localRoot, selectedFolders);
      if (!cancelled) setConflicts(found);
    }
    detect().catch(console.error);
    return () => { cancelled = true; };
  }, [localRoot, selectedFolders]);

  function setResolution(relPath: string, resolution: Resolution) {
    setConflicts((prev) =>
      prev ? prev.map((c) => (c.relPath === relPath ? { ...c, resolution } : c)) : prev,
    );
  }

  function applyBulk(strategy: "allLocal" | "newest" | "largest") {
    setConflicts((prev) =>
      prev
        ? prev.map((c) => {
            let resolution: Resolution = "keepLocal";
            if (strategy === "newest") {
              resolution =
                (c.remote.mtimeMs ?? 0) > c.local.mtimeMs ? "keepRemote" : "keepLocal";
            } else if (strategy === "largest") {
              resolution =
                (c.remote.sizeBytes ?? 0) > c.local.sizeBytes ? "keepRemote" : "keepLocal";
            }
            return { ...c, resolution };
          })
        : prev,
    );
  }

  async function handleConfirm() {
    if (!conflicts) return;
    setResolving(true);
    try {
      for (const conflict of conflicts) {
        if (conflict.resolution === "keepRemote") {
          await streamDownloadToPath(conflict.remote.uid, conflict.local.absPath);
        }
        // keepLocal: do nothing — local file will be uploaded in initial sync
      }
      onComplete();
    } catch (err) {
      console.error("[conflict] resolution failed:", err);
    } finally {
      setResolving(false);
    }
  }

  // Auto-proceed when detection finishes with zero conflicts.
  // Must be in useEffect — calling onComplete() during render is a React violation.
  useEffect(() => {
    if (conflicts !== null && conflicts.length === 0) onComplete();
  }, [conflicts, onComplete]);

  if (conflicts === null || conflicts.length === 0) {
    return <p className="no-events">{t.loading}</p>;
  }

  return (
    <div className="conflict-wizard">
      <h2>{t.conflictTitle}</h2>
      <p className="hint">{t.conflictSubtitle(conflicts.length)}</p>

      <div className="conflict-bulk">
        <button className="back-btn" onClick={() => applyBulk("allLocal")}>
          {t.conflictBulkAllLocal}
        </button>
        <button className="back-btn" onClick={() => applyBulk("newest")}>
          {t.conflictBulkNewest}
        </button>
        <button className="back-btn" onClick={() => applyBulk("largest")}>
          {t.conflictBulkLargest}
        </button>
      </div>

      <div className="conflict-table-wrap">
        <table className="conflict-table">
          <thead>
            <tr>
              <th>{t.conflictColName}</th>
              <th>{t.conflictColLocalSize}</th>
              <th>{t.conflictColLocalDate}</th>
              <th>{t.conflictColRemoteSize}</th>
              <th>{t.conflictColRemoteDate}</th>
              <th>{t.conflictColKeep}</th>
            </tr>
          </thead>
          <tbody>
            {conflicts.map((c) => {
              const localBigger = c.local.sizeBytes >= (c.remote.sizeBytes ?? 0);
              const localNewer = c.local.mtimeMs >= (c.remote.mtimeMs ?? 0);
              return (
                <tr key={c.relPath}>
                  <td className="conflict-name" title={c.relPath}>
                    {c.relPath.split("/").pop()}
                  </td>
                  <td style={{ fontWeight: localBigger ? 700 : 400 }}>
                    {fmtSize(c.local.sizeBytes)}
                  </td>
                  <td style={{ fontWeight: localNewer ? 700 : 400 }}>
                    {fmtDate(c.local.mtimeMs)}
                  </td>
                  <td style={{ fontWeight: !localBigger ? 700 : 400 }}>
                    {fmtSize(c.remote.sizeBytes)}
                  </td>
                  <td style={{ fontWeight: !localNewer ? 700 : 400 }}>
                    {fmtDate(c.remote.mtimeMs)}
                  </td>
                  <td>
                    <label>
                      <input
                        type="radio"
                        name={c.relPath}
                        checked={c.resolution === "keepLocal"}
                        onChange={() => setResolution(c.relPath, "keepLocal")}
                      />{" "}
                      {t.conflictKeepLocal}
                    </label>{" "}
                    <label>
                      <input
                        type="radio"
                        name={c.relPath}
                        checked={c.resolution === "keepRemote"}
                        onChange={() => setResolution(c.relPath, "keepRemote")}
                      />{" "}
                      {t.conflictKeepRemote}
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="onboarding-nav">
        <button className="back-btn" onClick={onBack} disabled={resolving}>
          {t.onboardingBack}
        </button>
        <button className="login-btn" onClick={handleConfirm} disabled={resolving}>
          {resolving ? t.loading : t.conflictConfirm}
        </button>
      </div>
    </div>
  );
}

// ── Conflict detection ────────────────────────────────────────────────────────

async function detectConflicts(
  localRoot: string,
  selectedFolders: SelectedFolderRecord[],
): Promise<ConflictFile[]> {
  // Build map of rel path → local file entry
  const localFiles = await invoke<LocalFileEntry[]>("list_dir_recursive", { absPath: localRoot });
  const localByRel = new Map(localFiles.map((f) => [f.relPath, f]));

  const conflicts: ConflictFile[] = [];

  for (const folder of selectedFolders) {
    await collectRemoteFiles(folder.uid, folder.drivePath || "", localByRel, conflicts, localRoot);
    if (folder.mode === "recursive") {
      // Subfolders are already found via listFolderChildren recursion below
    }
  }

  return conflicts;
}

async function collectRemoteFiles(
  folderUid: string,
  drivePath: string,
  localByRel: Map<string, LocalFileEntry>,
  conflicts: ConflictFile[],
  localRoot: string,
): Promise<void> {
  for await (const result of listFolderChildren(folderUid)) {
    if (!result.ok) continue;
    const node = result.value;

    if (node.type === NodeType.Folder) {
      const childPath = drivePath ? `${drivePath}/${node.name}` : node.name;
      await collectRemoteFiles(node.uid, childPath, localByRel, conflicts, localRoot);
      continue;
    }

    if (node.type !== NodeType.File) continue;

    const relPath = drivePath ? `${drivePath}/${node.name}` : node.name;
    const local = localByRel.get(relPath);
    if (!local) continue; // remote only — no conflict

    const remoteSizeBytes = node.activeRevision?.claimedSize ?? null;
    const remoteMtimeMs = node.modificationTime?.getTime() ?? null;

    // Same size AND same mtime (±2 s) → treat as identical, skip.
    // Size alone is insufficient: same-length edits would be silently missed.
    const sameSize = remoteSizeBytes !== null && remoteSizeBytes === local.sizeBytes;
    const sameMtime = remoteMtimeMs !== null && Math.abs(remoteMtimeMs - local.mtimeMs) < 2_000;
    if (sameSize && sameMtime) continue;

    conflicts.push({
      relPath,
      local: { absPath: local.absPath, sizeBytes: local.sizeBytes, mtimeMs: local.mtimeMs },
      remote: {
        uid: node.uid,
        name: node.name,
        sizeBytes: remoteSizeBytes,
        mtimeMs: remoteMtimeMs,
        parentLocalDir: `${localRoot}/${drivePath}`,
      },
      resolution: "keepLocal",
    });
  }
}

