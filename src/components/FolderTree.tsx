/**
 * Drive folder tree with lazy-loaded children and 4-state selection.
 *
 * Selection states per node:
 *   "none"      — not selected
 *   "partial"   — a descendant is selected but not this folder directly
 *   "files"     — sync direct files in this folder only
 *   "recursive" — sync this folder and all subfolders
 *
 * Click cycle on the selection indicator: none → files → recursive → none
 * Clicking a "partial" node cycles: partial → files
 */
import { useEffect, useState } from "react";
import { NodeType } from "@protontech/drive-sdk";
import { listFolderChildren } from "../lib/drive";
import type { SelectedFolderRecord } from "../lib/sync";
import { useLang } from "../lib/i18n";
import {
  cycleSelection,
  recomputePartial,
  collectSelected,
  applyInitialSelection,
  updateNodeInTree,
} from "../lib/folderTreeHelpers";
import type { FolderNode, SelectionState } from "../lib/folderTreeHelpers";

export interface FolderTreeProps {
  driveRootUid: string;
  value: SelectedFolderRecord[];
  onChange: (selected: SelectedFolderRecord[]) => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function FolderTree({ driveRootUid, value, onChange }: FolderTreeProps) {
  const [roots, setRoots] = useState<FolderNode[] | null>(null);
  const [loadingUids, setLoadingUids] = useState<Set<string>>(new Set());
  const { t } = useLang();

  // Load root-level folders on mount.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const children = await fetchChildren(driveRootUid, "");
      if (!cancelled) {
        const withSelection = applyInitialSelection(children, value);
        setRoots(withSelection);
      }
    }
    load().catch(console.error);
    return () => { cancelled = true; };
  }, [driveRootUid]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchChildren(parentUid: string, parentPath: string): Promise<FolderNode[]> {
    const nodes: FolderNode[] = [];
    for await (const result of listFolderChildren(parentUid, { type: NodeType.Folder })) {
      if (!result.ok) continue;
      const child = result.value;
      nodes.push({
        uid: child.uid,
        name: child.name,
        parentUid,
        drivePath: parentPath ? `${parentPath}/${child.name}` : child.name,
        children: null,
        expanded: false,
        selection: "none",
      });
    }
    return nodes;
  }

  async function handleExpand(node: FolderNode) {
    if (node.children !== null) {
      setRoots((prev) =>
        prev
          ? recomputePartial(
              updateNodeInTree(prev, node.uid, (n) => ({ ...n, expanded: !n.expanded })),
            )
          : prev,
      );
      return;
    }

    setLoadingUids((s) => new Set(s).add(node.uid));
    try {
      const children = await fetchChildren(node.uid, node.drivePath);
      setRoots((prev) =>
        prev
          ? recomputePartial(
              updateNodeInTree(prev, node.uid, (n) => ({ ...n, children, expanded: true })),
            )
          : prev,
      );
    } finally {
      setLoadingUids((s) => {
        const next = new Set(s);
        next.delete(node.uid);
        return next;
      });
    }
  }

  function handleSelect(node: FolderNode) {
    setRoots((prev) => {
      if (!prev) return prev;
      const next = recomputePartial(
        updateNodeInTree(prev, node.uid, (n) => ({
          ...n,
          selection: cycleSelection(n.selection),
        })),
      );
      onChange(collectSelected(next));
      return next;
    });
  }

  if (roots === null) {
    return <p className="no-events">{t.folderTreeLoading}</p>;
  }

  if (roots.length === 0) {
    return <p className="no-events">{t.folderTreeEmpty}</p>;
  }

  return (
    <ul className="folder-tree">
      {roots.map((node) => (
        <FolderTreeNode
          key={node.uid}
          node={node}
          loadingUids={loadingUids}
          onExpand={handleExpand}
          onSelect={handleSelect}
        />
      ))}
    </ul>
  );
}

// ── Node renderer ─────────────────────────────────────────────────────────────

interface NodeProps {
  node: FolderNode;
  loadingUids: Set<string>;
  onExpand: (node: FolderNode) => void;
  onSelect: (node: FolderNode) => void;
}

const SELECTION_ICON: Record<SelectionState, string> = {
  none: "○",
  partial: "◔",
  files: "●",
  recursive: "⬤",
};

const SELECTION_COLOR: Record<SelectionState, string> = {
  none: "var(--text-muted)",
  partial: "var(--accent)",
  files: "var(--accent)",
  recursive: "var(--accent)",
};

function FolderTreeNode({ node, loadingUids, onExpand, onSelect }: NodeProps) {
  const isLoading = loadingUids.has(node.uid);
  const hasChildren = node.children === null || node.children.length > 0;

  return (
    <li className="folder-tree-item">
      <div className="folder-tree-row">
        <button
          className="folder-tree-expand"
          onClick={() => onExpand(node)}
          disabled={isLoading}
          aria-label={node.expanded ? "Collapse" : "Expand"}
        >
          {isLoading ? "⟳" : hasChildren ? (node.expanded ? "▾" : "▸") : " "}
        </button>

        <button
          className="folder-tree-select"
          onClick={() => onSelect(node)}
          style={{ color: SELECTION_COLOR[node.selection] }}
          aria-label={`Selection: ${node.selection}`}
          title={node.selection}
        >
          {SELECTION_ICON[node.selection]}
        </button>

        <span className="folder-tree-name" onClick={() => onExpand(node)}>
          📁 {node.name}
        </span>
      </div>

      {node.expanded && node.children && node.children.length > 0 && (
        <ul className="folder-tree folder-tree--nested">
          {node.children.map((child) => (
            <FolderTreeNode
              key={child.uid}
              node={child}
              loadingUids={loadingUids}
              onExpand={onExpand}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
