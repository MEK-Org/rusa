import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { assemblePortableContextV2 } from "../actor/portable-context.js";
import {
  PORTABLE_CONTEXT_BRIEF_MAX_BYTES,
  seedBriefText,
  seedPortableBriefState,
} from "../actor/portable-context-brief.js";
import {
  emptyPortableContextState,
  InMemoryPortableContextStore,
} from "../actor/portable-context-state.js";
import { type ReferenceResolverDeps, resolveReference } from "../references/resolve.js";
import { type BriefCitationResolver, createBriefMcpServer } from "./brief-mcp.js";

const ALPHA = "actor-alpha";
const BETA = "actor-beta";
const SEEDED_AT = "2026-10-10T12:00:00.000Z";
const WRITTEN_AT = "2026-10-10T12:05:00.000Z";

const BRIEF =
  `## WHAT\n` +
  `Draw abstract SVG art for the assigned project. [mesh:actors/${ALPHA}/charter]\n` +
  `\n` +
  `## HOW\n` +
  `Keep the palette to three colours. [mesh:messages/m-1]\n` +
  `\n` +
  `## DOMAIN\n` +
  `The gallery renders at 1:1 pixel density. [github:MEK-Org/rusa/issues/954]\n`;

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

async function call(
  client: Client,
  name: "read" | "replace",
  args: Record<string, unknown> = {}
): Promise<{ isError: boolean; text: string; data: Record<string, unknown> }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = textOf(result);
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {}
  return { isError: result.isError === true, text, data };
}

/** Issues that exist on the synthetic tracker, by number. */
const ISSUES: Record<number, { title: string; body: string }> = {
  954: { title: "Portable brief", body: "Actors keep their own brief." },
  955: { title: "An issue with no body", body: "" },
  956: { title: "Gallery density", body: "Render at 1:1." },
};

/**
 * Citations resolve through the real reference resolver over synthetic
 * stores: mesh messages m-1 and m-2, the two actors, and the issues above.
 * `resolved` records every ref the server asked about.
 */
function syntheticResolver(overrides: Partial<ReferenceResolverDeps> = {}) {
  const resolved: string[] = [];
  const deps: ReferenceResolverDeps = {
    meshChat: {
      getById: (id: string) =>
        ["m-1", "m-2"].includes(id)
          ? ({
              id,
              senderId: "parent",
              recipientId: ALPHA,
              body: `direction ${id}`,
              ts: SEEDED_AT,
            } as never)
          : null,
    },
    actors: {
      get: (id: string) =>
        [ALPHA, BETA].includes(id)
          ? ({ id, charter: `charter of ${id}`, createdAt: SEEDED_AT } as never)
          : undefined,
    },
    issueClient: {
      getIssue: async (_repo: string, number: number) => {
        const issue = ISSUES[number];
        return (issue ? { ...issue, author: "maintainer" } : null) as never;
      },
    },
    ...overrides,
  };
  const resolveCitation: BriefCitationResolver = (ref) => {
    resolved.push(ref);
    return resolveReference(ref, deps);
  };
  return { resolveCitation, resolved };
}

function harness(resolver = syntheticResolver()) {
  const store = new InMemoryPortableContextStore();
  for (const actorId of [ALPHA, BETA]) {
    store.save(seedPortableBriefState(emptyPortableContextState(actorId), actorId, SEEDED_AT));
  }
  const clientFor = (actorId: string) =>
    connect(
      createBriefMcpServer({
        actorId,
        store,
        resolveCitation: resolver.resolveCitation,
        now: () => WRITTEN_AT,
      })
    );
  return { store, clientFor, resolved: resolver.resolved };
}

