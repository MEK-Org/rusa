import type { Goal, SyncClient } from "@thkp-eng/goals-core";
import type { GoalLogEntry } from "@thkp-eng/goals-types";
import { describe, expect, it } from "vitest";
import {
  addRelationship,
  applyNodeSplice,
  archiveNode,
  createNode,
  getNodeContents,
  listChildren,
  NODE_LENGTH_TRIGGER,
  NODE_SECTION_TRIGGER,
  nodeShapeWarnings,
  removeRelationship,
  spliceNodeContents,
  updateNodeContents,
  updateNodeTitle,
  viewNode,
} from "./graph-store.js";

interface GoalDeltaLike {
  id: string;
  text?: string;
  logEntry?: GoalLogEntry;
}

function makeGoal(
  id: string,
  text: string,
  opts: { parents?: string[]; children?: string[]; contents?: string } = {}
): Goal {
  const log: GoalLogEntry[] = [];
  if (opts.contents !== undefined) {
    log.push({
      id: `e-${id}`,
      creationTime: 1,
      type: "documentContents",
      text: opts.contents,
    } as GoalLogEntry);
  }
  return {
    id,
    text,
    superGoalIds: new Set(opts.parents ?? []),
    subGoalIds: new Set(opts.children ?? []),
    log,
  } as unknown as Goal;
}

/** Minimal in-memory SyncClient: serves a goals map + records modifyGoal calls. */
class FakeSync {
  goals = new Map<string, Goal>();
  calls: GoalDeltaLike[] = [];
  getGoals(): Map<string, Goal> {
    return this.goals;
  }
  async modifyGoal(delta: GoalDeltaLike): Promise<void> {
    this.calls.push(delta);
  }
}

function fake(goals: Goal[] = []): { sync: SyncClient; rec: FakeSync } {
  const rec = new FakeSync();
  for (const g of goals) rec.goals.set(g.id, g);
  return { sync: rec as unknown as SyncClient, rec };
}

describe("graph-store read helpers", () => {
  it("getNodeContents returns the latest documentContents text (or empty)", () => {
    expect(getNodeContents(makeGoal("a", "A", { contents: "# body" }))).toBe("# body");
    expect(getNodeContents(makeGoal("a", "A"))).toBe("");
  });

  it("viewNode resolves title, contents, parents, and children", () => {
    const { sync } = fake([
      makeGoal("root", "Root", { children: ["a"] }),
      makeGoal("a", "A", { parents: ["root"], children: ["b"], contents: "body-a" }),
      makeGoal("b", "B", { parents: ["a"] }),
    ]);
    expect(viewNode(sync, "a")).toEqual({
      id: "a",
      title: "A",
      contents: "body-a",
      parents: [{ id: "root", title: "Root" }],
      children: [{ id: "b", title: "B" }],
    });
    expect(viewNode(sync, "missing")).toBeNull();
  });

  it("listChildren lists a node's children, or top-level roots when omitted", () => {
    const { sync } = fake([
      makeGoal("root", "Root", { children: ["a"] }),
      makeGoal("a", "A", { parents: ["root"], children: ["b"] }),
      makeGoal("b", "B", { parents: ["a"] }),
    ]);
    expect(listChildren(sync)?.map((n) => n.id)).toEqual(["root"]);
    expect(listChildren(sync, "root")).toEqual([{ id: "a", title: "A", childCount: 1 }]);
  });

  it("listChildren separates a childless node from a nonexistent one ", () => {
    const { sync } = fake([
      makeGoal("root", "Root", { children: ["a"] }),
      makeGoal("a", "A", { parents: ["root"] }),
    ]);
    // The pair the issue measured: two ids differing by their last character, one
    // real and childless, one naming nothing. Asserting only the empty case would
    // pin nothing — both answers were `[]` before this fix.
    expect(listChildren(sync, "a")).toEqual([]);
    expect(listChildren(sync, "b")).toBeNull();
    expect(viewNode(sync, "b")).toBeNull(); // the rail it now agrees with
  });
});

