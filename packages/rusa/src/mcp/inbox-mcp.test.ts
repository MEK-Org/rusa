import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { inboxMcpStore } from "../db/fixtures/obligation-store.js";
import { runMigrations } from "../db/migrations/runner.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import type { Obligation } from "../obligations/obligation.js";
import { createInboxMcpServer, type InboxMcpRunScope } from "./inbox-mcp.js";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function dataOf(result: CallToolResult): unknown {
  const first = result.content[0];
  const value = first?.type === "text" ? first.text : "";
  return JSON.parse(value);
}

describe("inbox MCP server", () => {
  let store: SqliteInboxRepository;
  let db: Database.Database;
  const server = (actorId: string, scope?: InboxMcpRunScope) =>
    createInboxMcpServer(inboxMcpStore(db, store), actorId, scope);

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    store = new SqliteInboxRepository(db, () => new Date("2026-07-13T12:00:00Z"));
    store.append([
      { id: "own", actorId: "actor-a", source: "chat", payload: { type: "message.created" } },
      { id: "foreign", actorId: "actor-b", source: "chat", payload: { type: "message.created" } },
    ]);
  });

  it("exposes list, select, read, and mark_handled", async () => {
    const client = await connect(server("actor-a"));
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "list",
      "mark_handled",
      "read",
      "select",
    ]);
  });

  it("bakes actor identity into list/read and hides foreign ids as not found", async () => {
    const client = await connect(server("actor-a"));
    const listed = (await client.callTool({ name: "list", arguments: {} })) as CallToolResult;
    expect((dataOf(listed) as { entries: Array<{ id: string }> }).entries.map((e) => e.id)).toEqual(
      ["own"]
    );
    const foreign = (await client.callTool({
      name: "read",
      arguments: { entry_id: "foreign" },
    })) as CallToolResult;
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]).toMatchObject({ type: "text", text: "inbox entry not found" });
  });

  it("accepts exactly one singular-or-batch form and marks a valid batch atomically", async () => {
    store.append([
      { id: "own-2", actorId: "actor-a", source: "chat", payload: { type: "message.created" } },
    ]);
    const client = await connect(server("actor-a"));
    const invalid = (await client.callTool({
      name: "mark_handled",
      arguments: { entry_id: "own", entry_ids: ["own-2"], note: "handled in test" },
    })) as CallToolResult;
    expect(invalid.isError).toBe(true);
    expect(store.countUnhandled("actor-a")).toBe(2);

    const valid = (await client.callTool({
      name: "select",
      arguments: { entry_ids: ["own", "own-2"] },
    })) as CallToolResult;
    expect(valid.isError).not.toBe(true);

    const handled = (await client.callTool({
      name: "mark_handled",
      arguments: { entry_ids: ["own", "own-2"], note: "  merged PR ISSUE_NUM  " },
    })) as CallToolResult;
    expect(handled.isError).not.toBe(true);
    expect(store.countUnhandled("actor-a")).toBe(0);
    // The note is required, trimmed, and persisted per entry.
    expect(store.read("actor-a", "own")?.handledNote).toBe("merged PR ISSUE_NUM");
    expect(store.read("actor-a", "own-2")?.handledNote).toBe("merged PR ISSUE_NUM");
  });

  it("requires a non-empty note and rejects missing or blank ones", async () => {
    const client = await connect(server("actor-a"));
    await client.callTool({ name: "select", arguments: { entry_ids: ["own"] } });

    const missing = (await client.callTool({
      name: "mark_handled",
      arguments: { entry_ids: ["own"] },
    })) as CallToolResult;
    expect(missing.isError).toBe(true);
    expect((missing.content[0] as { text: string }).text).toContain("requires a `note`");

    const blank = (await client.callTool({
      name: "mark_handled",
      arguments: { entry_ids: ["own"], note: "   " },
    })) as CallToolResult;
    expect(blank.isError).toBe(true);
    expect((blank.content[0] as { text: string }).text).toContain("cannot be empty");

    // A rejected note leaves the entry unhandled.
    expect(store.countUnhandled("actor-a")).toBe(1);
  });

  it("surfaces source-specific hints on selected entries", async () => {
    store.append([
      {
        id: "human-msg",
        actorId: "actor-a",
        source: "mesh:00000000-0000-4000-8000-000000000001",
        payload: { type: "mesh.message", fromId: "00000000-0000-4000-8000-000000000001" },
      },
      {
        id: "gchat-reply-msg",
        actorId: "actor-a",
        source: "chat_space:spaces/AAA",
        payload: {
          type: "gchat.message",
          spaceName: "spaces/AAA",
          threadName: "spaces/AAA/threads/BBB",
          messageName: "spaces/AAA/messages/CCC",
        },
      },
      {
        id: "gchat-head-msg",
        actorId: "actor-a",
        source: "chat_space:spaces/AAA",
        payload: {
          type: "gchat.message",
          spaceName: "spaces/AAA",
          threadName: "spaces/AAA/threads/BBB",
          messageName: "spaces/AAA/messages/BBB.BBB",
        },
      },
    ]);
    const client = await connect(server("actor-a"));
    const result = (await client.callTool({
      name: "select",
      arguments: { entry_ids: ["human-msg", "gchat-reply-msg", "gchat-head-msg", "own"] },
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);

    const data = dataOf(result) as {
      entries: Array<{ id: string; hint?: string }>;
    };
    expect(data.entries).toHaveLength(4);

    const humanEntry = data.entries.find((e) => e.id === "human-msg");
    expect(humanEntry?.hint).toContain("send_message");
    expect(humanEntry?.hint).toContain("fromId");

    const gchatReplyEntry = data.entries.find((e) => e.id === "gchat-reply-msg");
    expect(gchatReplyEntry?.hint).toContain("in thread 'spaces/AAA/threads/BBB'");

    const gchatHeadEntry = data.entries.find((e) => e.id === "gchat-head-msg");
    expect(gchatHeadEntry?.hint).toContain("top-level in 'spaces/AAA' (not in a thread)");

    const ownEntry = data.entries.find((e) => e.id === "own");
    expect(ownEntry?.hint).toBeUndefined();
  });

  it("holds normal work during a leased voice session while leaving voice responsive", async () => {
    let voiceActive = false;
    let selected: string[] = [];
    store.append([
      {
        id: "voice",
        actorId: "actor-a",
        source: "mesh:00000000-0000-4000-8000-000000000001",
        payload: {
          type: "human.voice",
          priority: "responsive",
          fromId: "00000000-0000-4000-8000-000000000001",
        },
      },
    ]);
    const client = await connect(
      server("actor-a", {
        select: (ids) => {
          if (
            voiceActive &&
            ids.some((id) => store.read("actor-a", id)?.payload.priority !== "responsive")
          ) {
            throw new Error("ordinary inbox work is held while a voice session is active");
          }
          selected = ids;
          return ids.map((id) => {
            const entry = store.read("actor-a", id);
            if (!entry) throw new Error("missing test entry");
            return entry;
          });
        },
        selected: () => selected,
        isVoiceSessionActive: () => voiceActive,
      })
    );

    // Authority blocks starting ordinary work, but cannot make already-complete
    // work appear unfinished when it crosses the boundary.
    await client.callTool({ name: "select", arguments: { entry_ids: ["own"] } });
    voiceActive = true;

    const listed = (await client.callTool({ name: "list", arguments: {} })) as CallToolResult;
    expect(
      (dataOf(listed) as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id)
    ).toEqual(["voice"]);

    const selectedNormal = (await client.callTool({
      name: "select",
      arguments: { entry_ids: ["own"] },
    })) as CallToolResult;
    expect(selectedNormal.isError).toBe(true);

    const markedNormal = (await client.callTool({
      name: "mark_handled",
      arguments: { entry_ids: ["own"], note: "completed before voice session" },
    })) as CallToolResult;
    expect(markedNormal.isError).not.toBe(true);
    expect(store.read("actor-a", "own")?.handledAt).not.toBeNull();

    const selectedVoice = (await client.callTool({
      name: "select",
      arguments: { entry_ids: ["voice"] },
    })) as CallToolResult;
    expect(selectedVoice.isError).not.toBe(true);
  });

  it("passes an explicit obligation to the run scope and returns resolved focus", async () => {
    let selectedObligation: string | undefined;
    const client = await connect(
      server("actor-a", {
        select: (entryIds, obligationId) => {
          selectedObligation = obligationId;
          return {
            entries: entryIds.map((id) => {
              const entry = store.read("actor-a", id);
              if (!entry) throw new Error("missing test entry");
              return entry;
            }),
            focus: {
              primaryObligationId: obligationId ?? null,
              resolution: "explicit",
              related: true,
              diagnostics: [],
              context: null,
            },
          };
        },
        selected: () => ["own"],
      })
    );

    const result = (await client.callTool({
      name: "select",
      arguments: { entry_ids: ["own"], obligation_id: "ob-1" },
    })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(selectedObligation).toBe("ob-1");
    expect(dataOf(result)).toMatchObject({
      entries: [{ id: "own" }],
      focus: {
        primaryObligationId: "ob-1",
        resolution: "explicit",
        related: true,
      },
    });
  });

  it("returns chat context alongside the reply hint when the run scope supplies chat sources", async () => {
    store.append([
      {
        id: "peer-msg",
        actorId: "actor-a",
        source: "mesh:peer",
        payload: { type: "mesh.message", messageId: "m2", fromId: "peer" },
      },
    ]);
    const readEntries = (ids: string[]) =>
      ids.map((id) => {
        const entry = store.read("actor-a", id);
        if (!entry) throw new Error("missing test entry");
        return entry;
      });
    const client = await connect(
      server("actor-a", {
        select: readEntries,
        selected: () => ["peer-msg", "own"],
        chatContext: {
          meshChat: {
            listForActor: () => [
              {
                id: "m2",
                ts: "t2",
                senderId: "peer",
                recipientId: "actor-a",
                body: "which PR?",
                sessionId: null,
                responsive: null,
              },
              {
                id: "m1",
                ts: "t1",
                senderId: "actor-a",
                recipientId: "peer",
                body: "PR #643 is up",
                sessionId: null,
                responsive: null,
              },
            ],
          },
        },
      })
    );

    const result = (await client.callTool({
      name: "select",
      arguments: { entry_ids: ["peer-msg", "own"] },
    })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    const entries = (dataOf(result) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries[0]).toMatchObject({
      id: "peer-msg",
      chatContext: {
        source: "mesh",
        scope: "conversation",
        messages: [
          { messageId: "m1", sender: "actor-a", text: "PR #643 is up" },
          { messageId: "m2", sender: "peer", text: "which PR?", selected: true },
        ],
      },
    });
    expect(entries[1]).not.toHaveProperty("chatContext");
  });

  it("returns a human sender's open questions on selection when the run scope supplies them", async () => {
    store.append([
      {
        id: "human-msg",
        actorId: "actor-a",
        source: "mesh:user-1",
        payload: { type: "mesh.message", messageId: "m9", fromId: "user-1" },
      },
    ]);
    const readEntries = (ids: string[]) =>
      ids.map((id) => {
        const entry = store.read("actor-a", id);
        if (!entry) throw new Error("missing test entry");
        return entry;
      });
    const client = await connect(
      server("actor-a", {
        select: readEntries,
        selected: () => ["human-msg", "own"],
        openQuestions: {
          resolveSenderPrincipal: (entry) =>
            entry.payload.fromId === "user-1" ? "user-1" : undefined,
          listOpenQuestions: (ownerId, creatorId) => ({
            obligations:
              ownerId === "user-1" && creatorId === "actor-a"
                ? [{ id: "ob-q", title: "Which region?" } as Obligation]
                : [],
            total: 1,
            hasMore: false,
          }),
          listArtifacts: () => [],
        },
      })
    );

    const result = (await client.callTool({
      name: "select",
      arguments: { entry_ids: ["human-msg", "own"] },
    })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    const entries = (dataOf(result) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries[0]).toMatchObject({
      id: "human-msg",
      openQuestions: {
        principalId: "user-1",
        resolutionRef: "mesh:messages/m9",
        questions: [{ id: "ob-q", title: "Which region?" }],
        total: 1,
        truncated: false,
      },
    });
    expect(entries[1]).not.toHaveProperty("openQuestions");
  });

  describe("mark_handled through the writer (#1289)", () => {
    const readEntry = (id: string) => {
      const entry = store.read("actor-a", id);
      if (!entry) throw new Error("missing test entry");
      return entry;
    };

    it("commits before anything queued while its closure question is asked runs", async () => {
      // The question is asked as the write is submitted, and the in-process
      // writer commits inside the call, so a microtask queued while asking is
      // the first thing that could run after it. An await between the
      // question and the write would let the microtask see the entry unhandled.
      let seenAfterQuestion: unknown = "not run";
      const client = await connect(
        server("actor-a", {
          select: (ids) => ids.map(readEntry),
          selected: () => ["own"],
          closureFor: () => {
            queueMicrotask(() => {
              seenAfterQuestion = store.read("actor-a", "own")?.handledAt ?? null;
            });
            return null;
          },
        })
      );

      const result = (await client.callTool({
        name: "mark_handled",
        arguments: { entry_id: "own", note: "done" },
      })) as CallToolResult;

      expect(result.isError).not.toBe(true);
      expect(seenAfterQuestion).toBeTruthy();
    });

    it("returns closure's refusal and leaves the entry unhandled", async () => {
      new ObligationRepository(db).create({ id: "head", ownerId: "actor-a", title: "Head" });
      let handled = 0;
      const client = await connect(
        server("actor-a", {
          select: (ids) => ids.map(readEntry),
          selected: () => ["own"],
          onHandled: () => handled++,
          closureFor: () => ({
            actorId: "actor-a",
            heads: ["head"],
            baseline: {
              selectedHeads: new Map([
                [
                  "head",
                  { ownerId: "actor-a", checkpoint: null, checkpointAt: null, checkpointBy: null },
                ],
              ]),
              preExistingChildIds: new Map(),
              preExistingPrerequisiteIds: new Map(),
            },
            rootId: null,
            retiring: new Set(),
          }),
        })
      );

      const result = (await client.callTool({
        name: "mark_handled",
        arguments: { entry_id: "own", note: "not yet" },
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        'Cannot mark handled: selected head obligation head (\\"Head\\") was not finished or decomposed. Reason: obligation is still ready.'
      );
      expect(store.read("actor-a", "own")?.handledAt).toBeNull();
      expect(handled).toBe(0);
    });
  });
});