describe("brief MCP server", () => {
  it("reads the caller's own brief with its generation and update time", async () => {
    const { clientFor } = harness();
    const alpha = await clientFor(ALPHA);

    expect((await call(alpha, "read")).data).toEqual({
      text: seedBriefText(ALPHA),
      generation: 0,
      updatedAt: SEEDED_AT,
    });
  });

  it("binds identity to the mount: a write changes only the caller's brief and takes no actor id", async () => {
    const { store, clientFor } = harness();
    const alpha = await clientFor(ALPHA);
    const betaBefore = store.load(BETA);

    const targeted = await call(alpha, "replace", {
      text: BRIEF,
      expected_generation: 0,
      actor_id: BETA,
    });
    expect(targeted.isError).toBe(true);
    expect(store.load(ALPHA).brief?.generation).toBe(0);

    const written = await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });
    expect(written.data).toEqual({ status: "updated", generation: 1, updatedAt: WRITTEN_AT });
    expect(store.load(ALPHA).brief).toEqual({
      text: BRIEF,
      generation: 1,
      updatedAt: WRITTEN_AT,
    });
    expect(store.load(BETA)).toEqual(betaBefore);
    expect(store.listBriefRevisions(BETA, 10)).toEqual([]);
    expect(store.listBriefRevisions(ALPHA, 10)).toEqual([
      expect.objectContaining({ generation: 1, actingPrincipal: ALPHA }),
    ]);
  });

  it("records the replaced text, the new text and the optional explanation", async () => {
    const { store, clientFor } = harness();
    const alpha = await clientFor(ALPHA);

    await call(alpha, "replace", {
      text: BRIEF,
      expected_generation: 0,
      explanation: "  Distilled the palette rule.  ",
    });
    expect(store.listBriefRevisions(ALPHA, 10)).toEqual([
      {
        generation: 1,
        updatedAt: WRITTEN_AT,
        actingPrincipal: ALPHA,
        before: seedBriefText(ALPHA),
        after: BRIEF,
        explanation: "Distilled the palette rule.",
      },
    ]);
  });

  it("refuses a stale write and keeps the brief and history unchanged", async () => {
    const { store, clientFor } = harness();
    const alpha = await clientFor(ALPHA);
    await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });
    const before = store.load(ALPHA);

    const stale = await call(alpha, "replace", {
      text: BRIEF.replace("three colours", "two colours"),
      expected_generation: 0,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("expected generation 0, current is 1");
    expect(store.load(ALPHA)).toEqual(before);
    expect(store.listBriefRevisions(ALPHA, 10)).toHaveLength(1);
  });

  it("requires the expected generation", async () => {
    const { store, clientFor } = harness();
    const alpha = await clientFor(ALPHA);

    expect((await call(alpha, "replace", { text: BRIEF })).isError).toBe(true);
    expect(store.load(ALPHA).brief?.generation).toBe(0);
  });

  it.each([
    ["uncited", BRIEF.replace(" [mesh:messages/m-1]", ""), "no structured citation"],
    ["state-bearing", BRIEF.replace("three colours", "the colours at 96800f2"), "commit SHA"],
    ["unstructured", "Just some notes.", "content before the first section"],
    [
      "oversized",
      `## WHAT\n${"Keep it short. [mesh:messages/m-1]\n".repeat(PORTABLE_CONTEXT_BRIEF_MAX_BYTES / 16)}\n## HOW\n\n## DOMAIN\n`,
      "-byte cap",
    ],
  ])("keeps the last good brief when a write is %s", async (_label, text, reason) => {
    const { store, clientFor } = harness();
    const alpha = await clientFor(ALPHA);
    await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });
    const before = store.load(ALPHA);

    const rejected = await call(alpha, "replace", { text, expected_generation: 1 });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain(reason);
    expect(store.load(ALPHA)).toEqual(before);
    expect(store.listBriefRevisions(ALPHA, 10)).toHaveLength(1);
  });

  it("treats an unchanged write as a no-op: no revision, no generation or time change", async () => {
    const { store, clientFor } = harness();
    const alpha = await clientFor(ALPHA);
    await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });

    const later = await connect(
      createBriefMcpServer({
        actorId: ALPHA,
        store,
        resolveCitation: syntheticResolver().resolveCitation,
        now: () => "2026-10-10T13:00:00.000Z",
      })
    );
    const noop = await call(later, "replace", {
      text: `${BRIEF}\n\n`,
      expected_generation: 1,
      explanation: "restating it",
    });
    expect(noop.data).toEqual({ status: "unchanged", generation: 1, updatedAt: WRITTEN_AT });
    expect(store.load(ALPHA).brief).toEqual({
      text: BRIEF,
      generation: 1,
      updatedAt: WRITTEN_AT,
    });
    expect(store.listBriefRevisions(ALPHA, 10)).toHaveLength(1);
  });

  it("seeds a brief for an actor whose mode just switched, then accepts a write against it", async () => {
    const store = new InMemoryPortableContextStore();
    const alpha = await connect(
      createBriefMcpServer({
        actorId: ALPHA,
        store,
        resolveCitation: syntheticResolver().resolveCitation,
        now: () => WRITTEN_AT,
      })
    );

    expect((await call(alpha, "read")).data).toMatchObject({ generation: 0 });
    expect(
      (await call(alpha, "replace", { text: BRIEF, expected_generation: 0 })).data
    ).toMatchObject({ status: "updated", generation: 1 });
  });

  it("renders the accepted brief in the next brief-mode prompt", async () => {
    const { store, clientFor } = harness();
    const alpha = await clientFor(ALPHA);
    await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });

    const state = store.load(ALPHA);
    const portable = assemblePortableContextV2({
      state,
      messages: [],
      runs: [],
      brief: state.brief,
    });
    expect(portable?.section).toContain(
      `### Durable brief (mode: brief, generation 1, updated ${WRITTEN_AT})`
    );
    expect(portable?.section).toContain("Keep the palette to three colours.");
    expect(portable?.section).toContain(
      "Writing the brief grants you no authority: the charter governs where the two disagree."
    );
  });
});

