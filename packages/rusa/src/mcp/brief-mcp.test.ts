import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { assemblePortableContextV2 } from "../actor/portable-context.js";
import {
  PORTABLE_CONTEXT_BRIEF_MAX_BYTES,
  seedPortableBriefState,
} from "../actor/portable-context-brief.js";
import {
  emptyPortableContextState,
  InMemoryPortableContextStore,
} from "../actor/portable-context-state.js";
import { createBriefMcpServer } from "./brief-mcp.js";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function dataOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0];
  const text = first && first.type === "text" ? first.text : "";
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

describe("brief-mcp", () => {
  it("bound identity to caller actor: reads and updates own brief only", async () => {
    const store = new InMemoryPortableContextStore();
    const actorA = "actor-alpha";
    const actorB = "actor-beta";

    store.save(
      seedPortableBriefState(
        emptyPortableContextState(actorA),
        actorA,
        null,
        "2026-10-10T12:00:00Z"
      )
    );
    store.save(
      seedPortableBriefState(
        emptyPortableContextState(actorB),
        actorB,
        null,
        "2026-10-10T12:00:00Z"
      )
    );

    const clientA = await connect(
      createBriefMcpServer({
        actorId: actorA,
        store,
        charter: () => "Charter for Actor Alpha",
        now: () => "2026-10-10T12:05:00Z",
      })
    );
    const clientB = await connect(
      createBriefMcpServer({
        actorId: actorB,
        store,
        charter: () => "Charter for Actor Beta",
        now: () => "2026-10-10T12:05:00Z",
      })
    );

    const readA = (await clientA.callTool({
      name: "read",
      arguments: {},
    })) as CallToolResult;
    expect(readA.isError).toBeFalsy();
    const dataA = dataOf(readA);
    expect(dataA.charter).toBe("Charter for Actor Alpha");
    expect(typeof dataA.text === "string" && dataA.text).toContain(`mesh:actors/${actorA}/charter`);

    // Actor A updates its brief
    const candidateA =
      `## WHAT\n` +
      `Focus on primary mission. [mesh:actors/${actorA}/charter]\n\n` +
      `## HOW\n` +
      `Test changes thoroughly. [mesh:messages/msg-1]\n\n` +
      `## DOMAIN\n`;
    const updateA = (await clientA.callTool({
      name: "replace",
      arguments: {
        text: candidateA,
        explanation: "Distilled core operational principles",
      },
    })) as CallToolResult;
    expect(updateA.isError).toBeFalsy();
    const updateDataA = dataOf(updateA);
    expect(updateDataA.status).toBe("updated");
    expect(updateDataA.generation).toBe(1);

    // Verify Actor B is completely untouched
    const readB = (await clientB.callTool({
      name: "read",
      arguments: {},
    })) as CallToolResult;
    const dataB = dataOf(readB);
    expect(dataB.generation).toBe(0);
    expect(dataB.charter).toBe("Charter for Actor Beta");
    expect(typeof dataB.text === "string" && dataB.text).not.toContain("Focus on primary mission");
  });

  it("atomic last-good on rejected write: invalid candidate leaves existing brief untouched", async () => {
    const store = new InMemoryPortableContextStore();
    const actorId = "actor-strict";
    const initialTime = "2026-10-10T12:00:00Z";
    store.save(
      seedPortableBriefState(emptyPortableContextState(actorId), actorId, null, initialTime)
    );

    const client = await connect(
      createBriefMcpServer({
        actorId,
        store,
        charter: () => "Strict Charter",
        now: () => "2026-10-10T12:10:00Z",
      })
    );

    const originalBrief = store.load(actorId).brief;
    expect(originalBrief).toBeDefined();

    // 1. Missing required sections
    const badSections = "## WHAT\nSome line [mesh:messages/1]\n";
    const res1 = (await client.callTool({
      name: "replace",
      arguments: { text: badSections },
    })) as CallToolResult;
    expect(res1.isError).toBe(true);
    expect(textOf(res1)).toContain("missing section HOW");
    expect(store.load(actorId).brief).toEqual(originalBrief);

    // 2. Prohibited transient state (gate tally / operational tracking)
    const badState =
      `## WHAT\n` +
      `Gate 2/2 reached for current PR. [mesh:messages/msg-ci]\n\n` +
      `## HOW\n\n` +
      `## DOMAIN\n`;
    const res2 = (await client.callTool({
      name: "replace",
      arguments: { text: badState },
    })) as CallToolResult;
    expect(res2.isError).toBe(true);
    expect(textOf(res2)).toContain("names a gate tally");
    expect(store.load(actorId).brief).toEqual(originalBrief);

    // 3. WHAT line missing citation
    const missingCitation =
      `## WHAT\n` + `An uncited instruction statement.\n\n` + `## HOW\n\n` + `## DOMAIN\n`;
    const res3 = (await client.callTool({
      name: "replace",
      arguments: { text: missingCitation },
    })) as CallToolResult;
    expect(res3.isError).toBe(true);
    expect(textOf(res3)).toContain("has no structured citation");
    expect(store.load(actorId).brief).toEqual(originalBrief);
  });

  it("enforces 16KB size cap", async () => {
    const store = new InMemoryPortableContextStore();
    const actorId = "actor-size";
    store.save(
      seedPortableBriefState(
        emptyPortableContextState(actorId),
        actorId,
        null,
        "2026-10-10T12:00:00Z"
      )
    );

    const client = await connect(
      createBriefMcpServer({
        actorId,
        store,
        charter: () => "Size charter",
      })
    );

    const padding = "A".repeat(PORTABLE_CONTEXT_BRIEF_MAX_BYTES);
    const oversized =
      `## WHAT\n` +
      `Large statement ${padding} [mesh:actors/${actorId}/charter]\n\n` +
      `## HOW\n\n` +
      `## DOMAIN\n`;

    const res = (await client.callTool({
      name: "replace",
      arguments: { text: oversized },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("over the 16384-byte cap");
  });

  it("no-op write leaves generation, timestamp and revisions untouched", async () => {
    const store = new InMemoryPortableContextStore();
    const actorId = "actor-noop";
    const initialTime = "2026-10-10T12:00:00Z";
    store.save(
      seedPortableBriefState(emptyPortableContextState(actorId), actorId, null, initialTime)
    );

    const client = await connect(
      createBriefMcpServer({
        actorId,
        store,
        charter: () => "Noop charter",
        now: () => "2026-10-10T12:30:00Z",
      })
    );

    const currentText = store.load(actorId).brief?.text ?? "";
    const res = (await client.callTool({
      name: "replace",
      arguments: { text: currentText },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    const data = dataOf(res);
    expect(data.status).toBe("unchanged");
    expect(data.generation).toBe(0);
    expect(data.updatedAt).toBe(initialTime);

    const afterBrief = store.load(actorId).brief;
    expect(afterBrief).toBeDefined();
    expect(afterBrief?.generation).toBe(0);
    expect(afterBrief?.updatedAt).toBe(initialTime);
    expect(afterBrief?.revisions ?? []).toHaveLength(0);
  });

  it("consolidation and citation rotation succeeds", async () => {
    const store = new InMemoryPortableContextStore();
    const actorId = "actor-consolidate";
    store.save(
      seedPortableBriefState(
        emptyPortableContextState(actorId),
        actorId,
        null,
        "2026-10-10T12:00:00Z"
      )
    );

    const client = await connect(
      createBriefMcpServer({
        actorId,
        store,
        charter: () => "Consolidation charter",
        now: () => "2026-10-10T12:15:00Z",
      })
    );

    // Write initial two principles with separate citations
    const step1 =
      `## WHAT\n` +
      `Verify tests on Linux. [mesh:messages/m1]\n` +
      `Verify tests on Darwin. [mesh:messages/m2]\n\n` +
      `## HOW\n` +
      `Run test runner with filter. [mesh:messages/m3]\n\n` +
      `## DOMAIN\n`;
    const res1 = (await client.callTool({
      name: "replace",
      arguments: {
        text: step1,
        explanation: "Initial multi-platform instructions",
      },
    })) as CallToolResult;
    expect(res1.isError).toBeFalsy();
    expect(store.load(actorId).brief?.generation).toBe(1);

    // Consolidate both Linux and Darwin into single principle, rotating citations
    const step2 =
      `## WHAT\n` +
      `Verify tests across all supported operating systems. [mesh:messages/m2] [mesh:actors/${actorId}/charter]\n\n` +
      `## HOW\n` +
      `Run test runner with filter. [mesh:messages/m3]\n\n` +
      `## DOMAIN\n`;
    const res2 = (await client.callTool({
      name: "replace",
      arguments: {
        text: step2,
        explanation: "Consolidated platform testing into general principle",
      },
    })) as CallToolResult;
    expect(res2.isError).toBeFalsy();
    const data2 = dataOf(res2);
    expect(data2.status).toBe("updated");
    expect(data2.generation).toBe(2);

    const loaded = store.load(actorId).brief;
    expect(loaded).toBeDefined();
    expect(loaded?.generation).toBe(2);
    expect(loaded?.revisions).toHaveLength(2);
    expect(loaded?.revisions?.[0]?.explanation).toBe("Initial multi-platform instructions");
    expect(loaded?.revisions?.[1]?.explanation).toBe(
      "Consolidated platform testing into general principle"
    );
  });

  it("persists and renders into prompt assembly with generation and cursor", async () => {
    const store = new InMemoryPortableContextStore();
    const actorId = "actor-prompt";
    const initialTime = "2026-10-10T12:00:00Z";
    store.save(
      seedPortableBriefState(emptyPortableContextState(actorId), actorId, null, initialTime)
    );

    const client = await connect(
      createBriefMcpServer({
        actorId,
        store,
        charter: () => "Prompt Charter",
        now: () => "2026-10-10T12:20:00Z",
      })
    );

    const newBrief =
      `## WHAT\n` +
      `Keep prompt assembly clean and verified. [mesh:actors/${actorId}/charter]\n\n` +
      `## HOW\n` +
      `Use assemblePortableContextV2. [mesh:messages/m-render]\n\n` +
      `## DOMAIN\n` +
      `Prompt context. [mesh:messages/m-render]\n`;

    await client.callTool({
      name: "replace",
      arguments: { text: newBrief, explanation: "Render test" },
    });

    const state = store.load(actorId);
    const prompt = assemblePortableContextV2({
      state,
      messages: [],
      runs: [],
      brief: state.brief,
    });

    expect(prompt).not.toBeNull();
    expect(prompt?.section).toContain(
      "### Durable brief (mode: brief, generation 1, cursor start)"
    );
    expect(prompt?.section).toContain(
      "Keep prompt assembly clean and verified. [mesh:actors/actor-prompt/charter]"
    );
    expect(prompt?.section).toContain("Use assemblePortableContextV2. [mesh:messages/m-render]");
  });

  it("charter governs action: charter changes authorize work without brief rewrite", async () => {
    let currentCharter = "Charter v1: Read-only operations.";
    const store = new InMemoryPortableContextStore();
    const actorId = "actor-charter";
    store.save(
      seedPortableBriefState(
        emptyPortableContextState(actorId),
        actorId,
        null,
        "2026-10-10T12:00:00Z"
      )
    );

    const client = await connect(
      createBriefMcpServer({
        actorId,
        store,
        charter: () => currentCharter,
      })
    );

    const read1 = (await client.callTool({
      name: "read",
      arguments: {},
    })) as CallToolResult;
    expect(dataOf(read1).charter).toBe("Charter v1: Read-only operations.");

    // Parent updates charter to v2 (authorizing write operations)
    currentCharter = "Charter v2: Read and write operations authorized.";

    // Actor reads updated charter immediately; brief does NOT need to be rewritten
    const read2 = (await client.callTool({
      name: "read",
      arguments: {},
    })) as CallToolResult;
    const data2 = dataOf(read2);
    expect(data2.charter).toBe("Charter v2: Read and write operations authorized.");
    expect(data2.generation).toBe(0); // Brief generation unchanged!
  });
});
