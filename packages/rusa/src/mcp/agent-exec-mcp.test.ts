import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { Actor } from "../actor/actor.js";
import { ActorMesh } from "../actor/actor-mesh.js";
import type { RootControlService } from "../actor/root-control.js";
import { InMemoryThreadRegistry } from "../actor/thread-registry.js";
import { FakeProvider } from "../providers/fake-provider.js";
import type { RunResult } from "../providers/types.js";
import { createAgentExecMcpServer } from "./agent-exec-mcp.js";

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

/** A child-provider run that blocks until released — for in-flight-run assertions. */
function heldRun(): { responder: () => Promise<Partial<RunResult>>; release: () => void } {
  const gates: Array<() => void> = [];
  return {
    responder: () => new Promise<Partial<RunResult>>((resolve) => gates.push(() => resolve({}))),
    release: () => {
      for (const g of gates.splice(0)) g();
    },
  };
}

/** Let the actor's 1ms debounce fire and its run reach the provider. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function setup(
  opts: { childResponder?: () => Promise<Partial<RunResult>>; maxConcurrent?: number } = {}
) {
  const registry = new InMemoryThreadRegistry();
  const events: {
    kind: string;
    actorId?: string;
    detail?: string;
    body?: string;
    payload?: string;
  }[] = [];
  let seq = 0;
  const mesh = new ActorMesh({
    registry,
    maxConcurrent: opts.maxConcurrent,
    events: (e) => events.push(e),
    grantableCapabilities: new Set([
      "understanding-write",
      "secret:gemini-api-key",
      "secret:mistral-api-key",
    ]),
    idgen: () => `t${++seq}`,
    now: () => "2026-01-01T00:00:00Z",
    createActor: (ctx) =>
      new Actor({
        id: ctx.record.id,
        cwd: `/tmp/${ctx.record.id}`,
        provider: new FakeProvider(opts.childResponder),
        mcpServers: [],
        loadSessionId: () => ctx.getRecord()?.sessionId,
        saveSessionId: (sid) => registry.patch(ctx.record.id, { sessionId: sid }),
        buildPrompt: () => ({ prompt: "Read inbox" }),
        gate: ctx.gate,
        beforeRun: ctx.beforeRun,
        onQueued: ctx.onQueued,
        onRunEnd: ctx.onRunEnd,
        debounceMs: 1,
      }),
  });
  const root = new Actor({
    id: "root",
    cwd: "/tmp/root",
    provider: new FakeProvider(),
    mcpServers: [],
    loadSessionId: () => undefined,
    saveSessionId: () => {},
    buildPrompt: () => ({ prompt: "Read inbox" }),
    debounceMs: 1,
  });
  mesh.adopt(
    {
      id: "root",
      charter: "root",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    },
    root
  );
  return { registry, mesh, events };
}

describe("agent-execution MCP server", () => {
  it("exposes the mesh primitives as tools (root also gets the grant tools)", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "delegate_event_source",
        "grant_capability",
        "introduce",
        "list_grants",
        "list_pending_messages",
        "list_subscriptions",
        "list_threads",
        "reclaim_event_source",
        "reparent_thread",
        "retire_thread",
        "revive_thread",
        "revoke_capability",
        "send_message",
        "set_thread_charter",
        "set_actor_model",
        "set_thread_title",
        "spawn_thread",
        "yield_run",
      ].sort()
    );
  });

  it("describes externally-triggered parent-delegated completion reporting", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "worker-1", "root"));
    const { tools } = await client.listTools();
    const yieldTool = tools.find((t) => t.name === "yield_run");
    expect(yieldTool?.description).toMatch(/finish work your parent asked you to do/i);
    expect(yieldTool?.description).toMatch(/automatic parent notification won't fire/i);
  });

  it("describes live capability grants as effective on the next run", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { tools } = await client.listTools();
    const grantTool = tools.find((tool) => tool.name === "grant_capability");
    expect(grantTool?.description).toContain("live grantee's next run");
    expect(grantTool?.description).toContain("retired grantee is next revived");
  });

  it("exposes grant/revoke (mesh-enforced) but NOT the root management tools on a non-root endpoint", async () => {
    const { mesh } = setup();
    // grant_capability/revoke_capability are registered on every endpoint since
    // ISSUE_NUM (a parent may grant allow-listed secrets to its direct children —
    // authorization is enforced in the mesh, keyed on this endpoint's identity).
    // The root management tools (list_grants, revive, reparent, …) stay
    // root-endpoint-only.
    const client = await connect(createAgentExecMcpServer(mesh, "worker-1", "root"));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("list_grants");
    expect(names).not.toContain("revive_thread");
    expect(names).not.toContain("reparent_thread");
    expect(names.sort()).toEqual(
      [
        "delegate_event_source",
        "grant_capability",
        "introduce",
        "list_pending_messages",
        "list_threads",
        "reclaim_event_source",
        "retire_thread",
        "revoke_capability",
        "send_message",
        "set_actor_model",
        "spawn_thread",
        "yield_run",
      ].sort()
    );
  });

  it("yield_run records a run_yielded event for the caller", async () => {
    const { mesh, events } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const result = await client.callTool({
      name: "yield_run",
      arguments: { status: "complete", note: "done for now" },
    });
    expect(dataOf(result as CallToolResult)).toBe("yielded");
    const yielded = events.find((e) => e.kind === "run_yielded");
    expect(yielded).toMatchObject({ actorId: "root", detail: "complete" });
  });

  it("yield_run only records the yield when it is called outside an active run", async () => {
    const { mesh, events } = setup();
    const rootSrv = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const spawn = await rootSrv.callTool({
      name: "spawn_thread",
      arguments: { charter: "do a thing", provider: "claude", model: "claude-sonnet-4-6" },
    });
    const { thread_id } = dataOf(spawn as CallToolResult) as { thread_id: string };
    const childSrv = await connect(createAgentExecMcpServer(mesh, thread_id, "root"));
    await childSrv.callTool({
      name: "yield_run",
      arguments: { status: "blocked", note: "waiting on review" },
    });
    const toParent = events.find((e) => e.kind === "message_sent");
    expect(toParent).toBeUndefined();
    const yielded = events.find((e) => e.kind === "run_yielded" && e.actorId === thread_id);
    expect(yielded?.detail).toBe("blocked");
    expect(yielded?.body).toBe("waiting on review");
  });

  it("spawn_thread creates a child parented to the caller and returns its id", async () => {
    const { mesh, registry } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const res = (await client.callTool({
      name: "spawn_thread",
      arguments: {
        charter: "implement X",
        provider: "claude",
        model: "claude-sonnet-4-6",
        effort: "high",
      },
    })) as CallToolResult;
    const { thread_id } = dataOf(res) as { thread_id: string };
    expect(thread_id).toBe("t1");
    const rec = registry.get("t1");
    expect(rec?.parentId).toBe("root");
    expect(rec?.charter).toBe("implement X");
    expect(rec?.provider).toBe("claude");
    expect(rec?.model).toBe("claude-sonnet-4-6");
    expect(rec?.effort).toBe("high");
    // The caller got a handle to its new child.
    expect(registry.get("root")?.handles).toEqual([{ id: "t1" }]);
  });

  it("routes root spawn_thread through the shared root control service", async () => {
    const { mesh } = setup();
    const spawnChild = vi.fn(() => "delegated-child");
    const rootControl = { spawnChild } as unknown as RootControlService;
    const client = await connect(
      createAgentExecMcpServer(mesh, "root", "root", undefined, { rootControl })
    );
    const result = (await client.callTool({
      name: "spawn_thread",
      arguments: {
        charter: "review the patch",
        provider: "agy",
        model: "gemini-3.5-flash-medium",
      },
    })) as CallToolResult;

    expect(dataOf(result)).toEqual({ thread_id: "delegated-child" });
    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({
        charter: "review the patch",
        provider: "agy",
        model: "gemini-3.5-flash-medium",
      }),
      "root-llm"
    );
  });

  it("spawn_thread records the requested harness and model", async () => {
    const { mesh, registry } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id } = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "review", provider: "claude", model: "claude-opus-4-8" },
      })) as CallToolResult
    ) as { thread_id: string };
    const rec = registry.get(thread_id);
    expect(rec?.provider).toBe("claude");
    expect(rec?.model).toBe("claude-opus-4-8");
  });

  it("spawn_thread passes the optional title to the record", async () => {
    const { mesh, registry } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id } = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: {
          charter: "do tasks",
          provider: "claude",
          model: "claude-sonnet-4-6",
          title: "My custom actor title",
        },
      })) as CallToolResult
    ) as { thread_id: string };
    const rec = registry.get(thread_id);
    expect(rec?.title).toBe("My custom actor title");
  });

  it("spawn_thread writes the portable context selection onto the record", async () => {
    // The wiring cell, not a resolver cell: before this, every prod spawn path
    // dropped `context` on the floor, so a portable actor could not be created in
    // the live mesh at all . Asserting on the RECORD is what proves the
    // field survives the tool boundary.
    const { mesh, registry } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id } = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: {
          charter: "own a small issue",
          provider: "claude",
          model: "claude-sonnet-4-6",
          context_mode: "ledger",
        },
      })) as CallToolResult
    ) as { thread_id: string };
    expect(registry.get(thread_id)?.context).toMatchObject({ type: "portable", mode: "ledger" });
  });

  it("spawn_thread leaves the record's context unset when no mode is asked for", async () => {
    // Counter-assertion to the cell above: the default must still be native, or
    // the cell above would pass for the wrong reason (everything portable).
    const { mesh, registry } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id } = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "ordinary work", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    expect(registry.get(thread_id)?.context).toBeUndefined();
  });

  it("spawn_thread forwards the context selection through root control too", async () => {
    const { mesh } = setup();
    const spawnChild = vi.fn(() => "delegated-child");
    const rootControl = { spawnChild } as unknown as RootControlService;
    const client = await connect(
      createAgentExecMcpServer(mesh, "root", "root", undefined, { rootControl })
    );
    await client.callTool({
      name: "spawn_thread",
      arguments: {
        charter: "own a small issue",
        provider: "claude",
        model: "claude-sonnet-4-6",
        context_mode: "tail",
      },
    });
    expect(spawnChild).toHaveBeenCalledWith(
      expect.objectContaining({ context: { type: "portable", mode: "tail" } }),
      "root-llm"
    );
  });

  it("spawn_thread rejects calls with missing provider or model ", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const missingProvider = (await client.callTool({
      name: "spawn_thread",
      arguments: { charter: "work", model: "claude-sonnet-4-6" },
    })) as CallToolResult;
    expect(missingProvider.isError).toBe(true);

    const missingModel = (await client.callTool({
      name: "spawn_thread",
      arguments: { charter: "work", provider: "claude" },
    })) as CallToolResult;
    expect(missingModel.isError).toBe(true);

    const emptyProvider = (await client.callTool({
      name: "spawn_thread",
      arguments: { charter: "work", provider: "   ", model: "claude-sonnet-4-6" },
    })) as CallToolResult;
    expect(emptyProvider.isError).toBe(true);

    const emptyModel = (await client.callTool({
      name: "spawn_thread",
      arguments: { charter: "work", provider: "claude", model: "   " },
    })) as CallToolResult;
    expect(emptyModel.isError).toBe(true);
  });

  it("introduce grants the holder a handle to the target (with optional role)", async () => {
    const { mesh, registry } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const a = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "coder", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    const b = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "reviewer", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    await client.callTool({
      name: "introduce",
      arguments: { holder_thread_id: a.thread_id, target_thread_id: b.thread_id, role: "reviewer" },
    });
    expect(registry.get(a.thread_id)?.handles).toEqual([{ id: b.thread_id, role: "reviewer" }]);
  });

  it("list_threads returns the caller's direct reports", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    await client.callTool({
      name: "spawn_thread",
      arguments: { charter: "first task\nmore", provider: "claude", model: "claude-sonnet-4-6" },
    });
    await client.callTool({
      name: "spawn_thread",
      arguments: { charter: "second task", provider: "claude", model: "claude-sonnet-4-6" },
    });
    const list = dataOf(
      (await client.callTool({ name: "list_threads", arguments: {} })) as CallToolResult
    ) as Array<{ thread_id: string; charter: string; status: string }>;
    expect(list).toHaveLength(2);
    expect(list[0]?.charter).toBe("first task"); // summarized to first line
    expect(list.every((t) => t.status === "active")).toBe(true);
  });

  it("retire_thread retires a descendant", async () => {
    const { mesh, registry } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id } = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "x", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    await client.callTool({ name: "retire_thread", arguments: { thread_id } });
    expect(registry.get(thread_id)?.status).toBe("retired");
  });

  it("retire_thread refuses a report with a run in flight, naming it ", async () => {
    const held = heldRun();
    const { mesh, registry } = setup({ childResponder: held.responder });
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id } = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "build the arm", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    mesh.sendMessage(thread_id, "go", "root");
    await settle();
    expect(mesh.activeRunState(thread_id)).toEqual({ actorId: thread_id, phase: "running" });

    const res = (await client.callTool({
      name: "retire_thread",
      arguments: { thread_id },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(String(dataOf(res))).toContain(`${thread_id} (running)`);
    expect(registry.get(thread_id)?.status).toBe("active");

    // Force does NOT allow terminating a running run from an actor
    const forceRes = (await client.callTool({
      name: "retire_thread",
      arguments: { thread_id, force: true },
    })) as CallToolResult;
    expect(forceRes.isError).toBe(true);
    expect(String(dataOf(forceRes))).toContain(`${thread_id} (running)`);
    expect(registry.get(thread_id)?.status).toBe("active");

    held.release();
    await settle();
  });

  it("retire_thread refuses a queued report without force, but retires with force: true ", async () => {
    const held = heldRun();
    const { mesh, registry } = setup({ maxConcurrent: 1, childResponder: held.responder });
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const w1 = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "worker 1", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    const w2 = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "worker 2", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };

    mesh.sendMessage(w1.thread_id, "go", "root");
    mesh.sendMessage(w2.thread_id, "go", "root");
    await settle();

    expect(mesh.activeRunState(w1.thread_id)).toEqual({ actorId: w1.thread_id, phase: "running" });
    expect(mesh.activeRunState(w2.thread_id)).toEqual({ actorId: w2.thread_id, phase: "queued" });

    // Without force, retiring a queued thread is refused
    const unforcedRes = (await client.callTool({
      name: "retire_thread",
      arguments: { thread_id: w2.thread_id },
    })) as CallToolResult;
    expect(unforcedRes.isError).toBe(true);
    expect(String(dataOf(unforcedRes))).toContain(`${w2.thread_id} (queued)`);
    expect(registry.get(w2.thread_id)?.status).toBe("active");

    // With force: true, the queued run is cancelled and the thread is retired
    const forcedRes = (await client.callTool({
      name: "retire_thread",
      arguments: { thread_id: w2.thread_id, force: true },
    })) as CallToolResult;
    expect(forcedRes.isError).toBeFalsy();
    expect(dataOf(forcedRes)).toBe("retired");
    expect(registry.get(w2.thread_id)?.status).toBe("retired");

    held.release();
    await settle();
  });

  it("list_threads reports each report's in-flight run state", async () => {
    const held = heldRun();
    const { mesh } = setup({ childResponder: held.responder });
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const busy = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "busy", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    const idle = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "idle", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    mesh.sendMessage(busy.thread_id, "go", "root");
    await settle();

    const list = dataOf(
      (await client.callTool({ name: "list_threads", arguments: {} })) as CallToolResult
    ) as Array<{ thread_id: string; run_state: string }>;

    expect(list.find((t) => t.thread_id === busy.thread_id)?.run_state).toBe("running");
    expect(list.find((t) => t.thread_id === idle.thread_id)?.run_state).toBe("idle");

    held.release();
    await settle();
  });

  it("refuses to retire a non-descendant", async () => {
    const { mesh, registry } = setup();
    registry.upsert({
      id: "stranger",
      charter: "not mine",
      parentId: "someone-else",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const res = (await client.callTool({
      name: "retire_thread",
      arguments: { thread_id: "stranger" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(dataOf(res)).toBe("you can only retire your own descendant threads");
    expect(registry.get("stranger")?.status).toBe("active");
  });

  it("retire_thread reports unknown thread id for a nonexistent thread id ", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const res = (await client.callTool({
      name: "retire_thread",
      arguments: { thread_id: "00000000-0000-4000-8000-000000000000" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(dataOf(res)).toBe("unknown thread id: 00000000-0000-4000-8000-000000000000");
  });

  it("introduce reports unknown thread id for nonexistent holder or target ", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id } = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "worker", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };

    const res1 = (await client.callTool({
      name: "introduce",
      arguments: { holder_thread_id: "ghost-holder", target_thread_id: thread_id },
    })) as CallToolResult;
    expect(res1.isError).toBe(true);
    expect(dataOf(res1)).toBe("unknown thread id: ghost-holder");

    const res2 = (await client.callTool({
      name: "introduce",
      arguments: { holder_thread_id: thread_id, target_thread_id: "ghost-target" },
    })) as CallToolResult;
    expect(res2.isError).toBe(true);
    expect(dataOf(res2)).toBe("unknown thread id: ghost-target");
  });

  it("send_message delivers to a thread and is attributed to the caller", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id } = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "x", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    const res = (await client.callTool({
      name: "send_message",
      arguments: { thread_id, body: "status?" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(dataOf(res)).toBe("sent");
  });

  it("send_message reports a retired recipient instead of claiming delivery", async () => {
    const { mesh, registry } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id } = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "x", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    mesh.retire(thread_id);

    const res = (await client.callTool({
      name: "send_message",
      arguments: { thread_id, body: "status?" },
    })) as CallToolResult;

    expect(registry.get(thread_id)?.status).toBe("retired");
    expect(res.isError).toBe(true);
    expect(dataOf(res)).toBe(`dropped — recipient ${thread_id} is not live (status: retired)`);
  });

  it("send_message reports unknown thread id for a recipient missing from the registry ", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));

    const res = (await client.callTool({
      name: "send_message",
      arguments: { thread_id: "ghost", body: "status?" },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect(dataOf(res)).toBe("unknown thread id: ghost");
  });

  // ── Capability grants (ISSUE_NUM, phase 1a) ── granted to an actor by its thread id.

  it("grant_capability (root) grants an allow-listed capability to an actor and audits it", async () => {
    const { mesh, events, registry } = setup();
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const res = (await client.callTool({
      name: "grant_capability",
      arguments: { actor_id: "iu-thread", capability: "understanding-write" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(mesh.activeCapabilitiesFor("iu-thread")).toEqual(["understanding-write"]);
    const audit = events.find((e) => e.kind === "capability_granted");
    expect(audit).toMatchObject({
      actorId: "iu-thread",
      detail: "understanding-write",
      payload: JSON.stringify({ grantedBy: "root" }),
    });
  });

  it("grant_capability rejects a capability outside the allow-list", async () => {
    const { mesh, registry } = setup();
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const res = (await client.callTool({
      name: "grant_capability",
      arguments: { actor_id: "iu-thread", capability: "self-update" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect(mesh.activeCapabilitiesFor("iu-thread")).toEqual([]);
  });

  it("revoke_capability (root) revokes an active grant and audits it", async () => {
    const { mesh, events, registry } = setup();
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    await client.callTool({
      name: "grant_capability",
      arguments: { actor_id: "iu-thread", capability: "understanding-write" },
    });
    const res = (await client.callTool({
      name: "revoke_capability",
      arguments: { actor_id: "iu-thread", capability: "understanding-write" },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(mesh.activeCapabilitiesFor("iu-thread")).toEqual([]);
    expect(events.some((e) => e.kind === "capability_revoked")).toBe(true);
  });

  it("list_grants (root) reports active and revoked grants", async () => {
    const { mesh, registry } = setup();
    registry.upsert({
      id: "iu-thread",
      charter: "iu steward",
      parentId: "root",
      status: "active",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    await client.callTool({
      name: "grant_capability",
      arguments: { actor_id: "iu-thread", capability: "understanding-write" },
    });
    const grants = dataOf(
      (await client.callTool({ name: "list_grants", arguments: {} })) as CallToolResult
    ) as Array<{ actorId: string; capability: string; grantedBy: string }>;
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      actorId: "iu-thread",
      capability: "understanding-write",
      grantedBy: "root",
    });
  });

  it("grant_capability and revoke_capability (root) report unknown thread id for a nonexistent grantee ", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));

    const grantRes = (await client.callTool({
      name: "grant_capability",
      arguments: { actor_id: "ghost", capability: "understanding-write" },
    })) as CallToolResult;
    expect(grantRes.isError).toBe(true);
    expect(dataOf(grantRes)).toBe("unknown thread id: ghost");

    const revokeRes = (await client.callTool({
      name: "revoke_capability",
      arguments: { actor_id: "ghost", capability: "understanding-write" },
    })) as CallToolResult;
    expect(revokeRes.isError).toBe(true);
    expect(dataOf(revokeRes)).toBe("unknown thread id: ghost");
  });

  // ── Parent-grantable secrets  ── the grantor is the endpoint identity,
  // threaded through to the mesh, which enforces root/parent authority.

  it("grant/revoke_capability on a non-root endpoint support both parent-grantable secrets", async () => {
    const { mesh, events } = setup();
    const rootSrv = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id: parentId } = dataOf(
      (await rootSrv.callTool({
        name: "spawn_thread",
        arguments: { charter: "parent", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    const parentSrv = await connect(createAgentExecMcpServer(mesh, parentId, "root"));
    const { thread_id: childId } = dataOf(
      (await parentSrv.callTool({
        name: "spawn_thread",
        arguments: { charter: "child", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };

    for (const capability of ["secret:gemini-api-key", "secret:mistral-api-key"]) {
      const granted = (await parentSrv.callTool({
        name: "grant_capability",
        arguments: { actor_id: childId, capability },
      })) as CallToolResult;
      expect(granted.isError).toBeFalsy();
      expect(mesh.activeCapabilitiesFor(childId)).toEqual([capability]);
      // Audit event payload.grantedBy = the grantor (the parent endpoint's identity).
      const audit = events.find((e) => e.kind === "capability_granted" && e.detail === capability);
      expect(audit).toMatchObject({
        actorId: childId,
        detail: capability,
        payload: JSON.stringify({ grantedBy: parentId }),
      });

      const revoked = (await parentSrv.callTool({
        name: "revoke_capability",
        arguments: { actor_id: childId, capability },
      })) as CallToolResult;
      expect(revoked.isError).toBeFalsy();
      expect(mesh.activeCapabilitiesFor(childId)).toEqual([]);
    }
  });

  it("grant_capability on a non-root endpoint is rejected for a non-child grantee and for non-secret capabilities", async () => {
    const { mesh } = setup();
    const rootSrv = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id: parentId } = dataOf(
      (await rootSrv.callTool({
        name: "spawn_thread",
        arguments: { charter: "parent", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };
    const { thread_id: siblingId } = dataOf(
      (await rootSrv.callTool({
        name: "spawn_thread",
        arguments: {
          charter: "sibling (root's child, not parent's)",
          provider: "claude",
          model: "claude-sonnet-4-6",
        },
      })) as CallToolResult
    ) as { thread_id: string };
    const parentSrv = await connect(createAgentExecMcpServer(mesh, parentId, "root"));
    const { thread_id: childId } = dataOf(
      (await parentSrv.callTool({
        name: "spawn_thread",
        arguments: { charter: "child", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };

    // Non-child grantee → rejected (the grant lands nowhere).
    const nonChild = (await parentSrv.callTool({
      name: "grant_capability",
      arguments: { actor_id: siblingId, capability: "secret:gemini-api-key" },
    })) as CallToolResult;
    expect(nonChild.isError).toBe(true);
    expect(mesh.activeCapabilitiesFor(siblingId)).toEqual([]);

    // Non-parent-grantable capability → rejected even for a direct child.
    const nonSecret = (await parentSrv.callTool({
      name: "grant_capability",
      arguments: { actor_id: childId, capability: "understanding-write" },
    })) as CallToolResult;
    expect(nonSecret.isError).toBe(true);
    expect(mesh.activeCapabilitiesFor(childId)).toEqual([]);

    // Unknown grantee → returns unknown thread id error .
    const unknownGrantee = (await parentSrv.callTool({
      name: "grant_capability",
      arguments: { actor_id: "ghost", capability: "secret:gemini-api-key" },
    })) as CallToolResult;
    expect(unknownGrantee.isError).toBe(true);
    expect(dataOf(unknownGrantee)).toBe("unknown thread id: ghost");

    const unknownRevoke = (await parentSrv.callTool({
      name: "revoke_capability",
      arguments: { actor_id: "ghost", capability: "secret:gemini-api-key" },
    })) as CallToolResult;
    expect(unknownRevoke.isError).toBe(true);
    expect(dataOf(unknownRevoke)).toBe("unknown thread id: ghost");
  });

  it("revive_thread (root) revives a retired thread and audits it", async () => {
    const { mesh, registry, events } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const { thread_id } = dataOf(
      (await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "x", provider: "claude", model: "claude-sonnet-4-6" },
      })) as CallToolResult
    ) as { thread_id: string };

    await client.callTool({ name: "retire_thread", arguments: { thread_id } });
    expect(registry.get(thread_id)?.status).toBe("retired");

    const res = (await client.callTool({
      name: "revive_thread",
      arguments: { thread_id },
    })) as CallToolResult;
    expect(res.isError).toBeFalsy();
    expect(registry.get(thread_id)?.status).toBe("active");

    const audit = events.find((e) => e.kind === "actor_revived");
    expect(audit).toMatchObject({
      actorId: thread_id,
      payload: JSON.stringify({ parentId: "root" }),
    });
  });

  it("does NOT expose the revive_thread tool on a non-root endpoint", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "worker-1", "root"));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("revive_thread");
  });

  it("does not expose runtime subscribe/unsubscribe/list tools on a non-root endpoint", async () => {
    const { mesh } = setup();
    const client = await connect(createAgentExecMcpServer(mesh, "worker-1", "root"));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("subscribe_event_source");
    expect(names).not.toContain("unsubscribe_event_source");
    expect(names).not.toContain("list_subscriptions");
    expect(names).toContain("delegate_event_source");
    expect(names).toContain("reclaim_event_source");
  });

  describe("Event source delegation tools (non-root, ISSUE_NUM §2)", () => {
    it("lets a subscribed parent delegate to a child and reclaim the topic", async () => {
      const { mesh } = setup();
      const rootClient = await connect(createAgentExecMcpServer(mesh, "root", "root"));

      await rootClient.callTool({
        name: "spawn_thread",
        arguments: { charter: "parent", provider: "claude", model: "claude-sonnet-4-6" },
      });
      const parentClient = await connect(createAgentExecMcpServer(mesh, "t1", "root"));
      await parentClient.callTool({
        name: "spawn_thread",
        arguments: { charter: "child", provider: "claude", model: "claude-sonnet-4-6" },
      });
      mesh.subscribeEventSource("github:dummy-org", "root", "root");
      await rootClient.callTool({
        name: "delegate_event_source",
        arguments: {
          child_thread_id: "t1",
          kind: "github_repo",
          repo: "dummy-org/dummy-repo",
        },
      });

      const delegateRes = (await parentClient.callTool({
        name: "delegate_event_source",
        arguments: {
          child_thread_id: "t2",
          kind: "github_pr",
          repo: "dummy-org/dummy-repo",
          number: 616,
        },
      })) as CallToolResult;
      expect(delegateRes.isError).toBeFalsy();
      expect(dataOf(delegateRes)).toContain(
        "delegated github:dummy-org/dummy-repo/pulls/616 to t2"
      );

      let listRes = (await rootClient.callTool({
        name: "list_subscriptions",
        arguments: {},
      })) as CallToolResult;
      expect(dataOf(listRes)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorId: "t2",
            resource: "github:dummy-org/dummy-repo/pulls/616",
            subscribedBy: "t1",
          }),
        ])
      );

      const reclaimRes = (await parentClient.callTool({
        name: "reclaim_event_source",
        arguments: { kind: "github_pr", repo: "dummy-org/dummy-repo", number: 616 },
      })) as CallToolResult;
      expect(reclaimRes.isError).toBeFalsy();
      expect(dataOf(reclaimRes)).toContain("reclaimed github:dummy-org/dummy-repo/pulls/616");

      listRes = (await rootClient.callTool({
        name: "list_subscriptions",
        arguments: {},
      })) as CallToolResult;
      expect(dataOf(listRes)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorId: "t1",
            resource: "github:dummy-org/dummy-repo/pulls/616",
            subscribedBy: "t1",
          }),
        ])
      );
    });

    it("accepts a direct URL-style reference source string through the tool schema", async () => {
      const { mesh } = setup();
      const rootClient = await connect(createAgentExecMcpServer(mesh, "root", "root"));

      await rootClient.callTool({
        name: "spawn_thread",
        arguments: { charter: "parent", provider: "claude", model: "claude-sonnet-4-6" },
      });
      const parentClient = await connect(createAgentExecMcpServer(mesh, "t1", "root"));
      await parentClient.callTool({
        name: "spawn_thread",
        arguments: { charter: "child", provider: "claude", model: "claude-sonnet-4-6" },
      });
      const invalidRes = (await parentClient.callTool({
        name: "delegate_event_source",
        arguments: { child_thread_id: "t2", source: "not-a-reference" },
      })) as CallToolResult;
      expect(invalidRes.isError).toBe(true);
      expect(dataOf(invalidRes)).toContain("reference must be <scheme>:<path>");

      mesh.subscribeEventSource("github:dummy-org", "root", "root");
      await rootClient.callTool({
        name: "delegate_event_source",
        arguments: {
          child_thread_id: "t1",
          source: "github:dummy-org/dummy-repo",
        },
      });

      const delegateRes = (await parentClient.callTool({
        name: "delegate_event_source",
        arguments: {
          child_thread_id: "t2",
          source: "github:dummy-org/dummy-repo/issues/42",
        },
      })) as CallToolResult;
      expect(delegateRes.isError).toBeFalsy();
      expect(dataOf(delegateRes)).toContain(
        "delegated github:dummy-org/dummy-repo/issues/42 to t2"
      );

      const listRes = (await rootClient.callTool({
        name: "list_subscriptions",
        arguments: {},
      })) as CallToolResult;
      expect(dataOf(listRes)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorId: "t2",
            resource: "github:dummy-org/dummy-repo/issues/42",
            subscribedBy: "t1",
          }),
        ])
      );
    });

    it("accepts a github_branch resource through the tool schema and round-trips it", async () => {
      const { mesh } = setup();
      const rootClient = await connect(createAgentExecMcpServer(mesh, "root", "root"));

      await rootClient.callTool({
        name: "spawn_thread",
        arguments: { charter: "parent", provider: "claude", model: "claude-sonnet-4-6" },
      });
      const parentClient = await connect(createAgentExecMcpServer(mesh, "t1", "root"));
      await parentClient.callTool({
        name: "spawn_thread",
        arguments: { charter: "child", provider: "claude", model: "claude-sonnet-4-6" },
      });
      mesh.subscribeEventSource("github:dummy-org", "root", "root");
      await rootClient.callTool({
        name: "delegate_event_source",
        arguments: {
          child_thread_id: "t1",
          kind: "github_repo",
          repo: "dummy-org/dummy-repo",
        },
      });

      // Regression for ISSUE_NUM: the tool-schema `kind` enum must accept "github_branch",
      // otherwise the Zod boundary rejects branch resources before parseEventResource runs.
      const delegateRes = (await parentClient.callTool({
        name: "delegate_event_source",
        arguments: {
          child_thread_id: "t2",
          kind: "github_branch",
          repo: "dummy-org/dummy-repo",
          ref: "refs/heads/staging",
        },
      })) as CallToolResult;
      expect(delegateRes.isError).toBeFalsy();
      expect(dataOf(delegateRes)).toContain(
        "delegated github:dummy-org/dummy-repo/branches/staging to t2"
      );

      let listRes = (await rootClient.callTool({
        name: "list_subscriptions",
        arguments: {},
      })) as CallToolResult;
      expect(dataOf(listRes)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorId: "t2",
            resource: "github:dummy-org/dummy-repo/branches/staging",
            subscribedBy: "t1",
          }),
        ])
      );

      const reclaimRes = (await parentClient.callTool({
        name: "reclaim_event_source",
        arguments: {
          kind: "github_branch",
          repo: "dummy-org/dummy-repo",
          ref: "refs/heads/staging",
        },
      })) as CallToolResult;
      expect(reclaimRes.isError).toBeFalsy();
      expect(dataOf(reclaimRes)).toContain(
        "reclaimed github:dummy-org/dummy-repo/branches/staging"
      );

      listRes = (await rootClient.callTool({
        name: "list_subscriptions",
        arguments: {},
      })) as CallToolResult;
      expect(dataOf(listRes)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorId: "t1",
            resource: "github:dummy-org/dummy-repo/branches/staging",
            subscribedBy: "t1",
          }),
        ])
      );
    });

    it("accepts the subscribable system family through the tool schema", async () => {
      const { mesh } = setup();
      const rootClient = await connect(createAgentExecMcpServer(mesh, "root", "root"));
      await rootClient.callTool({
        name: "spawn_thread",
        arguments: { charter: "system owner", provider: "claude", model: "claude-sonnet-4-6" },
      });
      mesh.subscribeEventSource("system:events", "root", "root");

      const result = (await rootClient.callTool({
        name: "delegate_event_source",
        arguments: { child_thread_id: "t1", kind: "system" },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      expect(dataOf(result)).toContain("delegated system:events to t1");
      expect(mesh.listSubscriptions()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actorId: "t1", resource: "system:events" }),
        ])
      );
    });

    it("rejects a non-held topic", async () => {
      const { mesh } = setup();
      const rootClient = await connect(createAgentExecMcpServer(mesh, "root", "root"));
      await rootClient.callTool({
        name: "spawn_thread",
        arguments: { charter: "parent", provider: "claude", model: "claude-sonnet-4-6" },
      });
      const parentClient = await connect(createAgentExecMcpServer(mesh, "t1", "root"));
      await parentClient.callTool({
        name: "spawn_thread",
        arguments: { charter: "child", provider: "claude", model: "claude-sonnet-4-6" },
      });

      const res = (await parentClient.callTool({
        name: "delegate_event_source",
        arguments: {
          child_thread_id: "t2",
          kind: "github_pr",
          repo: "dummy-org/dummy-repo",
          number: 616,
        },
      })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain("current effective owner");
    });

    it("lets root delegate from its org root source and list the assignment", async () => {
      const { mesh } = setup();
      const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
      mesh.subscribeEventSource("github:dummy-org", "root", "root");

      await client.callTool({
        name: "spawn_thread",
        arguments: { charter: "repo worker", provider: "claude", model: "claude-sonnet-4-6" },
      });

      const delegateRes = (await client.callTool({
        name: "delegate_event_source",
        arguments: {
          child_thread_id: "t1",
          kind: "github_repo",
          repo: "dummy-org/dummy-repo",
        },
      })) as CallToolResult;
      expect(delegateRes.isError).toBeFalsy();

      const listRes = (await client.callTool({
        name: "list_subscriptions",
        arguments: {},
      })) as CallToolResult;
      expect(dataOf(listRes)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actorId: "root",
            resource: "github:dummy-org",
            subscribedBy: "root",
          }),
          expect.objectContaining({
            actorId: "t1",
            resource: "github:dummy-org/dummy-repo",
            subscribedBy: "root",
          }),
        ])
      );
    });
  });
});

class FakeWakeScheduler {
  entries: {
    actorId: string;
    cronExpr: string;
    reason: string;
    priority?: "normal" | "responsive";
  }[] = [];
  failNext = false;
  async schedule(
    actorId: string,
    cronExpr: string,
    reason: string,
    priority?: "normal" | "responsive"
  ): Promise<void> {
    if (this.failNext) throw new Error(`invalid cron expression: ${cronExpr}`);
    this.entries = this.entries.filter((e) => e.actorId !== actorId);
    this.entries.push({
      actorId,
      cronExpr,
      reason,
      ...(priority ? { priority } : {}),
    });
  }
  async cancel(actorId: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.actorId !== actorId);
  }
  async list(): Promise<
    {
      actorId: string;
      cronExpr: string;
      reason: string;
      priority?: "normal" | "responsive";
    }[]
  > {
    return this.entries;
  }
}

describe("agent-execution MCP server — wake schedule (root-only, ISSUE_NUM 1c)", () => {
  it("exposes the wake tools on root ONLY when a scheduler is wired", async () => {
    const { mesh } = setup();
    const withScheduler = await connect(
      createAgentExecMcpServer(mesh, "root", "root", new FakeWakeScheduler())
    );
    const names = (await withScheduler.listTools()).tools.map((t) => t.name);
    expect(names).toContain("schedule_wake");
    expect(names).toContain("cancel_wake");
    expect(names).toContain("list_wakes");

    // No scheduler → the wake tools are absent even on root.
    const noScheduler = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    expect((await noScheduler.listTools()).tools.map((t) => t.name)).not.toContain("schedule_wake");
  });

  it("never exposes the wake tools on a non-root endpoint", async () => {
    const { mesh } = setup();
    const client = await connect(
      createAgentExecMcpServer(mesh, "worker-1", "root", new FakeWakeScheduler())
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("schedule_wake");
    expect(names).not.toContain("cancel_wake");
    expect(names).not.toContain("list_wakes");
  });

  it("schedule_wake / list_wakes / cancel_wake drive the scheduler", async () => {
    const { mesh } = setup();
    const sched = new FakeWakeScheduler();
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root", sched));

    const ok = (await client.callTool({
      name: "schedule_wake",
      arguments: {
        actor_id: "73e0b00f",
        cron_expr: "0 3 * * *",
        reason: "standing op",
        priority: "responsive",
      },
    })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    expect(sched.entries).toEqual([
      {
        actorId: "73e0b00f",
        cronExpr: "0 3 * * *",
        reason: "standing op",
        priority: "responsive",
      },
    ]);

    const listed = dataOf(
      (await client.callTool({ name: "list_wakes", arguments: {} })) as CallToolResult
    ) as { actorId: string; priority?: string }[];
    expect(listed).toEqual([
      {
        actorId: "73e0b00f",
        cronExpr: "0 3 * * *",
        reason: "standing op",
        priority: "responsive",
      },
    ]);

    await client.callTool({ name: "cancel_wake", arguments: { actor_id: "73e0b00f" } });
    expect(sched.entries).toEqual([]);

    // Suffixed wake slot (e.g. root:daily-bless-cut)
    const okSlot = (await client.callTool({
      name: "schedule_wake",
      arguments: {
        actor_id: "root:daily-bless-cut",
        cron_expr: "45 8 * * *",
        reason: "morning bless cut",
        priority: "responsive",
      },
    })) as CallToolResult;
    expect(okSlot.isError).toBeFalsy();
    expect(sched.entries).toEqual([
      {
        actorId: "root:daily-bless-cut",
        cronExpr: "45 8 * * *",
        reason: "morning bless cut",
        priority: "responsive",
      },
    ]);

    await client.callTool({ name: "cancel_wake", arguments: { actor_id: "root:daily-bless-cut" } });
    expect(sched.entries).toEqual([]);
  });

  it("schedule_wake surfaces a validation error as an error result", async () => {
    const { mesh } = setup();
    const sched = new FakeWakeScheduler();
    sched.failNext = true;
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root", sched));
    const res = (await client.callTool({
      name: "schedule_wake",
      arguments: { actor_id: "x", cron_expr: "bad", reason: "y" },
    })) as CallToolResult;
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/invalid cron/);
  });

  it("set_thread_model stages an actor's model via MCP tool", async () => {
    const { mesh, registry } = setup();
    const childId = mesh.spawn({
      charter: "worker",
      parentId: "root",
      provider: "claude",
      model: "claude-sonnet-5",
    });

    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const res = (await client.callTool({
      name: "set_actor_model",
      arguments: { actor_id: childId, model: "claude-opus-4-8" },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(registry.get(childId)?.model).toBe("claude-sonnet-5");
    expect(registry.get(childId)?.desiredModel).toBe("claude-opus-4-8");
  });

  it("set_actor_model lets the root stage its own portable provider and model", async () => {
    const { mesh, registry } = setup();
    registry.patch("root", {
      provider: "claude",
      model: "claude-opus-4-8",
      context: { type: "portable", mode: "ledger" },
    });

    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));
    const res = (await client.callTool({
      name: "set_actor_model",
      arguments: { actor_id: "root", model: "gpt-5.6-sol", provider: "codex" },
    })) as CallToolResult;

    expect(res.isError).toBeFalsy();
    expect(registry.get("root")).toMatchObject({
      provider: "claude",
      model: "claude-opus-4-8",
      desiredProvider: "codex",
      desiredModel: "gpt-5.6-sol",
    });
  });

  it("set_actor_model stages and clears effort without repeating model", async () => {
    const { mesh, registry } = setup();
    const childId = mesh.spawn({
      charter: "worker",
      parentId: "root",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
    });
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));

    const stage = (await client.callTool({
      name: "set_actor_model",
      arguments: { actor_id: childId, effort: "xhigh" },
    })) as CallToolResult;
    expect(stage.isError).toBeFalsy();
    expect(registry.get(childId)?.desiredModel).toBeUndefined();
    expect(registry.get(childId)?.desiredEffort).toBe("xhigh");

    const clear = (await client.callTool({
      name: "set_actor_model",
      arguments: { actor_id: childId, effort: null },
    })) as CallToolResult;
    expect(clear.isError).toBeFalsy();
    expect(registry.get(childId)?.desiredEffort).toBeNull();
  });

  it("set_actor_model rejects a default-effort clear that conflicts with a legacy model pin", async () => {
    const { mesh, registry } = setup();
    const childId = mesh.spawn({
      charter: "worker",
      parentId: "root",
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "medium",
    });
    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));

    const res = (await client.callTool({
      name: "set_actor_model",
      arguments: { actor_id: childId, model: "gpt-5.6-sol high", effort: null },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/conflicting reasoning efforts/);
    expect(registry.get(childId)?.desiredModel).toBeUndefined();
    expect(registry.get(childId)?.desiredEffort).toBeUndefined();
  });

  it("set_thread_model fails when an actor tries to raise its own tier", async () => {
    const { mesh } = setup();
    const childId = mesh.spawn({
      charter: "worker",
      parentId: "root",
      provider: "claude",
      model: "claude-sonnet-5",
    });

    const client = await connect(createAgentExecMcpServer(mesh, childId, "root"));
    const res = (await client.callTool({
      name: "set_actor_model",
      arguments: { actor_id: childId, model: "claude-opus-4-8" },
    })) as CallToolResult;

    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toMatch(/cannot set its own model/);
  });

  it("set_actor_model moves portable actor across providers and refuses native actors", async () => {
    const { mesh, registry } = setup();
    const portableChild = mesh.spawn({
      charter: "portable worker",
      parentId: "root",
      provider: "claude",
      model: "claude-opus-4-8",
      context: { type: "portable", mode: "ledger" },
    });
    const nativeChild = mesh.spawn({
      charter: "native worker",
      parentId: "root",
      provider: "claude",
      model: "claude-sonnet-5",
    });

    const client = await connect(createAgentExecMcpServer(mesh, "root", "root"));

    // 1. Move portable actor to antigravity
    const res1 = (await client.callTool({
      name: "set_actor_model",
      arguments: {
        actor_id: portableChild,
        model: "gemini-3.7-flash-high",
        provider: "antigravity",
        effort: "high",
      },
    })) as CallToolResult;
    expect(res1.isError).toBeFalsy();
    expect((res1.content[0] as { text: string }).text).toContain(
      `staged model gemini-3.7-flash-high, effort high, provider antigravity for ${portableChild}`
    );
    expect(registry.get(portableChild)?.provider).toBe("claude");
    expect(registry.get(portableChild)?.model).toBe("claude-opus-4-8");
    expect(registry.get(portableChild)?.desiredProvider).toBe("antigravity");
    expect(registry.get(portableChild)?.desiredModel).toBe("gemini-3.7-flash");

    // 2. Refuse move on native actor
    const res2 = (await client.callTool({
      name: "set_actor_model",
      arguments: {
        actor_id: nativeChild,
        model: "gemini-3.7-flash-high",
        provider: "antigravity",
        effort: "high",
      },
    })) as CallToolResult;
    expect(res2.isError).toBe(true);
    expect((res2.content[0] as { text: string }).text).toMatch(
      /Cannot change provider on non-portable actor/
    );
    expect(registry.get(nativeChild)?.provider).toBe("claude");
  });
});