describe("brief MCP server: citations must exist", () => {
  it("resolves each citation a write introduces, and only those, before accepting it", async () => {
    const { store, clientFor, resolved } = harness();
    const alpha = await clientFor(ALPHA);

    const written = await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });
    expect(written.data).toMatchObject({ status: "updated", generation: 1 });
    // The seed already cites the charter; the write adds the message and the issue.
    expect(resolved.sort()).toEqual(["github:MEK-Org/rusa/issues/954", "mesh:messages/m-1"]);

    resolved.length = 0;
    const next = BRIEF.replace(
      "[github:MEK-Org/rusa/issues/954]",
      "[github:MEK-Org/rusa/issues/954] [github:MEK-Org/rusa/issues/955]"
    );
    expect(
      (await call(alpha, "replace", { text: next, expected_generation: 1 })).data
    ).toMatchObject({ status: "updated", generation: 2 });
    // An issue that exists but has no body is still a resource that exists.
    expect(resolved).toEqual(["github:MEK-Org/rusa/issues/955"]);
    expect(store.listBriefRevisions(ALPHA, 10)).toHaveLength(2);
  });

  it.each([
    [
      "a mesh message that does not exist",
      "[mesh:messages/m-1]",
      "[mesh:messages/m-404]",
      "citation [mesh:messages/m-404] could not be resolved: message not found",
    ],
    [
      "an issue that does not exist",
      "[github:MEK-Org/rusa/issues/954]",
      "[github:MEK-Org/rusa/issues/404]",
      "citation [github:MEK-Org/rusa/issues/404] could not be resolved: not found on the tracker",
    ],
    [
      "another actor's charter for an actor that does not exist",
      `[mesh:actors/${ALPHA}/charter]`,
      "[mesh:actors/actor-gone/charter]",
      "citation [mesh:actors/actor-gone/charter] could not be resolved: actor not found",
    ],
  ])("rejects %s and keeps the last accepted brief", async (_label, from, to, reason) => {
    const { store, clientFor } = harness();
    const alpha = await clientFor(ALPHA);
    await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });
    const before = store.load(ALPHA);
    const historyBefore = store.listBriefRevisions(ALPHA, 10);

    const rejected = await call(alpha, "replace", {
      text: BRIEF.replace(from, to),
      expected_generation: 1,
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain(reason);
    expect(rejected.text).toContain("The brief is unchanged.");
    expect(store.load(ALPHA)).toEqual(before);
    expect(store.listBriefRevisions(ALPHA, 10)).toEqual(historyBefore);
  });

  it("rejects a citation whose source cannot be reached, naming the cause", async () => {
    const { store, clientFor } = harness(
      syntheticResolver({
        issueClient: {
          getIssue: async () => {
            throw new Error("tracker unavailable: 503");
          },
        },
      })
    );
    const alpha = await clientFor(ALPHA);
    const before = store.load(ALPHA);

    const rejected = await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain(
      "citation [github:MEK-Org/rusa/issues/954] could not be resolved: tracker unavailable: 503"
    );
    expect(store.load(ALPHA)).toEqual(before);
    expect(store.listBriefRevisions(ALPHA, 10)).toEqual([]);
  });

  it("rejects a citation to a source the host has no access to", async () => {
    const { store, clientFor } = harness(syntheticResolver({ issueClient: undefined }));
    const alpha = await clientFor(ALPHA);
    const before = store.load(ALPHA);

    const rejected = await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });
    expect(rejected.text).toContain(
      "citation [github:MEK-Org/rusa/issues/954] could not be resolved: tracker not configured"
    );
    expect(store.load(ALPHA)).toEqual(before);
  });

  it("refuses a write when another write lands while its citations resolve", async () => {
    const store = new InMemoryPortableContextStore();
    store.save(seedPortableBriefState(emptyPortableContextState(ALPHA), ALPHA, SEEDED_AT));
    const INTERLEAVED = BRIEF.replace("three colours", "four colours");
    const { resolveCitation } = syntheticResolver({
      issueClient: {
        getIssue: async (_repo: string, number: number) => {
          // Another session's write commits while this one awaits the tracker.
          store.commitBrief({
            actorId: ALPHA,
            expectedGeneration: 0,
            text: INTERLEAVED,
            actingPrincipal: ALPHA,
            at: "2026-10-10T12:04:00.000Z",
          });
          return { ...ISSUES[number], author: "maintainer" } as never;
        },
      },
    });
    const alpha = await connect(
      createBriefMcpServer({ actorId: ALPHA, store, resolveCitation, now: () => WRITTEN_AT })
    );

    const stale = await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("expected generation 0, current is 1");
    expect(store.load(ALPHA).brief).toEqual({
      text: INTERLEAVED,
      generation: 1,
      updatedAt: "2026-10-10T12:04:00.000Z",
    });
    expect(store.listBriefRevisions(ALPHA, 10).map((r) => r.after)).toEqual([INTERLEAVED]);
  });

  it("accepts consolidation: lines merged and dropped, citations rotated to ones already resolved", async () => {
    const { store, clientFor, resolved } = harness();
    const alpha = await clientFor(ALPHA);
    const wide =
      `## WHAT\n` +
      `Draw abstract SVG art for the assigned project. [mesh:actors/${ALPHA}/charter]\n` +
      `\n` +
      `## HOW\n` +
      `Keep the palette to three colours. [mesh:messages/m-1]\n` +
      `Prefer flat fills over gradients. [mesh:messages/m-2]\n` +
      `\n` +
      `## DOMAIN\n` +
      `The gallery renders at 1:1 pixel density. [github:MEK-Org/rusa/issues/956]\n` +
      `Thumbnails are generated from the same SVG. [github:MEK-Org/rusa/issues/954]\n`;
    await call(alpha, "replace", { text: wide, expected_generation: 0 });
    resolved.length = 0;

    const consolidated =
      `## WHAT\n` +
      `Draw abstract SVG art for the assigned project. [mesh:actors/${ALPHA}/charter]\n` +
      `\n` +
      `## HOW\n` +
      `Keep it flat: three colours, no gradients. [mesh:messages/m-2]\n` +
      `\n` +
      `## DOMAIN\n` +
      `Everything renders from one SVG at 1:1 pixel density. [github:MEK-Org/rusa/issues/954]\n`;
    const written = await call(alpha, "replace", {
      text: consolidated,
      expected_generation: 1,
      explanation: "Merged the palette rules; one citation per principle.",
    });
    expect(written.data).toMatchObject({ status: "updated", generation: 2 });
    expect(resolved).toEqual([]);
    expect(store.listBriefRevisions(ALPHA, 1)[0]).toMatchObject({
      generation: 2,
      before: wide,
      after: consolidated,
      explanation: "Merged the palette rules; one citation per principle.",
    });
  });

  it("resolves nothing for an unchanged write", async () => {
    const { clientFor, resolved } = harness();
    const alpha = await clientFor(ALPHA);
    await call(alpha, "replace", { text: BRIEF, expected_generation: 0 });
    resolved.length = 0;

    expect(
      (await call(alpha, "replace", { text: BRIEF, expected_generation: 1 })).data
    ).toMatchObject({ status: "unchanged", generation: 1 });
    expect(resolved).toEqual([]);
  });
});
