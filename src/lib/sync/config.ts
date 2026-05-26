import { getLocalRoot, getDbSyncConfig, setDbSyncConfig } from "../ipcApi";
import { getSyncRoot, listFolderChildren } from "../drive";
import { NodeType } from "@protontech/drive-sdk";
import type { SelectedFolderRecord } from "../syncHelpers";
import { watchedFolderUids, statFile } from "./state";
import type { FileStat } from "../../types/sync";

// ── Config loading ───────────────────────────────────────────────────────────

export async function loadSyncConfig(): Promise<{
  localRoot: string;
  selectedFolders: SelectedFolderRecord[];
  treeEventScopeId: string;
}> {
  const [localRoot, selectedFoldersJson] = await Promise.all([
    getLocalRoot(),
    getDbSyncConfig("selected_folders"),
  ]);

  if (!localRoot) throw new Error("No local root configured — run onboarding first");

  const selectedFolders: SelectedFolderRecord[] = selectedFoldersJson
    ? (JSON.parse(selectedFoldersJson) as SelectedFolderRecord[])
    : [];

  const rootResult = await getSyncRoot();
  if (!rootResult.ok) throw new Error("Could not get Drive root: " + String(rootResult.error));

  const treeEventScopeId = rootResult.value.treeEventScopeId;
  setDbSyncConfig("tree_event_scope_id", treeEventScopeId)
    .catch((e: unknown) => console.warn("[sync] Failed to persist tree event scope ID:", e));

  return { localRoot, selectedFolders, treeEventScopeId };
}

// ── Watched folder map ───────────────────────────────────────────────────────

/** @internal */
export async function expandFolderUids(
  folderUid: string,
  localDir: string,
  selectedRoot: SelectedFolderRecord,
  mode: "files" | "recursive",
): Promise<void> {
  watchedFolderUids.set(folderUid, { localDir, selectedRoot });
  if (mode !== "recursive") return;
  for await (const child of listFolderChildren(folderUid, { type: NodeType.Folder })) {
    if (!child.ok) continue;
    const childLocalDir = `${localDir}/${child.value.name}`;
    await expandFolderUids(child.value.uid, childLocalDir, selectedRoot, "recursive");
  }
}

export async function buildWatchedFolderMap(
  selectedFolders: SelectedFolderRecord[],
  localRoot: string,
): Promise<void> {
  watchedFolderUids.clear();
  for (const folder of selectedFolders) {
    const localDir = folder.drivePath ? `${localRoot}/${folder.drivePath}` : localRoot;
    await expandFolderUids(folder.uid, localDir, folder, folder.mode);
  }
}

// ── File stability helpers ───────────────────────────────────────────────────

/** @internal */
export async function waitForFileStable(absPath: string): Promise<FileStat | null> {
  const first = await statFile(absPath);
  if (!first) return null;
  await new Promise<void>((r) => setTimeout(r, 1_000));
  const second = await statFile(absPath);
  if (!second) return null;
  if (second.mtimeMs === first.mtimeMs && second.sizeBytes === first.sizeBytes) return second;
  await new Promise<void>((r) => setTimeout(r, 1_000));
  const third = await statFile(absPath);
  if (!third || third.mtimeMs !== second.mtimeMs || third.sizeBytes !== second.sizeBytes) return null;
  return third;
}
