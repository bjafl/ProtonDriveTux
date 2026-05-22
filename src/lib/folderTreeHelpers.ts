/**
 * Pure functions for the FolderTree selection state machine.
 * No Drive SDK or Tauri imports — fully unit-testable.
 */
import type { SelectedFolderRecord } from "./syncHelpers";

export type SelectionState = "none" | "partial" | "files" | "recursive";

export interface FolderNode {
  uid: string;
  name: string;
  parentUid: string | null;
  drivePath: string;
  children: FolderNode[] | null;
  expanded: boolean;
  selection: SelectionState;
}

/**
 * Click cycle for a folder's selection indicator.
 * "partial" is treated like "none" — clicking it moves to "files".
 */
export function cycleSelection(current: SelectionState): SelectionState {
  if (current === "none" || current === "partial") return "files";
  if (current === "files") return "recursive";
  return "none";
}

function hasSelectedDescendant(node: FolderNode): boolean {
  if (!node.children) return false;
  return node.children.some(
    (c) =>
      c.selection === "files" ||
      c.selection === "recursive" ||
      c.selection === "partial" ||
      hasSelectedDescendant(c),
  );
}

function updatePartial(node: FolderNode): FolderNode {
  const updatedChildren = node.children ? node.children.map(updatePartial) : null;
  const updated = { ...node, children: updatedChildren };
  if (updated.selection === "none" || updated.selection === "partial") {
    updated.selection = hasSelectedDescendant(updated) ? "partial" : "none";
  }
  return updated;
}

/**
 * After any selection change, recompute "partial" state for all ancestors.
 * A node becomes "partial" when it is "none" but has a selected descendant.
 */
export function recomputePartial(nodes: FolderNode[]): FolderNode[] {
  return nodes.map(updatePartial);
}

/** Collect all nodes where selection is "files" or "recursive". */
export function collectSelected(nodes: FolderNode[]): SelectedFolderRecord[] {
  const result: SelectedFolderRecord[] = [];
  function walk(node: FolderNode) {
    if (node.selection === "files" || node.selection === "recursive") {
      result.push({
        uid: node.uid,
        name: node.name,
        drivePath: node.drivePath,
        mode: node.selection,
      });
    }
    node.children?.forEach(walk);
  }
  nodes.forEach(walk);
  return result;
}

/** Apply a saved selection (from DB) onto a freshly-loaded tree. */
export function applyInitialSelection(
  nodes: FolderNode[],
  value: SelectedFolderRecord[],
): FolderNode[] {
  const byUid = new Map(value.map((r) => [r.uid, r]));
  function apply(node: FolderNode): FolderNode {
    const record = byUid.get(node.uid);
    return {
      ...node,
      selection: record ? record.mode : node.selection,
      children: node.children ? node.children.map(apply) : null,
    };
  }
  const applied = nodes.map(apply);
  return recomputePartial(applied);
}

/** Generic tree node updater used by the component. */
export function updateNodeInTree(
  nodes: FolderNode[],
  uid: string,
  updater: (n: FolderNode) => FolderNode,
): FolderNode[] {
  return nodes.map((node) => {
    if (node.uid === uid) return updater(node);
    if (node.children) {
      return { ...node, children: updateNodeInTree(node.children, uid, updater) };
    }
    return node;
  });
}
