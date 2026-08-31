import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { obligations } from "../db/migrations/0016_obligations.js";
import { obligationPriority } from "../db/migrations/0017_obligation_priority.js";
import { obligationTimestamps } from "../db/migrations/0025_obligation_timestamps.js";
import { obligationTerminalNote } from "../db/migrations/0026_obligation_terminal_note.js";
import { obligationTitle } from "../db/migrations/0027_obligation_title.js";
import { obligationArtifacts } from "../db/migrations/0028_obligation_artifacts.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { resolveObligationOwner } from "../obligations/owner.js";
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
    obligationTimestamps.up(db);
    obligationTerminalNote.up(db);
    obligationTitle.up(db);
    obligationArtifacts.up(db);
    repository = new ObligationRepository(db);
  });

  it("exposes all 8 obligation tools", async () => {
    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "attach_artifact",
      "create_obligation",
      "get_obligation",
      "list_owned",
      "reassign_obligation",
      "reorder_obligation",
      "reparent_obligation",
      "set_obligation_status",
    ]);
  });

  it("stamps the creating actor as creator, distinct from the owner", async () => {
    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const res = (await client.callTool({
      name: "create_obligation",
      arguments: {
        title: "raised here, owned there",
        // Raised by actor-a, OWNED by actor-b — the case the creator column
        // exists for (#1671: reassignment must not destroy who raised it).
        owner_id: "actor-b",
        intent: "raised here, owned there",
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    const { obligation } = dataOf(res) as {
      obligation: {
        id: string;
        ownerId: string;
        creatorId: string | null;
      };
    };
    expect(obligation.ownerId).toBe("actor-b");
    expect(obligation.creatorId).toBe("actor-a");

    // And it survives the reassignment that destroys owner attribution.
    repository.reassign(obligation.id, "human:operator");
    expect(repository.require(obligation.id).creatorId).toBe("actor-a");
  });

  it("refuses model-supplied creator attribution at the schema boundary", async () => {
    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const res = (await client.callTool({
      name: "create_obligation",
      arguments: {
        title: "attempted attribution laundering",
        owner_id: "actor-a",
        intent: "attempted attribution laundering",
        created_by: "human:operator",
      },
    })) as CallToolResult;

    // #1671's trust boundary: attribution is never accepted as model payload.
    // The tool exposes no such input, so the call is rejected rather than
    // silently stripped — an actor cannot claim to be the human operator.
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain("unrecognized_keys");
  });

  it("creates a root obligation and child obligation via create_obligation", async () => {
    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const rootRes = (await client.callTool({
      name: "create_obligation",
      arguments: {
        title: "build feature",
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
        title: "subtask",
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
      title: "root-task",
      id: "root-task",
      ownerId: "actor-a",
      priority: 100,
    });
    repository.create({
      title: "child-task",
      id: "child-task",
      parentId: "root-task",
      ownerId: "actor-a",
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

  it("refuses an owner the mesh cannot route to", async () => {
    // The drift `0025` migrates away came back in through this surface: a
    // nonexistent actor or an invented `system:*` id produced live work that
    // appears in no queue and wakes nobody.
    const registry = new Map([
      ["actor-a", { status: "active" }],
      ["actor-retired", { status: "retired" }],
    ]);
    const client = await connect(
      createObligationsMcpServer(repository, "actor-a", {
        resolveOwner: (raw) =>
          resolveObligationOwner({ get: (id: string) => registry.get(id) as never }, raw),
      })
    );

    for (const ownerId of ["actor-nonexistent", "actor-retired", "system:mesh"]) {
      const res = (await client.callTool({
        name: "create_obligation",
        arguments: { title: "typo", owner_id: ownerId, intent: "typo" },
      })) as CallToolResult;
      expect(res.isError, ownerId).toBe(true);
    }
    expect(repository.list()).toHaveLength(0);

    // A live actor and the canonical operator id are both legitimate: owning
    // work to another actor is why `creator_id` exists, and owning it to the
    // operator is the human-decision contract.
    for (const ownerId of ["actor-a", "human:operator"]) {
      const res = (await client.callTool({
        name: "create_obligation",
        arguments: { title: "fine", owner_id: ownerId, intent: "fine" },
      })) as CallToolResult;
      expect(res.isError, ownerId).toBeFalsy();
    }
  });

  it("records the actor's stated reason on the terminal transition", async () => {
    repository.create({
      title: "why-task",
      id: "why-task",
      ownerId: "actor-a",
    });

    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const res = (await client.callTool({
      name: "set_obligation_status",
      arguments: {
        id: "why-task",
        status: "cancelled",
        note: "Superseded by the ancestry projection; this framing no longer applies.",
      },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    const { obligation } = dataOf(res) as { obligation: { terminalNote: string | null } };
    expect(obligation.terminalNote).toBe(
      "Superseded by the ancestry projection; this framing no longer applies."
    );
    expect(repository.require("why-task").terminalNote).toBe(
      "Superseded by the ancestry projection; this framing no longer applies."
    );
  });

  it("leaves the reason null when the actor gives none", async () => {
    repository.create({
      title: "silent-task",
      id: "silent-task",
      ownerId: "actor-a",
    });

    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const res = (await client.callTool({
      name: "set_obligation_status",
      arguments: { id: "silent-task", status: "done" },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    // Optional, not required: an actor that finishes work without narrating it
    // still gets a clean transition rather than a validation failure.
    expect(repository.require("silent-task").terminalNote).toBeNull();
  });

  it("reorders obligations via reorder_obligation", async () => {
    repository.create({
      title: "first",
      id: "first",
      ownerId: "actor-a",
    });
    repository.create({
      title: "second",
      id: "second",
      ownerId: "actor-a",
    });

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

    const list = repository.listOwned("actor-a", { status: "ready" });
    expect(list.map((o) => o.id)).toEqual(["second", "first"]);
  });

  it("reparents an obligation via reparent_obligation", async () => {
    repository.create({
      title: "p1",
      id: "p1",
      ownerId: "actor-a",
    });
    repository.create({
      title: "p2",
      id: "p2",
      ownerId: "actor-a",
    });
    repository.create({
      title: "c1",
      id: "c1",
      parentId: "p1",
      ownerId: "actor-a",
    });

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
    repository.create({
      title: "task",
      id: "task",
      ownerId: "actor-a",
    });
    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const result = (await client.callTool({
      name: "reassign_obligation",
      arguments: { id: "task", owner_id: "human:operator" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(dataOf(result)).toMatchObject({
      obligation: { id: "task", ownerId: "human:operator" },
      previousOwnerId: "actor-a",
    });
  });

  it("rejects unauthorized reassignment and honors an injected ancestor policy", async () => {
    repository.create({
      title: "foreign",
      id: "foreign",
      ownerId: "actor-b",
    });
    const denied = await connect(createObligationsMcpServer(repository, "actor-a"));
    const deniedResult = (await denied.callTool({
      name: "reassign_obligation",
      arguments: { id: "foreign", owner_id: "actor-c" },
    })) as CallToolResult;
    expect(deniedResult.isError).toBe(true);
    expect(repository.require("foreign").ownerId).toBe("actor-b");

    const authorized = await connect(
      createObligationsMcpServer(repository, "actor-a", { canReassign: () => true })
    );
    const authorizedResult = (await authorized.callTool({
      name: "reassign_obligation",
      arguments: { id: "foreign", owner_id: "actor-c" },
    })) as CallToolResult;
    expect(authorizedResult.isError).toBeFalsy();
    expect(repository.require("foreign").ownerId).toBe("actor-c");
  });

  it("binds list_owned to the actor and preserves ready queue order", async () => {
    repository.create({
      title: "first",
      id: "first",
      ownerId: "actor-a",
    });
    repository.create({
      title: "second",
      id: "second",
      ownerId: "actor-a",
    });
    repository.create({
      title: "foreign",
      id: "foreign",
      ownerId: "actor-b",
    });
    repository.movePriorityInternal("second", null, "first");

    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const result = (await client.callTool({
      name: "list_owned",
      arguments: { status: "ready" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(dataOf(result)).toMatchObject({
      ownerId: "actor-a",
      obligations: [{ id: "second" }, { id: "first" }],
      total: 2,
      truncated: false,
      nextCursor: null,
    });
  });

  it("explains a waiting obligation and names its cross-owner blocker in one read", async () => {
    repository.create({
      title: "parent",
      id: "parent",
      ownerId: "actor-a",
      intent: "deliver the requested change",
    });
    repository.create({
      title: "blocker",
      id: "blocker",
      parentId: "parent",
      ownerId: "actor-b",
      intent: "review the artifact",
    });

    const client = await connect(createObligationsMcpServer(repository, "actor-a"));
    const result = (await client.callTool({
      name: "get_obligation",
      arguments: { id: "parent" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(dataOf(result)).toMatchObject({
      obligation: { id: "parent", status: "waiting", ownerId: "actor-a" },
      parent: null,
      children: {
        items: [{ id: "blocker", ownerId: "actor-b" }],
        total: 1,
        truncated: false,
        nextCursor: null,
      },
      blockingChildren: {
        items: [
          {
            id: "blocker",
            status: "ready",
            ownerId: "actor-b",
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
      repository.create({
        title: "task",
        id,
        ownerId: "actor-a",
      });
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
    repository.create({
      title: "parent",
      id: "parent",
      ownerId: "actor-a",
    });
    repository.create({
      title: "a-terminal",
      id: "a-terminal",
      parentId: "parent",
      ownerId: "actor-b",
    });
    repository.setTerminalStatus("a-terminal", "done");
    repository.create({
      title: "z-live",
      id: "z-live",
      parentId: "parent",
      ownerId: "actor-b",
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
