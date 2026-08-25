import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { actorInbox } from "../db/migrations/0003_actor_inbox.js";
import { actorInboxSeen } from "../db/migrations/0012_actor_inbox_seen.js";
import { actorInboxHandledNote } from "../db/migrations/0015_actor_inbox_handled_note.js";
import { InboxRepository } from "../db/repositories/inbox-repository.js";
import { createInboxMcpServer } from "./inbox-mcp.js";

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
  let store: InboxRepository;

  beforeEach(() => {
    const db = new Database(":memory:");
    actorInbox.up(db);
    actorInboxSeen.up(db);
    actorInboxHandledNote.up(db);
    store = new InboxRepository(db, () => new Date("2026-07-13T12:00:00Z"));
    store.append([
      { id: "own", actorId: "actor-a", source: "chat", payload: { type: "message.created" } },
      { id: "foreign", actorId: "actor-b", source: "chat", payload: { type: "message.created" } },
    ]);
  });

  it("exposes list, select, read, and mark_handled", async () => {
    const client = await connect(createInboxMcpServer(store, "actor-a"));
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "list",
      "mark_handled",
      "read",
      "select",
    ]);
  });

  it("bakes actor identity into list/read and hides foreign ids as not found", async () => {
    const client = await connect(createInboxMcpServer(store, "actor-a"));
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
    const client = await connect(createInboxMcpServer(store, "actor-a"));
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
    const client = await connect(createInboxMcpServer(store, "actor-a"));
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
        source: "mesh:human:operator",
        payload: { type: "human.message", fromId: "human:operator" },
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
    const client = await connect(createInboxMcpServer(store, "actor-a"));
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
    expect(humanEntry?.hint).toContain("human operator");
    expect(humanEntry?.hint).toContain("reply tool");

    const gchatReplyEntry = data.entries.find((e) => e.id === "gchat-reply-msg");
    expect(gchatReplyEntry?.hint).toContain("in thread 'spaces/AAA/threads/BBB'");

    const gchatHeadEntry = data.entries.find((e) => e.id === "gchat-head-msg");
    expect(gchatHeadEntry?.hint).toContain("top-level in 'spaces/AAA' (not in a thread)");

    const ownEntry = data.entries.find((e) => e.id === "own");
    expect(ownEntry?.hint).toBeUndefined();
  });
});
