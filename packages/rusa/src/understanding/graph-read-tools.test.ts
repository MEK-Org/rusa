import type { Goal } from "@thkp-eng/goals-core";
import type { GoalLogEntry } from "@thkp-eng/goals-types";
import { describe, expect, it } from "vitest";
import { handleGraphReadTool } from "./graph-read-tools.js";

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

function graph(goals: Goal[]): Map<string, Goal> {
  return new Map(goals.map((g) => [g.id, g]));
}

/** The distiller's configuration: the whole graph, short previews, parents on getNode. */
const DISTILL = { snippetLength: 100, includeParents: true };
/** LLM retrieval's configuration: root-scoped, longer previews, no parents. */
const RETRIEVAL = { snippetLength: 120, includeParents: false, rootNodeId: "root" };

/**
 * The graph both configurations read. `outside` is deliberately unreachable from
 * `root` so the root-scoped caller and the whole-graph caller disagree about it —
 * which is the point: they disagree by configuration, not by re-derived rule.
 */
function fixture(): Map<string, Goal> {
  return graph([
    makeGoal("root", "Root", { children: ["parent"] }),
    makeGoal("parent", "Parent", {
      parents: ["root"],
      children: ["leaf"],
      contents: "parent body",
    }),
    makeGoal("leaf", "Leaf", { parents: ["parent"], contents: "leaf body" }),
    makeGoal("outside", "Outside the closure", { contents: "orphan body" }),
  ]);
}

describe("handleGraphReadTool", () => {
  // The property ISSUE_NUM established for the store, now required of the tool loops:
  // an empty result and a bad id must not look the same (ISSUE_NUM, ISSUE_NUM).
  for (const [label, opts] of [
    ["distiller (whole graph)", DISTILL],
    ["LLM retrieval (root-scoped)", RETRIEVAL],
  ] as const) {
    it(`separates a childless node from a nonexistent one via listChildren — ${label}`, () => {
      const goals = fixture();
      expect(handleGraphReadTool(goals, "listChildren", { node_id: "leaf" }, opts)).toEqual({
        children: [],
      });
      // One character off. The old inline implementations answered `{children: []}`
      // here, which is what made the cheap "does this id resolve" probe useless.
      expect(handleGraphReadTool(goals, "listChildren", { node_id: "leax" }, opts)).toEqual({
        error: "node not found: leax",
      });
    });

    it(`separates a real node from a nonexistent one via getNode — ${label}`, () => {
      const goals = fixture();
      const found = handleGraphReadTool(goals, "getNode", { node_id: "leaf" }, opts);
      expect(found.id).toBe("leaf");
      expect(found.error).toBeUndefined();
      expect(handleGraphReadTool(goals, "getNode", { node_id: "leax" }, opts)).toEqual({
        error: "node not found: leax",
      });
    });
  }

  it("root-scoped reading hides the configured root and everything outside its closure", () => {
    const goals = fixture();
    // The no-argument call asks for the top-level set and always resolves: it is
    // the root's children, which is how the retrieval prompt starts exploring.
    expect(handleGraphReadTool(goals, "listChildren", {}, RETRIEVAL)).toEqual({
      children: [{ id: "parent", title: "Parent", snippet: "parent body", childCount: 1 }],
    });
    // Naming the root explicitly is not a way around it being hidden.
    expect(handleGraphReadTool(goals, "listChildren", { node_id: "root" }, RETRIEVAL)).toEqual({
      error: "node not found: root",
    });
    expect(handleGraphReadTool(goals, "getNode", { node_id: "root" }, RETRIEVAL)).toEqual({
      error: "node not found: root",
    });
    expect(handleGraphReadTool(goals, "getNode", { node_id: "outside" }, RETRIEVAL)).toEqual({
      error: "node not found: outside",
    });
  });

  it("the whole-graph reader still sees what the root-scoped one does not", () => {
    const goals = fixture();
    expect(handleGraphReadTool(goals, "getNode", { node_id: "outside" }, DISTILL).id).toBe(
      "outside"
    );
    expect(handleGraphReadTool(goals, "getNode", { node_id: "root" }, DISTILL).id).toBe("root");
    // No rootNodeId means the top-level set is the graph's own roots, with one
    // level of their children so an unscoped caller sees the shape in one call.
    expect(handleGraphReadTool(goals, "listChildren", {}, DISTILL)).toEqual({
      children: [
        { id: "root", title: "Root", children: [{ id: "parent", title: "Parent" }] },
        { id: "outside", title: "Outside the closure", children: [] },
      ],
    });
  });

  it("honours each caller's projection rather than keeping a second copy of the rule", () => {
    const goals = graph([
      makeGoal("p", "P", { children: ["c"] }),
      makeGoal("c", "C", { parents: ["p"], contents: "x".repeat(200) }),
    ]);
    const distilled = handleGraphReadTool(goals, "listChildren", { node_id: "p" }, DISTILL);
    const retrieved = handleGraphReadTool(
      goals,
      "listChildren",
      { node_id: "p" },
      { ...RETRIEVAL, rootNodeId: undefined }
    );
    expect((distilled.children as { snippet: string }[])[0].snippet).toHaveLength(100);
    expect((retrieved.children as { snippet: string }[])[0].snippet).toHaveLength(120);

    expect(handleGraphReadTool(goals, "getNode", { node_id: "c" }, DISTILL).parents).toEqual([
      { id: "p", title: "P" },
    ]);
    expect(
      handleGraphReadTool(
        goals,
        "getNode",
        { node_id: "c" },
        { ...RETRIEVAL, rootNodeId: undefined }
      )
    ).not.toHaveProperty("parents");
  });
});
