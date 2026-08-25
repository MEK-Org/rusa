import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Goal, SyncClient } from "@thkp-eng/goals-core";
import type { GoalLogEntry } from "@thkp-eng/goals-types";
import { describe, expect, it } from "vitest";
import {
  createUnderstandingReadServer,
  createUnderstandingSyncClientProvider,
  createUnderstandingWriteServer,
  type UnderstandingMcpDeps,
} from "./understanding-mcp.js";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function dataOf(result: CallToolResult): unknown {
  const first = result.content[0];
  const text = first && first.type === "text" ? first.text : "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function makeGoal(id: string, text: string, contents?: string): Goal {
  const log: GoalLogEntry[] = [];
  if (contents !== undefined) {
    log.push({
      id: `e-${id}`,
      creationTime: 1,
      type: "documentContents",
      text: contents,
    } as GoalLogEntry);
  }
  return { id, text, superGoalIds: new Set(), subGoalIds: new Set(), log } as unknown as Goal;
}

class FakeSync {
  goals = new Map<string, Goal>();
  calls: { id: string }[] = [];
  getGoals(): Map<string, Goal> {
    return this.goals;
  }
  async modifyGoal(delta: { id: string }): Promise<void> {
    this.calls.push(delta);
  }
}

function depsWith(goals: Goal[]): { deps: UnderstandingMcpDeps; rec: FakeSync } {
  const rec = new FakeSync();
  for (const g of goals) rec.goals.set(g.id, g);
  return { deps: { getClient: async () => rec as unknown as SyncClient }, rec };
}

const DEAD_DEPS: UnderstandingMcpDeps = { getClient: async () => null };