describe("graph-store write ops", () => {
  it("createNode writes title + body and returns a new id", async () => {
    const { sync, rec } = fake();
    const id = await createNode(sync, { title: "New", contents: "# md" });
    expect(id).toBeTruthy();
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({ id, text: "New" });
    expect(rec.calls[0]?.logEntry).toMatchObject({ type: "documentContents", text: "# md" });
  });

  it("createNode links under an existing parent", async () => {
    const { sync, rec } = fake([makeGoal("root", "Root")]);
    const id = await createNode(sync, { title: "Child", contents: "x", parentId: "root" });
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]).toMatchObject({ id });
    expect(rec.calls[1]?.logEntry).toMatchObject({ type: "addParent", parentId: "root" });
  });

  it("createNode rejects an unknown parent and a blank title", async () => {
    const { sync } = fake();
    await expect(createNode(sync, { title: "x", contents: "", parentId: "nope" })).rejects.toThrow(
      /parent node not found/
    );
    await expect(createNode(sync, { title: "  ", contents: "" })).rejects.toThrow(
      /title is required/
    );
  });

  it("updateNodeContents replaces or appends the markdown body", async () => {
    const { sync, rec } = fake([makeGoal("a", "A", { contents: "old" })]);
    await updateNodeContents(sync, { nodeId: "a", action: "replace", text: "new" });
    expect(rec.calls[0]?.logEntry).toMatchObject({ type: "documentContents", text: "new" });

    await updateNodeContents(sync, { nodeId: "a", action: "append", text: "more" });
    expect(rec.calls[1]?.logEntry).toMatchObject({ type: "documentContents", text: "old\n\nmore" });
  });

  describe("targeted in-place splice ", () => {
    it("replaces the anchor and leaves everything around it byte-identical", () => {
      const body = "# Title\n\nBefore. ISSUE_NUM is still open. After.\n\n## Next\ntail";
      expect(
        applyNodeSplice(body, {
          oldText: "ISSUE_NUM is still open",
          newText: "ISSUE_NUM was closed",
        })
      ).toBe("# Title\n\nBefore. ISSUE_NUM was closed. After.\n\n## Next\ntail");
    });

    it("treats the anchor as literal text, not a pattern", () => {
      // Every one of these means itself; a regex-backed implementation would either
      // throw on the unbalanced bracket or match the wrong span.
      const body = "see (a.b) and [x] and a*b and ^start$";
      expect(applyNodeSplice(body, { oldText: "(a.b)", newText: "(c.d)" })).toBe(
        "see (c.d) and [x] and a*b and ^start$"
      );
      expect(applyNodeSplice(body, { oldText: "a*b", newText: "a+b" })).toBe(
        "see (a.b) and [x] and a+b and ^start$"
      );
      // `.` must not match the literal `x` that a pattern would find first.
      expect(() => applyNodeSplice(body, { oldText: "[.]", newText: "y" })).toThrow(/not found/);
    });

    it("deletes a passage when new_text is empty", () => {
      expect(
        applyNodeSplice("keep this. drop this. keep that.", { oldText: " drop this.", newText: "" })
      ).toBe("keep this. keep that.");
    });

    it("refuses an anchor that matches nothing rather than silently doing nothing", () => {
      expect(() => applyNodeSplice("the body", { oldText: "absent", newText: "x" })).toThrow(
        /old_text not found/
      );
    });

    it("refuses an ambiguous anchor rather than guessing which occurrence was meant", () => {
      const body = "open. open. open.";
      expect(() => applyNodeSplice(body, { oldText: "open", newText: "closed" })).toThrow(
        /matches 3 times/
      );
      // The count is the actionable part of the message, so it has to be real.
      expect(() => applyNodeSplice("open. open.", { oldText: "open", newText: "closed" })).toThrow(
        /matches 2 times/
      );
      // …and an explicit replace_all is how you say you meant all of them.
      expect(applyNodeSplice(body, { oldText: "open", newText: "closed", replaceAll: true })).toBe(
        "closed. closed. closed."
      );
    });

    it("refuses the two degenerate anchors", () => {
      expect(() => applyNodeSplice("body", { oldText: "", newText: "x" })).toThrow(/required/);
      expect(() => applyNodeSplice("body", { oldText: "same", newText: "same" })).toThrow(
        /change nothing/
      );
    });

    it("bounds the anchor echoed back in an error", () => {
      const long = "q".repeat(500);
      let message = "";
      try {
        applyNodeSplice("body", { oldText: long, newText: "x" });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("500 characters");
      expect(message).not.toContain(long);
      // Newlines in an anchor must not break the error across lines.
      expect(() => applyNodeSplice("body", { oldText: "a\nb", newText: "x" })).toThrow(/a\\nb/);
    });

    it("spliceNodeContents writes the corrected body through to the store", async () => {
      const { sync, rec } = fake([makeGoal("a", "A", { contents: "before. stale. after." })]);
      const warnings = await spliceNodeContents(sync, {
        nodeId: "a",
        oldText: "stale",
        newText: "fresh",
      });
      expect(rec.calls[0]?.logEntry).toMatchObject({
        type: "documentContents",
        text: "before. fresh. after.",
      });
      expect(warnings).toEqual([]);
    });

    it("spliceNodeContents writes NOTHING when the anchor doesn't resolve", async () => {
      const { sync, rec } = fake([makeGoal("a", "A", { contents: "before. stale. after." })]);
      await expect(
        spliceNodeContents(sync, { nodeId: "a", oldText: "absent", newText: "x" })
      ).rejects.toThrow(/old_text not found/);
      expect(rec.calls).toHaveLength(0);
    });

    it("spliceNodeContents enforces the root-scoped reachability guard", async () => {
      const { sync, rec } = fake([
        makeGoal("root", "Root", { children: ["child"] }),
        makeGoal("child", "Child", { parents: ["root"], contents: "stale" }),
        makeGoal("orphan", "Orphan", { contents: "stale" }),
      ]);
      await expect(
        spliceNodeContents(sync, { nodeId: "orphan", oldText: "stale", newText: "fresh" }, "root")
      ).rejects.toThrow(/node not found/);
      expect(rec.calls).toHaveLength(0);
      await spliceNodeContents(
        sync,
        { nodeId: "child", oldText: "stale", newText: "fresh" },
        "root"
      );
      expect(rec.calls).toHaveLength(1);
    });

    it("stays silent on a correction to an over-trigger node, but still warns on growth", async () => {
      // The whole point of the primitive is correcting a node too large to re-emit, so
      // the body here is deliberately PAST the length trigger: a naive
      // `nodeShapeWarnings(next)` would fire on every such correction.
      const oversized = `stale ${"x".repeat(NODE_LENGTH_TRIGGER)}`;
      const { sync } = fake([makeGoal("a", "A", { contents: oversized })]);
      expect(
        await spliceNodeContents(sync, { nodeId: "a", oldText: "stale", newText: "fresh" })
      ).toEqual([]);
      // Same node, same trigger breach — a splice that GROWS the body is the force
      // ISSUE_NUM measures, and does warn.
      const grow = await spliceNodeContents(sync, {
        nodeId: "a",
        oldText: "stale",
        newText: "fresh and then some",
      });
      expect(grow.some((w) => w.includes("split trigger"))).toBe(true);
    });
  });

  describe("node shape warnings ", () => {
    const sections = (n: number) =>
      Array.from({ length: n }, (_, i) => `## Section ${i + 1}\nbody`).join("\n\n");

    it("stays silent on a body inside both triggers", () => {
      expect(nodeShapeWarnings({ next: sections(NODE_SECTION_TRIGGER) })).toEqual([]);
    });

    it("reports the actual size past the length trigger", () => {
      const warnings = nodeShapeWarnings({ next: "x".repeat(NODE_LENGTH_TRIGGER + 1) });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(String(NODE_LENGTH_TRIGGER + 1));
    });

    it("reports the actual count past the section trigger", () => {
      const warnings = nodeShapeWarnings({ next: sections(NODE_SECTION_TRIGGER + 1) });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`${NODE_SECTION_TRIGGER + 1} "## " sections`);
    });

    it("counts only lines that OPEN a section, not '## ' mid-line or deeper headings", () => {
      // Eight real sections — exactly at the trigger, so silent — plus eight lines that
      // merely CONTAIN "## ". A substring count would see sixteen and warn.
      const body = [
        sections(NODE_SECTION_TRIGGER),
        ...Array.from({ length: 4 }, (_, i) => `see the ## marker inline ${i}`),
        ...Array.from({ length: 4 }, (_, i) => `### Deeper ${i}`),
      ].join("\n");
      expect(nodeShapeWarnings({ next: body })).toEqual([]);
    });

    it("calls out an append that opens a new section on an already-over node", () => {
      const previous = sections(NODE_SECTION_TRIGGER + 1);
      const appended = "## 2026-08-12 update\nthis window's finding";
      const warnings = nodeShapeWarnings({
        next: `${previous}\n\n${appended}`,
        previous,
        appended,
      });
      expect(warnings.some((w) => w.includes("ALREADY over a split trigger"))).toBe(true);
    });

    it("does not call out an append that folds into an existing section", () => {
      const previous = sections(NODE_SECTION_TRIGGER + 1);
      const appended = "one more sentence, no new heading";
      const warnings = nodeShapeWarnings({
        next: `${previous}\n\n${appended}`,
        previous,
        appended,
      });
      // The node is still over the section trigger, so that warning stands — but the
      // loudest changelog-step warning must not fire for a fold.
      expect(warnings.some((w) => w.includes("ALREADY over a split trigger"))).toBe(false);
      expect(warnings.some((w) => w.includes('"## " sections'))).toBe(true);
    });

    it("updateNodeContents returns the warnings for the body it stored", async () => {
      const previous = sections(NODE_SECTION_TRIGGER + 1);
      const { sync } = fake([makeGoal("a", "A", { contents: previous })]);

      expect(
        await updateNodeContents(sync, { nodeId: "a", action: "replace", text: "short" })
      ).toEqual([]);
      expect(
        await updateNodeContents(sync, {
          nodeId: "a",
          action: "append",
          text: "## New Section\nx",
        })
      ).toHaveLength(2);
    });
  });

  it("updateNodeTitle renames and validates", async () => {
    // 'a' is a child of 'root' (a non-root node), so the root guard allows rename.
    const { sync, rec } = fake([
      makeGoal("root", "Root", { children: ["a"] }),
      makeGoal("a", "A", { parents: ["root"] }),
    ]);
    await updateNodeTitle(sync, { nodeId: "a", newTitle: "Renamed" });
    expect(rec.calls[0]).toMatchObject({ id: "a", text: "Renamed" });
    await expect(updateNodeTitle(sync, { nodeId: "x", newTitle: "y" })).rejects.toThrow(
      /not found/
    );
  });

  it("add/removeRelationship emit addParent/removeParent and validate endpoints", async () => {
    const { sync, rec } = fake([makeGoal("p", "P"), makeGoal("c", "C")]);
    await addRelationship(sync, { parentId: "p", childId: "c" });
    expect(rec.calls[0]).toMatchObject({ id: "c" });
    expect(rec.calls[0]?.logEntry).toMatchObject({ type: "addParent", parentId: "p" });

    await removeRelationship(sync, { parentId: "p", childId: "c" });
    expect(rec.calls[1]?.logEntry).toMatchObject({ type: "removeParent", parentId: "p" });

    await expect(addRelationship(sync, { parentId: "p", childId: "missing" })).rejects.toThrow(
      /child node not found/
    );
  });

  it("addRelationship rejects edges that would introduce a cycle (ISSUE_NUM acyclic-by-construction)", async () => {
    // Existing edge c→p (p's parent is c). Adding p→c would close a 2-cycle.
    const { sync, rec } = fake([
      makeGoal("c", "C", { children: ["p"] }),
      makeGoal("p", "P", { parents: ["c"] }),
    ]);
    await expect(addRelationship(sync, { parentId: "p", childId: "c" })).rejects.toThrow(
      /would introduce a graph cycle/
    );
    expect(rec.calls).toHaveLength(0); // guard ran before any write

    // Self-parent edge is a trivial 1-cycle.
    const self = fake([makeGoal("a", "A")]);
    await expect(addRelationship(self.sync, { parentId: "a", childId: "a" })).rejects.toThrow(
      /would introduce a graph cycle/
    );
    expect(self.rec.calls).toHaveLength(0);
  });

  it("addRelationship rejects transitive cycles but allows DAG diamonds ", async () => {
    // Chain a→b→c. Adding c→a would close a 3-cycle (a is an ancestor of c).
    const chain = fake([
      makeGoal("a", "A", { children: ["b"] }),
      makeGoal("b", "B", { parents: ["a"], children: ["c"] }),
      makeGoal("c", "C", { parents: ["b"] }),
    ]);
    await expect(addRelationship(chain.sync, { parentId: "c", childId: "a" })).rejects.toThrow(
      /would introduce a graph cycle/
    );
    expect(chain.rec.calls).toHaveLength(0);

    // Diamond: d already parents both b and c; adding b→c (a second parent for c)
    // is a valid DAG edge, not a cycle — it must be allowed.
    const diamond = fake([
      makeGoal("d", "D", { children: ["b", "c"] }),
      makeGoal("b", "B", { parents: ["d"] }),
      makeGoal("c", "C", { parents: ["d"] }),
    ]);
    await addRelationship(diamond.sync, { parentId: "b", childId: "c" });
    expect(diamond.rec.calls[0]?.logEntry).toMatchObject({ type: "addParent", parentId: "b" });
  });

  it("addRelationship's cycle walk terminates on a pre-existing cyclic graph (ISSUE_NUM/ISSUE_NUM)", async () => {
    // The pre-mesh graph still holds real cycles (x↔y). Walking up from x, the
    // ancestor walk enters the x→y→x loop; the visited-set must terminate it
    // rather than hang, and still permit the unrelated valid edge x→z.
    const { sync, rec } = fake([
      makeGoal("x", "X", { parents: ["y"], children: ["y"] }),
      makeGoal("y", "Y", { parents: ["x"], children: ["x"] }),
      makeGoal("z", "Z"),
    ]);
    await addRelationship(sync, { parentId: "x", childId: "z" });
    expect(rec.calls[0]?.logEntry).toMatchObject({ type: "addParent", parentId: "x" });
  });

  it("archiveNode sets the archived status", async () => {
    const { sync, rec } = fake([
      makeGoal("root", "Root", { children: ["a"] }),
      makeGoal("a", "A", { parents: ["root"] }),
    ]);
    await archiveNode(sync, "a");
    expect(rec.calls[0]).toMatchObject({ id: "a" });
    expect(rec.calls[0]?.logEntry).toMatchObject({ type: "status", status: "ar" });
    await expect(archiveNode(sync, "x")).rejects.toThrow(/not found/);
  });

  it("refuses to archive or rename a root node (ISSUE_NUM root guard)", async () => {
    // 'root' has no parent present in the graph → it is a top-level root.
    const { sync, rec } = fake([
      makeGoal("root", "IU Root", { children: ["a"] }),
      makeGoal("a", "A", { parents: ["root"] }),
    ]);
    await expect(archiveNode(sync, "root")).rejects.toThrow(/refusing to archive a root node/);
    await expect(updateNodeTitle(sync, { nodeId: "root", newTitle: "x" })).rejects.toThrow(
      /refusing to rename a root node/
    );
    expect(rec.calls).toHaveLength(0); // guard ran before any write
    // Non-root nodes are still editable.
    await archiveNode(sync, "a");
    await updateNodeTitle(sync, { nodeId: "a", newTitle: "A2" });
    expect(rec.calls).toHaveLength(2);
  });
});

