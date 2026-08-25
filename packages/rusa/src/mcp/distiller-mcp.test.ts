import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DistillerState } from "../understanding/distiller-cursor.js";
import { iuReportPaths } from "../understanding/persistence-utils.js";
import {
  createDistillerServer,
  DISTILLER_MCP_NAME,
  type DistillerMcpStore,
  type DistillerSeedSource,
} from "./distiller-mcp.js";

const SEED = "2026-06-10T00:00:00.000Z";

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
  return JSON.parse(text);
}

function createMemoryStore(opts?: {
  seedSource?: DistillerSeedSource;
  count?: number;
  unsyncedCount?: number;
}): DistillerMcpStore {
  let state: DistillerState = {
    lastDistilled: null,
    consecutiveFailures: 0,
  };
  return {
    getState: () => ({ ...state }),
    setState: (next) => {
      state = { ...next };
    },
    seedIfUnset: (iso) => {
      if (state.lastDistilled !== null) return false;
      state = { ...state, lastDistilled: iso };
      return true;
    },
    countSubstantiveEvents: () => opts?.count ?? 0,
    resolveSeed: async () => opts?.seedSource ?? { seed: SEED, reason: "glass-goals-latest-op" },
    unsyncedCount: () => opts?.unsyncedCount ?? 0,
  };
}

