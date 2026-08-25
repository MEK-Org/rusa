import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { obligations } from "../db/migrations/0016_obligations.js";
import { obligationPriority } from "../db/migrations/0017_obligation_priority.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { createObligationsMcpServer } from "./obligations-mcp.js";

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

describe("obligations MCP", () => {
  let repository: ObligationRepository;

  beforeEach(() => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    obligations.up(db);
    obligationPriority.up(db);
    repository = new ObligationRepository(db);
  });

  it("exposes all 7 obligation tools", async () => {
    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "create_obligation",
      "get_obligation",
      "list_owned",
      "reassign_obligation",
      "reorder_obligation",
      "reparent_obligation",
      "set_obligation_status",
    ]);
  });

  it("creates a root obligation and child obligation via create_obligation", async () => {
    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const rootRes = (await client.callTool({
      name: "create_obligation",
      arguments: {
        owner_kind: "actor",
        owner_id: "actor-a",
        intent: "build feature",
      },
    })) as CallToolResult;
    expect(rootRes.isError).toBeFalsy();
    const rootData = dataOf(rootRes) as { obligation: { id: string; status: string } };
    expect(rootData.obligation.status).toBe("ready");

    const childRes = (await client.callTool({
      name: "create_obligation",
      arguments: {
        owner_kind: "actor",
        owner_id: "actor-b",
        parent_id: rootData.obligation.id,
        intent: "subtask",
      },
    })) as CallToolResult;
    expect(childRes.isError).toBeFalsy();
    const childData = dataOf(childRes) as { obligation: { id: string; status: string } };
    expect(childData.obligation.status).toBe("ready");

    // Root should now be waiting
    expect(repository.require(rootData.obligation.id).status).toBe("waiting");
  });

  it("transitions status via set_obligation_status and re-readies parent at retained priority", async () => {
    repository.create({
      id: "root-task",
      owner: { kind: "actor", id: "actor-a" },
      priority: 100,
    });
    repository.create({
      id: "child-task",
      parentId: "root-task",
      owner: { kind: "actor", id: "actor-a" },
    });
    expect(repository.require("root-task").status).toBe("waiting");

    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const doneRes = (await client.callTool({
      name: "set_obligation_status",
      arguments: { id: "child-task", status: "done" },
    })) as CallToolResult;
    expect(doneRes.isError).toBeFalsy();

    const rootAfter = repository.require("root-task");
    expect(rootAfter.status).toBe("ready");
    expect(rootAfter.priority).toBe(100); // Retained priority, NEVER head return!
  });

  it("reorders obligations via reorder_obligation", async () => {
    repository.create({ id: "first", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "second", owner: { kind: "actor", id: "actor-a" } });

    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const reorderRes = (await client.callTool({
      name: "reorder_obligation",
      arguments: {
        id: "second",
        previous_id: null,
        next_id: "first",
        scope: "subtree",
      },
    })) as CallToolResult;
    expect(reorderRes.isError).toBeFalsy();

    const list = repository.listOwned({ kind: "actor", id: "actor-a" }, { status: "ready" });
    expect(list.map((o) => o.id)).toEqual(["second", "first"]);
  });

  it("reparents an obligation via reparent_obligation", async () => {
    repository.create({ id: "p1", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "p2", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "c1", parentId: "p1", owner: { kind: "actor", id: "actor-a" } });

    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const reparentRes = (await client.callTool({
      name: "reparent_obligation",
      arguments: { id: "c1", parent_id: "p2" },
    })) as CallToolResult;
    expect(reparentRes.isError).toBeFalsy();
    expect(repository.require("c1").parentId).toBe("p2");
    expect(repository.require("p1").status).toBe("ready");
    expect(repository.require("p2").status).toBe("waiting");

    // Error on self-parent
    const selfRes = (await client.callTool({
      name: "reparent_obligation",
      arguments: { id: "c1", parent_id: "c1" },
    })) as CallToolResult;
    expect(selfRes.isError).toBe(true);
  });

  it("reassigns owned work and reports the previous owner", async () => {
    repository.create({ id: "task", owner: { kind: "actor", id: "actor-a" } });
    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const result = (await client.callTool({
      name: "reassign_obligation",
      arguments: { id: "task", owner_kind: "human", owner_id: "Operator" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(dataOf(result)).toMatchObject({
      obligation: { id: "task", owner: { kind: "human", id: "Operator" } },
      previousOwner: { kind: "actor", id: "actor-a" },
    });
  });

  it("rejects unauthorized reassignment and honors an injected ancestor policy", async () => {
    repository.create({ id: "foreign", owner: { kind: "actor", id: "actor-b" } });
    const denied = await connect(createObligationsMcpServer(repository, "actor-a"));
    const deniedResult = (await denied.callTool({
      name: "reassign_obligation",
      arguments: { id: "foreign", owner_kind: "actor", owner_id: "actor-c" },
    })) as CallToolResult;
    expect(deniedResult.isError).toBe(true);
    expect(repository.require("foreign").owner.id).toBe("actor-b");

    const authorized = await connect(
      createObligationsMcpServer(repository, "actor-a", { canReassign: () => true })
    );
    const authorizedResult = (await authorized.callTool({
      name: "reassign_obligation",
      arguments: { id: "foreign", owner_kind: "actor", owner_id: "actor-c" },
    })) as CallToolResult;
    expect(authorizedResult.isError).toBeFalsy();
    expect(repository.require("foreign").owner.id).toBe("actor-c");
  });

  it("binds list_owned to the actor and preserves ready queue order", async () => {
    repository.create({ id: "first", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "second", owner: { kind: "actor", id: "actor-a" } });
    repository.create({ id: "foreign", owner: { kind: "actor", id: "actor-b" } });
    repository.movePriorityInternal("second", null, "first");

    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const result = (await client.callTool({
      name: "list_owned",
      arguments: { status: "ready" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(dataOf(result)).toMatchObject({
      owner: { kind: "actor", id: "actor-a" },
      obligations: [{ id: "second" }, { id: "first" }],
      total: 2,
      truncated: false,
      nextCursor: null,
    });
  });

  it("explains a waiting obligation and names its cross-owner blocker in one read", async () => {
    repository.create({
      id: "parent",
      owner: { kind: "actor", id: "actor-a" },
      intent: "deliver the requested change",
    });
    repository.create({
      id: "blocker",
      parentId: "parent",
      owner: { kind: "actor", id: "actor-b" },
      intent: "review the artifact",
    });

    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const result = (await client.callTool({
      name: "get_obligation",
      arguments: { id: "parent" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(dataOf(result)).toMatchObject({
      obligation: { id: "parent", status: "waiting", owner: { kind: "actor", id: "actor-a" } },
      parent: null,
      children: {
        items: [{ id: "blocker", owner: { kind: "actor", id: "actor-b" } }],
        total: 1,
        truncated: false,
        nextCursor: null,
      },
      blockingChildren: {
        items: [
          {
            id: "blocker",
            status: "ready",
            owner: { kind: "actor", id: "actor-b" },
            intent: "review the artifact",
          },
        ],
        total: 1,
        truncated: false,
        nextCursor: null,
      },
    });
  });

  it("bounds owner queues and binds continuation cursors to actor and filter", async () => {
    for (const id of ["first", "second", "third"]) {
      repository.create({ id, owner: { kind: "actor", id: "actor-a" } });
    }
    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const first = (await client.callTool({
      name: "list_owned",
      arguments: { status: "ready", limit: 2 },
    })) as CallToolResult;
    const firstData = dataOf(first) as {
      obligations: Array<{ id: string }>;
      total: number;
      truncated: boolean;
      nextCursor: string;
    };
    expect(firstData).toMatchObject({
      obligations: [{ id: "first" }, { id: "second" }],
      total: 3,
      truncated: true,
    });
    expect(firstData.nextCursor).toBeTypeOf("string");

    const second = (await client.callTool({
      name: "list_owned",
      arguments: { status: "ready", limit: 2, cursor: firstData.nextCursor },
    })) as CallToolResult;
    expect(dataOf(second)).toMatchObject({
      obligations: [{ id: "third" }],
      total: 3,
      truncated: true,
      nextCursor: null,
    });

    const wrongFilter = (await client.callTool({
      name: "list_owned",
      arguments: { status: "waiting", limit: 2, cursor: firstData.nextCursor },
    })) as CallToolResult;
    expect(wrongFilter.isError).toBe(true);
  });

  it("pages children and live blockers independently without hiding the blocker", async () => {
    repository.create({ id: "parent", owner: { kind: "actor", id: "actor-a" } });
    repository.create({
      id: "a-terminal",
      parentId: "parent",
      owner: { kind: "actor", id: "actor-b" },
    });
    repository.setTerminalStatus("a-terminal", "done");
    repository.create({
      id: "z-live",
      parentId: "parent",
      owner: { kind: "actor", id: "actor-b" },
    });

    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const first = (await client.callTool({
      name: "get_obligation",
      arguments: { id: "parent", limit: 1 },
    })) as CallToolResult;
    const firstData = dataOf(first) as {
      children: { items: Array<{ id: string }>; total: number; nextCursor: string };
      blockingChildren: {
        items: Array<{ id: string }>;
        total: number;
        truncated: boolean;
        nextCursor: null;
      };
    };
    expect(firstData.children).toMatchObject({
      items: [{ id: "a-terminal" }],
      total: 2,
      truncated: true,
    });
    expect(firstData.blockingChildren).toEqual({
      items: [expect.objectContaining({ id: "z-live" })],
      total: 1,
      truncated: false,
      nextCursor: null,
    });

    const second = (await client.callTool({
      name: "get_obligation",
      arguments: { id: "parent", limit: 1, children_cursor: firstData.children.nextCursor },
    })) as CallToolResult;
    expect(dataOf(second)).toMatchObject({
      children: { items: [{ id: "z-live" }], total: 2, truncated: true, nextCursor: null },
      blockingChildren: { items: [{ id: "z-live" }], total: 1 },
    });
  });

  it("returns an error for a missing obligation", async () => {
    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const result = (await client.callTool({
      name: "get_obligation",
      arguments: { id: "missing" },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
  });
});