describe("graph-store root-scoped visibility ", () => {
  it("viewNode and listChildren enforce root-scoped reachability", () => {
    const { sync } = fake([
      makeGoal("root", "Root", { children: ["child1"] }),
      makeGoal("child1", "Child 1", { parents: ["root"], children: ["grandchild1"] }),
      makeGoal("grandchild1", "Grandchild 1", { parents: ["child1"] }),
      makeGoal("orphan_root", "Orphan Root", { children: ["orphan_child"] }),
      makeGoal("orphan_child", "Orphan Child", { parents: ["orphan_root"] }),
    ]);

    // When rootNodeId is passed, reachable nodes are visible
    expect(viewNode(sync, "child1", "root")).not.toBeNull();
    expect(viewNode(sync, "grandchild1", "root")).not.toBeNull();

    // Nodes outside the transitive closure of root are not found
    expect(viewNode(sync, "orphan_root", "root")).toBeNull();
    expect(viewNode(sync, "orphan_child", "root")).toBeNull();

    // listChildren without parentId lists direct children of rootNodeId
    const rootChildren = listChildren(sync, undefined, "root");
    expect(rootChildren?.map((c) => c.id)).toEqual(["child1"]);

    // An out-of-scope parent is not visible, so it reads as not-found rather than
    // as a childless node  — the same answer viewNode gives for it above.
    expect(listChildren(sync, "orphan_root", "root")).toBeNull();
    // …and so does the root itself, which is hidden by design.
    expect(listChildren(sync, "root", "root")).toBeNull();
    expect(listChildren(sync, "grandchild1", "root")).toEqual([]);
  });

  it("createNode automatically links under rootNodeId when parentId is omitted", async () => {
    const { sync, rec } = fake([makeGoal("root", "Root")]);
    const id = await createNode(sync, { title: "Auto Root Child", contents: "body" }, "root");
    expect(id).toBeTruthy();
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[1]?.logEntry).toMatchObject({ type: "addParent", parentId: "root" });
  });

  it("write operations reject target nodes outside the root-scoped closure", async () => {
    const { sync } = fake([
      makeGoal("root", "Root", { children: ["child1"] }),
      makeGoal("child1", "Child 1", { parents: ["root"] }),
      makeGoal("orphan", "Orphan"),
    ]);

    await expect(
      updateNodeContents(sync, { nodeId: "orphan", action: "replace", text: "new" }, "root")
    ).rejects.toThrow(/node not found/);

    await expect(
      updateNodeTitle(sync, { nodeId: "orphan", newTitle: "renamed" }, "root")
    ).rejects.toThrow(/node not found/);

    await expect(archiveNode(sync, "orphan", "root")).rejects.toThrow(/node not found/);

    await expect(
      addRelationship(sync, { parentId: "child1", childId: "orphan" }, "root")
    ).rejects.toThrow(/child node not found/);
  });
});