describe("distiller MCP", () => {
  it("uses the expected grantable server name", () => {
    expect(DISTILLER_MCP_NAME).toBe("distiller");
  });

  it("exposes only distill cursor tools from a narrow store adapter", async () => {
    const client = await connect(createDistillerServer({ store: createMemoryStore() }));

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "distill_gate",
      "distill_window",
      "distill_seed",
      "distill_advance",
      "distill_status",
      "distill_journal_append",
      "distill_report_render",
    ]);
  });

  it("distill_seed seeds once from the host seed source", async () => {
    const client = await connect(
      createDistillerServer({
        store: createMemoryStore({
          seedSource: {
            seed: "2026-06-20T00:00:00.000Z",
            reason: "glass-goals-latest-op",
          },
        }),
      })
    );

    const seeded = dataOf(
      (await client.callTool({ name: "distill_seed", arguments: {} })) as CallToolResult
    );
    expect(seeded).toEqual({
      seeded: true,
      cursor: "2026-06-20T00:00:00.000Z",
      source: "glass-goals-latest-op",
    });

    const repeated = dataOf(
      (await client.callTool({ name: "distill_seed", arguments: {} })) as CallToolResult
    );
    expect(repeated).toEqual({
      seeded: false,
      cursor: "2026-06-20T00:00:00.000Z",
    });
  });

  it("distill_seed does not seed when glass-goals is unreachable", async () => {
    const store = createMemoryStore({
      seedSource: { seed: null, reason: "glass-goals-unreachable" },
    });
    const client = await connect(createDistillerServer({ store }));

    const result = dataOf(
      (await client.callTool({ name: "distill_seed", arguments: {} })) as CallToolResult
    );
    expect(result).toEqual({ seeded: false, reason: "glass-goals-unreachable" });
    expect(store.getState().lastDistilled).toBeNull();
  });

  it("distill_gate reads the full gate window count", async () => {
    const store = createMemoryStore({ count: 2 });
    store.seedIfUnset(SEED);
    const client = await connect(createDistillerServer({ store }));

    const result = dataOf(
      (await client.callTool({
        name: "distill_gate",
        arguments: { now: "2026-06-30T00:00:00.000Z" },
      })) as CallToolResult
    );
    expect(result).toEqual({
      active: true,
      since: SEED,
      until: "2026-06-30T00:00:00.000Z",
      count: 2,
    });
  });

  it("distill_window returns the capped scan window", async () => {
    const store = createMemoryStore();
    store.seedIfUnset(SEED);
    const client = await connect(createDistillerServer({ store }));

    const result = dataOf(
      (await client.callTool({
        name: "distill_window",
        arguments: { now: "2026-07-01T00:00:00.000Z", cap_days: 3 },
      })) as CallToolResult
    );
    expect(result).toEqual({
      from: SEED,
      to: "2026-06-13T00:00:00.000Z",
      includesMesh: false,
    });
  });

  it("distill_advance commits the cursor according to the core policy", async () => {
    const store = createMemoryStore();
    store.seedIfUnset(SEED);
    const client = await connect(createDistillerServer({ store }));

    const result = dataOf(
      (await client.callTool({
        name: "distill_advance",
        arguments: { to: "2026-06-13T00:00:00.000Z", ok: true },
      })) as CallToolResult
    );
    expect(result).toEqual({
      lastDistilled: "2026-06-13T00:00:00.000Z",
      consecutiveFailures: 0,
      gap: null,
    });
    expect(store.getState().lastDistilled).toBe("2026-06-13T00:00:00.000Z");
  });

  it("distill_status includes the local outbox unsynced op count", async () => {
    const store = createMemoryStore({ unsyncedCount: 3 });
    store.seedIfUnset(SEED);
    const client = await connect(createDistillerServer({ store }));

    const result = dataOf(
      (await client.callTool({ name: "distill_status", arguments: {} })) as CallToolResult
    );

    expect(result).toEqual({
      lastDistilled: SEED,
      consecutiveFailures: 0,
      unsyncedCount: 3,
      chatSpaces: {
        status: "not_configured",
        spaces: [],
        note: expect.stringContaining("no Google Chat identity is wired"),
      },
    });
  });

  it("distill_status distinguishes 'no Chat on this host' from 'a member of nothing'", async () => {
    // Both would arrive as `[]`, and they call for opposite reports: one is a
    // host fact, the other is a measurement of the org (ISSUE_NUM/ISSUE_NUM).
    const noChat = dataOf(
      (await (
        await connect(createDistillerServer({ store: createMemoryStore() }))
      ).callTool({ name: "distill_status", arguments: {} })) as CallToolResult
    ) as { chatSpaces: { status: string; spaces: string[] } };
    expect(noChat.chatSpaces.status).toBe("not_configured");
    expect(noChat.chatSpaces.spaces).toEqual([]);

    const memberOfNothing = dataOf(
      (await (
        await connect(
          createDistillerServer({
            store: createMemoryStore(),
            listChatSpaces: async () => ({ spaces: [], complete: true }),
          })
        )
      ).callTool({ name: "distill_status", arguments: {} })) as CallToolResult
    ) as { chatSpaces: { status: string; spaces: string[] } };
    expect(memberOfNothing.chatSpaces.status).toBe("enumerated");
    expect(memberOfNothing.chatSpaces.spaces).toEqual([]);
  });

  it("distill_status reports the enumerated membership as the read set", async () => {
    // The read set is measured, not configured: it is every space the identity
    // belongs to, and judgment about what belongs in a durable node is applied
    // per message while distilling rather than by excluding a space up front.
    const client = await connect(
      createDistillerServer({
        store: createMemoryStore(),
        listChatSpaces: async () => ({
          spaces: [
            { name: "spaces/AAA", spaceType: "SPACE" },
            { name: "spaces/BBB", spaceType: "DIRECT_MESSAGE" },
          ],
          complete: true,
        }),
      })
    );

    const result = dataOf(
      (await client.callTool({ name: "distill_status", arguments: {} })) as CallToolResult
    ) as { chatSpaces: { status: string; spaces: string[]; note: string } };

    expect(result.chatSpaces.status).toBe("enumerated");
    expect(result.chatSpaces.spaces).toEqual(["spaces/AAA", "spaces/BBB"]);
    // A DM is in the read set. The carve-out that used to filter these out is
    // exactly what Operator's ruling removed.
    expect(result.chatSpaces.note).toContain("not pre-filtered");
  });

  it("distill_status says a half-walked membership is NOT the read set", async () => {
    // The failure to avoid: reporting a partial walk as the scope, which turns a
    // broken enumeration into a silently narrower — and clean-looking — run.
    const client = await connect(
      createDistillerServer({
        store: createMemoryStore(),
        listChatSpaces: async () => ({
          spaces: [{ name: "spaces/AAA" }],
          complete: false,
          error: "page ceiling reached after 50 pages",
        }),
      })
    );

    const result = dataOf(
      (await client.callTool({ name: "distill_status", arguments: {} })) as CallToolResult
    ) as { chatSpaces: { status: string; spaces: string[]; note: string; error?: string } };

    expect(result.chatSpaces.status).toBe("incomplete");
    expect(result.chatSpaces.spaces).toEqual(["spaces/AAA"]);
    expect(result.chatSpaces.note).toContain("does NOT know its chat read set");
    expect(result.chatSpaces.error).toContain("page ceiling");
  });
});