describe("understanding read MCP", () => {
  it("exposes the pull-only read tools", async () => {
    const client = await connect(createUnderstandingReadServer(depsWith([]).deps));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_node", "list_children", "overview", "search"].sort()
    );
  });

  it("get_node returns a node, or an error result when missing", async () => {
    const { deps } = depsWith([makeGoal("a", "Alpha", "# body")]);
    const client = await connect(createUnderstandingReadServer(deps));
    const ok = (await client.callTool({
      name: "get_node",
      arguments: { id: "a" },
    })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    expect(dataOf(ok)).toMatchObject({ id: "a", title: "Alpha", contents: "# body" });

    const miss = (await client.callTool({
      name: "get_node",
      arguments: { id: "nope" },
    })) as CallToolResult;
    expect(miss.isError).toBe(true);
  });

  it("search finds nodes by keyword", async () => {
    const { deps } = depsWith([makeGoal("a", "TypeScript conventions", "use strict types")]);
    const client = await connect(createUnderstandingReadServer(deps));
    const res = (await client.callTool({
      name: "search",
      arguments: { query: "typescript" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect((dataOf(res) as { id: string }[]).map((n) => n.id)).toContain("a");
  });

  it("overview returns top-level children without exposing rootNodeId", async () => {
    const rootGoal = makeGoal("root_123", "Integrated Knowledge Universe", "Root");
    const childGoal = makeGoal("child_1", "Architecture Principles", "# body");
    rootGoal.subGoalIds.add("child_1");
    childGoal.superGoalIds.add("root_123");

    const { deps } = depsWith([rootGoal, childGoal]);
    const client = await connect(createUnderstandingReadServer(deps, "root_123"));

    const overviewRes = (await client.callTool({
      name: "overview",
      arguments: {},
    })) as CallToolResult;
    expect(overviewRes.isError).toBeFalsy();
    const overviewData = dataOf(overviewRes) as { root?: unknown; children: { id: string }[] };
    expect(overviewData.root).toBeUndefined();
    expect(overviewData.children.map((c) => c.id)).toEqual(["child_1"]);

    // get_node for rootNodeId itself returns error (not found)
    const rootNodeRes = (await client.callTool({
      name: "get_node",
      arguments: { id: "root_123" },
    })) as CallToolResult;
    expect(rootNodeRes.isError).toBe(true);
  });

  it("rejects list_children(id=…) rather than answering about the top level ", async () => {
    const rootGoal = makeGoal("root_123", "Root", "Root");
    const area = makeGoal("area_1", "An area", "# body");
    const child = makeGoal("child_1", "A child", "# body");
    rootGoal.subGoalIds.add("area_1");
    area.superGoalIds.add("root_123");
    area.subGoalIds.add("child_1");
    child.superGoalIds.add("area_1");

    const { deps } = depsWith([rootGoal, area, child]);
    const client = await connect(createUnderstandingReadServer(deps, "root_123"));

    // `id` is the name the sibling get_node tool takes. Silently dropped, it
    // read as "no node_id given" — the documented request for the top-level
    // set — so a downward reachability walk succeeded for any node at all.
    const wrongName = (await client.callTool({
      name: "list_children",
      arguments: { id: "area_1" },
    })) as CallToolResult;
    expect(wrongName.isError).toBe(true);
    expect((wrongName.content[0] as { text: string }).text).toMatch(/Unrecognized key.*id/);

    const correct = (await client.callTool({
      name: "list_children",
      arguments: { node_id: "area_1" },
    })) as CallToolResult;
    expect(correct.isError).toBeFalsy();
    expect((dataOf(correct) as { id: string }[]).map((n) => n.id)).toEqual(["child_1"]);
  });

  it("list_children errors on an id that names nothing, like get_node ", async () => {
    const rootGoal = makeGoal("root_123", "Root", "Root");
    const leaf = makeGoal("child_1", "A childless child", "# body");
    const orphan = makeGoal("orphan_1", "Outside the root closure", "# body");
    rootGoal.subGoalIds.add("child_1");
    leaf.superGoalIds.add("root_123");

    const { deps } = depsWith([rootGoal, leaf, orphan]);
    const client = await connect(createUnderstandingReadServer(deps, "root_123"));

    // A real node with no children still answers `[]` — without this half the
    // error case below would pass against a tool that errored on everything.
    const childless = (await client.callTool({
      name: "list_children",
      arguments: { node_id: "child_1" },
    })) as CallToolResult;
    expect(childless.isError).toBeFalsy();
    expect(dataOf(childless)).toEqual([]);

    // …and an id one character off from that real one is an error, not the same
    // `[]`. Indistinguishable answers were the defect: the cheap probe for "does
    // this id resolve" silently passed every mistyped id.
    for (const badId of ["child_2", "orphan_1", "root_123"]) {
      const miss = (await client.callTool({
        name: "list_children",
        arguments: { node_id: badId },
      })) as CallToolResult;
      expect(miss.isError, badId).toBe(true);
      expect((miss.content[0] as { text: string }).text).toContain(`node not found: ${badId}`);
    }
  });

  it("fails soft (error result) when glass-goals is unreachable", async () => {
    const client = await connect(createUnderstandingReadServer(DEAD_DEPS));
    const res = (await client.callTool({ name: "overview", arguments: {} })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/unavailable/);
  });
});

describe("understanding write MCP", () => {
  it("exposes the write tools", async () => {
    const client = await connect(createUnderstandingWriteServer(depsWith([]).deps));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "add_relationship",
        "archive_node",
        "create_node",
        "splice_node_contents",
        "remove_relationship",
        "update_node_contents",
        "update_node_title",
      ].sort()
    );
  });

  it("create_node writes through to the store and returns an id", async () => {
    const { deps, rec } = depsWith([]);
    const client = await connect(createUnderstandingWriteServer(deps));
    const res = (await client.callTool({
      name: "create_node",
      arguments: { title: "New", contents: "# md" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(dataOf(res)).toMatchObject({ id: expect.any(String) });
    expect(rec.calls.length).toBeGreaterThan(0);
  });

  it("update_node_contents stays terse when the body is inside the split triggers", async () => {
    const { deps } = depsWith([makeGoal("a", "A", "old")]);
    const client = await connect(createUnderstandingWriteServer(deps));
    const res = (await client.callTool({
      name: "update_node_contents",
      arguments: { node_id: "a", action: "append", text: "more" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(dataOf(res)).toBe("ok");
  });

  it("update_node_contents still writes but returns the split-trigger numbers ", async () => {
    // Nine `## ` sections already — one past the trigger — and the append opens a
    // tenth, dated, section: exactly the changelog step. The write must land anyway.
    const previous = Array.from({ length: 9 }, (_, i) => `## Section ${i + 1}\nbody`).join("\n\n");
    const { deps, rec } = depsWith([makeGoal("a", "A", previous)]);
    const client = await connect(createUnderstandingWriteServer(deps));
    const res = (await client.callTool({
      name: "update_node_contents",
      arguments: { node_id: "a", action: "append", text: "## 2026-08-12 update\nthis window" },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(rec.calls.length).toBe(1); // warn, never refuse
    const data = dataOf(res) as { status: string; warnings: string[] };
    expect(data.status).toBe("ok");
    expect(data.warnings.some((w) => w.includes('10 "## " sections'))).toBe(true);
    expect(data.warnings.some((w) => w.includes("ALREADY over a split trigger"))).toBe(true);
  });

  it("splice_node_contents corrects a passage in place ", async () => {
    const { deps, rec } = depsWith([makeGoal("a", "A", "before. ISSUE_NUM is still open. after.")]);
    const client = await connect(createUnderstandingWriteServer(deps));
    const res = (await client.callTool({
      name: "splice_node_contents",
      arguments: {
        node_id: "a",
        old_text: "ISSUE_NUM is still open",
        new_text: "ISSUE_NUM was closed",
      },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(dataOf(res)).toBe("ok");
    expect(rec.calls).toHaveLength(1);
  });

  it("splice_node_contents fails the call, writing nothing, on a bad anchor ", async () => {
    // Both failure modes must reach the caller as an ERROR result: a silent no-op
    // reads as "corrected" when the false line is still standing, and a first-match
    // guess corrects the wrong occurrence while leaving the intended one in place.
    const { deps, rec } = depsWith([makeGoal("a", "A", "open. open.")]);
    const client = await connect(createUnderstandingWriteServer(deps));

    const absent = (await client.callTool({
      name: "splice_node_contents",
      arguments: { node_id: "a", old_text: "absent", new_text: "x" },
    })) as CallToolResult;
    expect(absent.isError).toBe(true);
    expect((absent.content[0] as { text: string }).text).toMatch(/old_text not found/);

    const ambiguous = (await client.callTool({
      name: "splice_node_contents",
      arguments: { node_id: "a", old_text: "open", new_text: "closed" },
    })) as CallToolResult;
    expect(ambiguous.isError).toBe(true);
    expect((ambiguous.content[0] as { text: string }).text).toMatch(/matches 2 times/);

    expect(rec.calls).toHaveLength(0);

    // replace_all is the caller saying they meant every occurrence.
    const all = (await client.callTool({
      name: "splice_node_contents",
      arguments: { node_id: "a", old_text: "open", new_text: "closed", replace_all: true },
    })) as CallToolResult;
    expect(all.isError).toBeFalsy();
    expect(rec.calls).toHaveLength(1);
  });

  it("create_node warns when a node is born over a split trigger ", async () => {
    const { deps } = depsWith([]);
    const client = await connect(createUnderstandingWriteServer(deps));
    const res = (await client.callTool({
      name: "create_node",
      arguments: { title: "Huge", contents: "x".repeat(10_001) },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    const data = dataOf(res) as { id: string; warnings: string[] };
    expect(data.id).toEqual(expect.any(String));
    expect(data.warnings.some((w) => w.includes("10001 characters"))).toBe(true);
  });

  it("surfaces a store validation error as an error result", async () => {
    const { deps } = depsWith([]);
    const client = await connect(createUnderstandingWriteServer(deps));
    const res = (await client.callTool({
      name: "create_node",
      arguments: { title: "x", contents: "", parent_id: "nope" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/parent node not found/);
  });

  it("fails soft when glass-goals is unreachable", async () => {
    const client = await connect(createUnderstandingWriteServer(DEAD_DEPS));
    const res = (await client.callTool({
      name: "create_node",
      arguments: { title: "x", contents: "y" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/unavailable/);
  });
});

describe("createUnderstandingSyncClientProvider (DI lifecycle)", () => {
  const fakeClient = {} as unknown as SyncClient;

  it("loads lazily, memoizes a successful client, and re-loads after reset", async () => {
    let loads = 0;
    const provider = createUnderstandingSyncClientProvider(async () => {
      loads++;
      return fakeClient;
    });
    expect(loads).toBe(0); // lazy — no login at construction
    expect(await provider.getClient()).toBe(fakeClient);
    expect(await provider.getClient()).toBe(fakeClient);
    expect(loads).toBe(1); // memoized: one login shared across the run
    provider.reset();
    expect(await provider.getClient()).toBe(fakeClient);
    expect(loads).toBe(2); // reset → re-login (auth-expiry seam)
  });

  it("does NOT memoize a null (fail-soft) result — retries until a client appears", async () => {
    let loads = 0;
    const provider = createUnderstandingSyncClientProvider(async () => {
      loads++;
      return loads < 3 ? null : fakeClient; // null twice, then a real client
    });
    expect(await provider.getClient()).toBeNull();
    expect(await provider.getClient()).toBeNull();
    expect(await provider.getClient()).toBe(fakeClient);
    expect(loads).toBe(3);
    expect(await provider.getClient()).toBe(fakeClient);
    expect(loads).toBe(3); // success now memoized
  });

  it("shares one in-flight login across concurrent first calls", async () => {
    let loads = 0;
    const provider = createUnderstandingSyncClientProvider(async () => {
      loads++;
      return fakeClient;
    });
    const [a, b] = await Promise.all([provider.getClient(), provider.getClient()]);
    expect(a).toBe(fakeClient);
    expect(b).toBe(fakeClient);
    expect(loads).toBe(1); // concurrent first-calls dedup to one login
  });
});

describe("understanding read MCP — overview anchoring (ISSUE_NUM 1d)", () => {
  // Build a graph with a canonical root + children AND an orphan top-level node
  // (mirrors the real glass-goals account: old-distiller cruft beside the root).
  const g = (
    id: string,
    text: string,
    opts: { children?: string[]; parents?: string[] } = {}
  ): Goal =>
    ({
      id,
      text,
      superGoalIds: new Set(opts.parents ?? []),
      subGoalIds: new Set(opts.children ?? []),
      log: [],
    }) as unknown as Goal;
  const graph = (): Goal[] => [
    g("root", "IU Root", { children: ["c1", "c2"] }),
    g("c1", "Concept 1", { parents: ["root"] }),
    g("c2", "Concept 2", { parents: ["root"] }),
    g("junk", "", {}), // orphan top-level (old-distiller cruft)
  ];

  it("anchors overview to the configured root — its children, not orphan top-level", async () => {
    const { deps } = depsWith(graph());
    const client = await connect(createUnderstandingReadServer(deps, "root"));
    const data = dataOf(
      (await client.callTool({ name: "overview", arguments: {} })) as CallToolResult
    ) as { children: { id: string }[] };
    expect(data.children.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("falls back to top-level roots when no root is configured", async () => {
    const { deps } = depsWith(graph());
    const client = await connect(createUnderstandingReadServer(deps));
    const data = dataOf(
      (await client.callTool({ name: "overview", arguments: {} })) as CallToolResult
    ) as { children: { id: string }[] };
    expect(data.children.map((c) => c.id).sort()).toEqual(["junk", "root"]);
  });

  it("falls back gracefully when the configured root id is not found (stale id)", async () => {
    const { deps } = depsWith(graph());
    const client = await connect(createUnderstandingReadServer(deps, "missing"));
    const data = dataOf(
      (await client.callTool({ name: "overview", arguments: {} })) as CallToolResult
    ) as { children: { id: string }[] };
    expect(data.children.map((c) => c.id).sort()).toEqual(["junk", "root"]);
  });
});

describe("understanding read MCP — externalized body resolution (ISSUE_NUM read-MCP working-copy)", () => {
  type Result = { id: string; title: string; contents: string }[];
  // inline (distiller backfill) keeps its body; externalized (text-less entry) resolves via
  // loadStrings; an unresolved externalized body degrades to empty (never errors the read).
  const nodes = () => [
    makeGoal("inline1", "Actor Mesh", "Full inline backfill body about the mesh."),
    makeGoal("ext1", "Glass Goals Architecture", ""), // externalized: entry present, text empty
    makeGoal("miss1", "Orphan Externalized", ""), // externalized but string unresolvable
  ];
  // Resolve only e-ext1 (the entry id makeGoal assigns); omit e-miss1 → that body stays empty.
  const loadStrings = async (ids: string[]): Promise<Record<string, string>> =>
    ids.includes("e-ext1") ? { "e-ext1": "Resolved externalized body about glass-goals." } : {};

  it("search returns inline content directly, resolves externalized bodies, degrades misses to empty", async () => {
    const { deps } = depsWith(nodes());
    const client = await connect(createUnderstandingReadServer(deps, undefined, loadStrings));
    const data = dataOf(
      (await client.callTool({
        name: "search",
        arguments: { query: "mesh glass goals architecture orphan" },
      })) as CallToolResult
    ) as Result;
    const byId = Object.fromEntries(data.map((n) => [n.id, n.contents]));
    expect(byId.inline1).toBe("Full inline backfill body about the mesh.");
    expect(byId.ext1).toBe("Resolved externalized body about glass-goals.");
    expect(byId.miss1).toBe(""); // graceful per-entry degradation
  });

  it("get_node resolves an externalized body via loadStrings", async () => {
    const { deps } = depsWith(nodes());
    const client = await connect(createUnderstandingReadServer(deps, undefined, loadStrings));
    const data = dataOf(
      (await client.callTool({ name: "get_node", arguments: { id: "ext1" } })) as CallToolResult
    ) as { contents: string };
    expect(data.contents).toBe("Resolved externalized body about glass-goals.");
  });

  it("without a strings resolver, an externalized body stays empty (no crash)", async () => {
    const { deps } = depsWith(nodes());
    const client = await connect(createUnderstandingReadServer(deps)); // no loadStrings
    const data = dataOf(
      (await client.callTool({ name: "get_node", arguments: { id: "ext1" } })) as CallToolResult
    ) as { contents: string };
    expect(data.contents).toBe("");
  });
});
