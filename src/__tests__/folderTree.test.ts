import { describe, it, expect } from "vitest";
import {
  cycleSelection,
  recomputePartial,
  collectSelected,
  applyInitialSelection,
  updateNodeInTree,
  type FolderNode,
  type SelectionState,
} from "../lib/folderTreeHelpers";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNode(
  uid: string,
  selection: SelectionState = "none",
  children: FolderNode[] | null = null,
): FolderNode {
  return {
    uid,
    name: uid,
    parentUid: null,
    drivePath: uid,
    children,
    expanded: false,
    selection,
  };
}

// ── cycleSelection ────────────────────────────────────────────────────────────

describe("cycleSelection", () => {
  it("advances none → files", () => {
    expect(cycleSelection("none")).toBe("files");
  });

  it("advances files → recursive", () => {
    expect(cycleSelection("files")).toBe("recursive");
  });

  it("wraps recursive → none", () => {
    expect(cycleSelection("recursive")).toBe("none");
  });

  it("treats partial like none (partial → files)", () => {
    expect(cycleSelection("partial")).toBe("files");
  });
});

// ── recomputePartial ──────────────────────────────────────────────────────────

describe("recomputePartial", () => {
  it("marks a parent as partial when a child is selected", () => {
    const tree = [makeNode("parent", "none", [makeNode("child", "files")])];
    const result = recomputePartial(tree);
    expect(result[0].selection).toBe("partial");
  });

  it("keeps parent as none when all children are none", () => {
    const tree = [makeNode("parent", "none", [makeNode("child", "none")])];
    const result = recomputePartial(tree);
    expect(result[0].selection).toBe("none");
  });

  it("does not downgrade an explicitly selected parent", () => {
    const tree = [makeNode("parent", "recursive", [makeNode("child", "none")])];
    const result = recomputePartial(tree);
    expect(result[0].selection).toBe("recursive");
  });

  it("propagates partial through multiple ancestor levels", () => {
    const leaf = makeNode("leaf", "files");
    const mid = makeNode("mid", "none", [leaf]);
    const root = makeNode("root", "none", [mid]);
    const [result] = recomputePartial([root]);
    expect(result.selection).toBe("partial");
    expect(result.children![0].selection).toBe("partial");
  });

  it("clears partial when child selection is removed", () => {
    const tree = [makeNode("parent", "partial", [makeNode("child", "none")])];
    const result = recomputePartial(tree);
    expect(result[0].selection).toBe("none");
  });
});

// ── collectSelected ───────────────────────────────────────────────────────────

describe("collectSelected", () => {
  it("collects nodes with selection files", () => {
    const tree = [makeNode("a", "files"), makeNode("b", "none")];
    const selected = collectSelected(tree);
    expect(selected).toHaveLength(1);
    expect(selected[0].uid).toBe("a");
    expect(selected[0].mode).toBe("files");
  });

  it("collects nodes with selection recursive", () => {
    const tree = [makeNode("a", "recursive")];
    const selected = collectSelected(tree);
    expect(selected[0].mode).toBe("recursive");
  });

  it("skips none and partial nodes", () => {
    const tree = [makeNode("a", "none"), makeNode("b", "partial")];
    expect(collectSelected(tree)).toHaveLength(0);
  });

  it("collects from nested children", () => {
    const child = makeNode("child", "recursive");
    const parent = makeNode("parent", "none", [child]);
    const selected = collectSelected([parent]);
    expect(selected).toHaveLength(1);
    expect(selected[0].uid).toBe("child");
  });

  it("collects both parent and child when both selected", () => {
    const child = makeNode("child", "files");
    const parent = makeNode("parent", "recursive", [child]);
    const selected = collectSelected([parent]);
    expect(selected).toHaveLength(2);
  });
});

// ── applyInitialSelection ─────────────────────────────────────────────────────

describe("applyInitialSelection", () => {
  it("applies saved selection to matching node", () => {
    const tree = [makeNode("a", "none"), makeNode("b", "none")];
    const value = [{ uid: "a", name: "a", drivePath: "a", mode: "files" as const }];
    const result = applyInitialSelection(tree, value);
    expect(result.find((n) => n.uid === "a")!.selection).toBe("files");
    expect(result.find((n) => n.uid === "b")!.selection).toBe("none");
  });

  it("recomputes partial on ancestors after applying saved selection", () => {
    const child = makeNode("child", "none");
    const parent = makeNode("parent", "none", [child]);
    const value = [{ uid: "child", name: "child", drivePath: "child", mode: "recursive" as const }];
    const [result] = applyInitialSelection([parent], value);
    expect(result.selection).toBe("partial");
    expect(result.children![0].selection).toBe("recursive");
  });

  it("leaves nodes unchanged if not in value", () => {
    const tree = [makeNode("x", "none")];
    const result = applyInitialSelection(tree, []);
    expect(result[0].selection).toBe("none");
  });
});

// ── updateNodeInTree ──────────────────────────────────────────────────────────

describe("updateNodeInTree", () => {
  it("updates only the matching node", () => {
    const tree = [makeNode("a"), makeNode("b")];
    const result = updateNodeInTree(tree, "a", (n) => ({ ...n, expanded: true }));
    expect(result[0].expanded).toBe(true);
    expect(result[1].expanded).toBe(false);
  });

  it("updates a deeply nested node", () => {
    const leaf = makeNode("leaf");
    const mid = makeNode("mid", "none", [leaf]);
    const root = makeNode("root", "none", [mid]);
    const result = updateNodeInTree([root], "leaf", (n) => ({ ...n, selection: "files" }));
    expect(result[0].children![0].children![0].selection).toBe("files");
  });

  it("returns unchanged tree when uid not found", () => {
    const tree = [makeNode("a")];
    const result = updateNodeInTree(tree, "z", (n) => ({ ...n, expanded: true }));
    expect(result[0].expanded).toBe(false);
  });
});