describe("distiller MCP — nightly reports ", () => {
  let mcHome: string;
  const RUN_ID = "2026-07-14T03:00:00.000Z__2026-07-15T03:00:00.000Z";

  beforeEach(() => {
    mcHome = mkdtempSync(join(tmpdir(), "iu-reports-"));
  });
  afterEach(() => {
    rmSync(mcHome, { recursive: true, force: true });
  });

  it("fails soft when report emission is not configured", async () => {
    const client = await connect(createDistillerServer({ store: createMemoryStore() }));
    const result = (await client.callTool({
      name: "distill_journal_append",
      arguments: {
        run_id: RUN_ID,
        entry: {
          type: "run_meta",
          window: { from: "a", to: "b", includesMesh: true },
          gate: { active: true, eventCount: 1 },
          cursor_before: "a",
          distiller_actor: "t",
        },
      },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    const first = result.content[0];
    expect(first && first.type === "text" ? first.text : "").toContain("not configured");
  });

  it("appends a run journal and renders it into index.json (round-trip)", async () => {
    const paths = iuReportPaths(mcHome);
    const client = await connect(
      createDistillerServer({
        store: createMemoryStore(),
        reports: { paths, now: () => "2026-07-15T03:12:00.000Z" },
      })
    );

    const meta = dataOf(
      (await client.callTool({
        name: "distill_journal_append",
        arguments: {
          run_id: RUN_ID,
          entry: {
            type: "run_meta",
            window: {
              from: "2026-07-14T03:00:00.000Z",
              to: "2026-07-15T03:00:00.000Z",
              includesMesh: true,
            },
            gate: { active: true, eventCount: 42 },
            cursor_before: "2026-07-14T03:00:00.000Z",
            distiller_actor: "test-actor (00000000)",
          },
        },
      })) as CallToolResult
    ) as { seq: number; relJournalPath: string };
    expect(meta.seq).toBe(0);
    expect(meta.relJournalPath).toBe("journal/2026-07-15.jsonl");

    await client.callTool({
      name: "distill_journal_append",
      arguments: {
        run_id: RUN_ID,
        entry: {
          type: "decision",
          theme: "Example distilled theme",
          disposition: "distilled",
          sources: [{ kind: "github_pr", ref: "o/r#1", title: "Example PR" }],
          node_ops: [
            {
              op: "update_contents",
              node_id: "N1",
              node_title: "Example Node",
              mode: "append",
              summary: "Appended a section",
            },
          ],
          conclusion: "Recorded the example landing.",
          confidence: "high",
          confidence_reason: "Explicit ruling.",
        },
      },
    });

    await client.callTool({
      name: "distill_journal_append",
      arguments: {
        run_id: RUN_ID,
        entry: {
          type: "decision",
          theme: "A transient thing",
          disposition: "adjudicated_away",
          conclusion: "Seen but not graph-worthy.",
          skip_reason: "Transient / undecided.",
        },
      },
    });

    await client.callTool({
      name: "distill_journal_append",
      arguments: {
        run_id: RUN_ID,
        entry: {
          type: "run_summary",
          cursor_after: "2026-07-15T03:00:00.000Z",
          advanced: true,
          gap: null,
          counts: {
            decisions: 2,
            distilled: 1,
            adjudicated_away: 1,
            skipped: 0,
            deferred: 0,
            nodes_touched: 1,
            iu_hints: 0,
          },
          sync: { unsyncedCount: 0, consecutiveFailures: 0 },
        },
      },
    });

    const render = dataOf(
      (await client.callTool({
        name: "distill_report_render",
        arguments: { run_id: RUN_ID },
      })) as CallToolResult
    ) as { relReportPath: string; status: string; runsInIndex: number };
    expect(render.relReportPath).toBe("rendered/2026-07-15.md");
    expect(render.status).toBe("complete");
    expect(render.runsInIndex).toBe(1);

    // index.json matches exactly what the consumer (iu-reports-api.ts) reads.
    const index = JSON.parse(readFileSync(paths.indexPath, "utf-8"));
    expect(index.v).toBe(1);
    expect(index.runs).toHaveLength(1);
    expect(index.runs[0].run_id).toBe(RUN_ID);
    expect(index.runs[0].reportPath).toBe("rendered/2026-07-15.md");

    const md = readFileSync(paths.renderedPath("2026-07-15"), "utf-8");
    expect(md).toContain("# IU Distill — 2026-07-15");
    expect(md).toContain("## What the IU learned");
    expect(md).toContain("Example distilled theme");
    expect(md).toContain("## Deliberately left out");
    expect(md).toContain("A transient thing");

    // Re-rendering the same run upserts (does not duplicate) its index entry.
    const rerun = dataOf(
      (await client.callTool({
        name: "distill_report_render",
        arguments: { run_id: RUN_ID },
      })) as CallToolResult
    ) as { runsInIndex: number };
    expect(rerun.runsInIndex).toBe(1);
  });
});
