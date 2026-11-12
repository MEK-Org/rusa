import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeadClosureQuery } from "../actor/head-closure.js";
import type { ObligationActivationScheduler } from "../actor/os-scheduler.js";
import { createObligationsMcpServer } from "../mcp/obligations-mcp.js";
import { ObligationValidationError } from "../obligations/obligation.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { meshWriterFor } from "./fixtures/obligation-store.js";
import {
  createInProcessMeshWriter,
  deliverMeshEffect,
  type MeshEffect,
  type MeshObligationWriter,
  type MeshWriteRepos,
  ObligationChangedError,
} from "./mesh-write-operations.js";
import { InProcessMeshWriter } from "./mesh-writer.js";
import { runMigrations } from "./migrations/runner.js";
import { ObligationRepository } from "./repositories/obligation-repository.js";
import { SqliteInboxRepository } from "./repositories/sqlite-inbox-repository.js";
import type { WriteContext } from "./write-worker-runtime.js";

// The mesh's write operations behind the writer facade (#1289), on the
// in-process writer every converted caller shares until the write worker
// takes over: what a caller's continuation may rely on once its write
// settles, and which check/act windows the operations close.

const ACTORS = ["actor-a", "actor-b"];

let db: Database.Database;
let repository: ObligationRepository;
let writer: MeshObligationWriter;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  repository = new ObligationRepository(db, (id) => ACTORS.includes(id));
  repository.setPrincipalKind((id) =>
    id === "system:mesh" ? "system" : ACTORS.includes(id) ? "actor" : undefined
  );
  writer = meshWriterFor(db, repository);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

/** Settle `promise` and return what it rejected with, or fail if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    (value) => {
      throw new Error(`expected a rejection, got ${JSON.stringify(value)}`);
    },
    (err: Error) => err
  );
}

const committedStatus = (id: string) =>
  (db.prepare("SELECT status FROM obligations WHERE id = ?").get(id) as { status: string }).status;

describe("delivery order", () => {
  it("delivers a write's effects after it commits, in order, before its caller continues", async () => {
    const order: string[] = [];
    repository.setReadyHeadListener((change) => {
      expect(db.inTransaction).toBe(false);
      order.push(`head:${change.head?.id ?? "none"}`);
    });
    repository.setStatusChangeListener(({ changes }) => {
      expect(db.inTransaction).toBe(false);
      // The status this notice reports is already the committed one.
      for (const change of changes) expect(committedStatus(change.id)).toBe(change.status);
      order.push(`status:${changes.map((change) => change.status).join(",")}`);
    });
    repository.create({ id: "head", ownerId: "actor-a", title: "head" });
    order.length = 0;

    await writer.write("obligations.setTerminalStatus", {
      id: "head",
      status: "done",
      note: null,
      resolutionRef: null,
      principal: "actor-a",
    });
    order.push("continuation");

    expect(order).toEqual(["head:none", "status:done", "continuation"]);
  });

  it("delivers writes' effects in commit order", async () => {
    const heads: string[] = [];
    repository.setReadyHeadListener((change) => heads.push(change.head?.id ?? "none"));

    const first = writer.write("obligations.create", {
      obligation: { id: "first", ownerId: "actor-a", title: "first" },
    });
    const second = writer.write("obligations.create", {
      obligation: { id: "second", ownerId: "actor-b", title: "second" },
    });
    await Promise.all([first, second]);

    expect(heads).toEqual(["first", "second"]);
  });
});

describe("ready-head sequences", () => {
  // An operation that makes two mutations, so two ready-head changes, and can
  // then fail, rolling both back.
  const ops = {
    "test.completeThenCreate": (
      context: WriteContext<MeshWriteRepos, MeshEffect>,
      input: { readonly complete: string; readonly create: string; readonly fail: boolean }
    ) =>
      context.repos.obligations.inWriteOperation(context, () => {
        const { obligations } = context.repos;
        obligations.setTerminalStatus(input.complete, "done", null, null, "actor-a");
        obligations.create({ id: input.create, ownerId: "actor-a", title: input.create });
        if (input.fail) throw new Error("the operation failed after its mutations");
      }),
  };

  it("consumes no sequence for a write that rolls back, and numbers one write's changes consecutively", async () => {
    repository.installHistoryCapture();
    const repos: MeshWriteRepos = {
      obligations: repository,
      inbox: new SqliteInboxRepository(db),
      actors: { get: () => undefined },
      actorRuns: { completedFocusEntryCounts: () => new Map() },
    };
    const testWriter = new InProcessMeshWriter<MeshWriteRepos, MeshEffect, typeof ops>(
      db,
      repos,
      ops,
      (effect) => deliverMeshEffect(repos, effect)
    );
    const sequences: Array<[string, number]> = [];
    repository.setReadyHeadListener((change) =>
      sequences.push([change.head?.id ?? "none", change.sequence])
    );
    repository.create({ id: "base", ownerId: "actor-a", title: "base" });
    expect(sequences).toEqual([["base", 1]]);

    const failed = await rejection(
      testWriter.write("test.completeThenCreate", { complete: "base", create: "lost", fail: true })
    );
    expect(failed.message).toBe("the operation failed after its mutations");
    expect(repository.get("lost")).toBeNull();
    expect(committedStatus("base")).toBe("ready");
    expect(sequences).toEqual([["base", 1]]);

    await testWriter.write("test.completeThenCreate", {
      complete: "base",
      create: "next",
      fail: false,
    });
    expect(sequences).toEqual([
      ["base", 1],
      ["none", 2],
      ["next", 3],
    ]);

    // A mutation outside the writer continues the same owner's sequence.
    repository.setTerminalStatus("next", "done", null, null, "actor-a");
    expect(sequences.at(-1)).toEqual(["none", 4]);
  });
});

describe("check and act in one operation", () => {
  async function connect(server: ReturnType<typeof createObligationsMcpServer>): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  const text = (result: CallToolResult) => {
    const first = result.content[0];
    return first && first.type === "text" ? first.text : "";
  };

  it("decides authority after matcher validation, against the obligation as it stands then", async () => {
    // Another write reassigns the obligation while the tool awaits matcher
    // validation. The authority check runs after that await, with nothing
    // awaited between it and the commit, so it sees the new owner.
    repository.create({ id: "contested", ownerId: "actor-a", title: "contested" });
    const client = await connect(
      createObligationsMcpServer({ obligations: repository, writer }, "actor-a", {
        validateCompletionMatcher: async () => {
          await writer.write("obligations.reassign", {
            id: "contested",
            ownerId: "actor-b",
            principal: "system:mesh",
          });
        },
      })
    );

    const result = (await client.callTool({
      name: "set_completion_matcher",
      arguments: {
        id: "contested",
        matcher: { kind: "pr_merged", pr: "github:MEK-Org/rusa/pulls/1" },
      },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("not authorized to manage this obligation");
    const contested = repository.require("contested");
    expect(contested.ownerId).toBe("actor-b");
    expect(contested.completionMatcher).toBeNull();
  });

  it("applies an owner precondition inside the operation", async () => {
    repository.create({ id: "moved", ownerId: "actor-a", title: "moved" });
    await writer.write("obligations.reassign", {
      id: "moved",
      ownerId: "actor-b",
      principal: "system:mesh",
    });

    const refused = await rejection(
      writer.write("obligations.setCheckpoint", {
        id: "moved",
        checkpoint: "stale",
        principal: "actor-a",
        expectedOwnerId: "actor-a",
      })
    );
    expect(refused).toBeInstanceOf(ObligationChangedError);
    expect(refused).toBeInstanceOf(ObligationValidationError);
    expect(repository.require("moved").checkpoint).toBeNull();

    const written = await writer.write("obligations.setCheckpoint", {
      id: "moved",
      checkpoint: "current",
      principal: "actor-b",
      expectedOwnerId: "actor-b",
    });
    expect(written.checkpoint).toBe("current");
  });

  it("applies a responsive refusal only when the parent is not already responsive when it commits", async () => {
    repository.create({ id: "plain-parent", ownerId: "actor-a", title: "plain parent" });
    repository.create({
      id: "hot-parent",
      ownerId: "actor-a",
      title: "hot parent",
      responsive: true,
    });

    const refused = await rejection(
      writer.write("obligations.create", {
        obligation: {
          id: "new-branch",
          ownerId: "actor-a",
          title: "new branch",
          parentId: "plain-parent",
          responsive: true,
        },
        responsiveRefusal: "not authorized to start a responsive branch",
      })
    );
    expect(refused.message).toBe("not authorized to start a responsive branch");
    expect(repository.get("new-branch")).toBeNull();

    const inherited = await writer.write("obligations.create", {
      obligation: {
        id: "inside-branch",
        ownerId: "actor-a",
        title: "inside branch",
        parentId: "hot-parent",
        responsive: true,
      },
      responsiveRefusal: "not authorized to start a responsive branch",
    });
    expect(inherited.effectiveResponsive).toBe(true);
  });

  it("decides a reparent's promotion against committed state", async () => {
    repository.create({ id: "hot", ownerId: "actor-a", title: "hot", responsive: true });
    repository.create({ id: "cold", ownerId: "actor-a", title: "cold" });
    repository.create({ id: "work", ownerId: "actor-a", title: "work" });

    const refused = await rejection(
      writer.write("obligations.reparent", {
        id: "work",
        parentId: "hot",
        principal: "actor-a",
        promotion: { expectedOwnerId: "actor-a", refusal: "not authorized to promote" },
      })
    );
    expect(refused.message).toBe("not authorized to promote");
    expect(repository.require("work").parentId).toBeNull();

    // No promotion, so neither the refusal nor the owner applies.
    const moved = await writer.write("obligations.reparent", {
      id: "work",
      parentId: "cold",
      principal: "actor-a",
      promotion: { expectedOwnerId: "actor-b", refusal: "not authorized to promote" },
    });
    expect(moved.parentId).toBe("cold");

    const changed = await rejection(
      writer.write("obligations.reparent", {
        id: "work",
        parentId: "hot",
        principal: "actor-a",
        promotion: { expectedOwnerId: "actor-b", refusal: null },
      })
    );
    expect(changed).toBeInstanceOf(ObligationChangedError);
    expect(repository.require("work").parentId).toBe("cold");
  });
});

describe("listener failures", () => {
  it("never reject a committed write, and are retried from committed state on a later delivery", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const announced: Array<{ id: string; actingPrincipal: string }> = [];
    let fail = true;
    repository.setReadyHeadListener(() => {});
    repository.setResponsiveReadyListener((obligation, actingPrincipal) => {
      if (fail) throw new Error("inbox is unavailable");
      announced.push({ id: obligation.id, actingPrincipal });
    });
    repository.create({ id: "head", ownerId: "actor-a", title: "head", priority: 1 });
    repository.create({
      id: "responsive-head",
      ownerId: "actor-a",
      title: "responsive head",
      priority: 2,
      responsive: true,
    });

    // The failed delivery belongs to a write that committed: it resolves.
    const hotfix = await writer.write("obligations.create", {
      obligation: {
        id: "hotfix",
        ownerId: "actor-a",
        title: "hotfix",
        priority: 3,
        responsive: true,
      },
    });
    expect(hotfix.id).toBe("hotfix");
    expect(announced).toEqual([]);

    // The retry lives where delivery does and re-reads committed rows, so the
    // writer is told nothing: any later delivery repairs it.
    fail = false;
    await writer.write("obligations.create", {
      obligation: { id: "other", ownerId: "actor-b", title: "other" },
    });
    expect(announced).toEqual([{ id: "hotfix", actingPrincipal: "system:mesh" }]);
  });
});

describe("host timers", () => {
  function fakeScheduler(onSchedule: (id: string) => void): ObligationActivationScheduler {
    return {
      instanceId: "test",
      scheduleObligationActivation: (id) => onSchedule(id),
      cancelObligationActivation: () => {},
      listObligationActivations: () => [],
      canScheduleAt: () => true,
    };
  }

  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

  it("arms a write's timer when its effect is delivered, against the committed row", async () => {
    repository.create({ id: "nap", ownerId: "actor-a", title: "nap" });
    const armed: Array<{ id: string; snoozedUntil: string | null }> = [];
    repository.setOsScheduler(
      fakeScheduler((id) => {
        expect(db.inTransaction).toBe(false);
        const row = db.prepare("SELECT snoozed_until FROM obligations WHERE id = ?").get(id) as {
          snoozed_until: string | null;
        };
        armed.push({ id, snoozedUntil: row.snoozed_until });
      })
    );

    const until = inAnHour();
    const snoozed = await writer.write("obligations.setSnooze", {
      id: "nap",
      until,
      principal: "actor-a",
      expectedOwnerId: "actor-a",
    });

    expect(armed).toEqual([{ id: "nap", snoozedUntil: snoozed.snoozedUntil }]);
    expect(snoozed.snoozedUntil).not.toBeNull();
    expect(repository.scheduleErrorFor("nap")).toBeNull();
  });

  it("reports a timer that failed to arm as the snooze tool's warning", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      repository.create({ id: "nap", ownerId: "actor-a", title: "nap" });
      repository.setOsScheduler(
        fakeScheduler(() => {
          throw new Error("at is unavailable");
        })
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await createObligationsMcpServer({ obligations: repository, writer }, "actor-a").connect(
        serverTransport
      );
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(clientTransport);

      const result = (await client.callTool({
        name: "set_snooze",
        arguments: { id: "nap", until: inAnHour() },
      })) as CallToolResult;

      expect(result.isError).toBeFalsy();
      const first = result.content[0];
      const body = JSON.parse(first && first.type === "text" ? first.text : "{}") as {
        warning?: string;
      };
      expect(body.warning).toContain("at is unavailable");
      expect(repository.require("nap").snoozedUntil).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a listener's own writes during delivery (r4545135121)", () => {
  // Listeners record attention with synchronous appends on the main
  // connection, never through the writer. Delivery runs on the main thread in
  // both writers, so such an append commits before the next effect is
  // delivered and before the write's caller continues, whichever writer
  // committed the write.
  it("is visible to later effects of the same write and to its caller's continuation", async () => {
    const inbox = new SqliteInboxRepository(db);
    const seenByStatusListener: number[] = [];
    repository.setReadyHeadListener((change) => {
      inbox.append([
        {
          actorId: change.ownerId,
          source: "obligation-ready-head",
          payload: { type: "obligation.ready_head", sequence: change.sequence },
        },
      ]);
    });
    repository.setStatusChangeListener(() =>
      seenByStatusListener.push(inbox.countUnhandled("actor-a"))
    );
    repository.create({ id: "head", ownerId: "actor-a", title: "head" });
    repository.create({ id: "behind", ownerId: "actor-a", title: "behind" });
    const before = inbox.countUnhandled("actor-a");
    seenByStatusListener.length = 0;

    await writer.write("obligations.setTerminalStatus", {
      id: "head",
      status: "done",
      note: null,
      resolutionRef: null,
      principal: "actor-a",
    });

    expect(seenByStatusListener).toEqual([before + 1]);
    expect(inbox.countUnhandled("actor-a")).toBe(before + 1);
  });
});

describe("inbox marks and the checks they depend on (#1289)", () => {
  const HOUR = 60 * 60 * 1000;
  let clock: number;
  let inboxDb: Database.Database;
  let obligations: ObligationRepository;
  let inbox: SqliteInboxRepository;
  let actors: InMemoryActorRepository;
  let focusCounts: Map<string, Map<string, number>>;
  let inboxWriter: MeshObligationWriter;

  beforeEach(() => {
    clock = Date.parse("2026-07-01T00:00:00.000Z");
    inboxDb = new Database(":memory:");
    runMigrations(inboxDb);
    obligations = new ObligationRepository(
      inboxDb,
      (id) => ACTORS.includes(id),
      () => clock
    );
    obligations.setPrincipalKind((id) =>
      id === "system:mesh" ? "system" : ACTORS.includes(id) ? "actor" : undefined
    );
    inbox = new SqliteInboxRepository(inboxDb);
    actors = new InMemoryActorRepository();
    focusCounts = new Map();
    inboxWriter = createInProcessMeshWriter(inboxDb, {
      obligations,
      inbox,
      actors,
      actorRuns: {
        completedFocusEntryCounts: (actorId) => focusCounts.get(actorId) ?? new Map(),
      },
    });
  });

  afterEach(() => {
    inboxDb.close();
  });

  /** actor-a's run selected `heads` while it owned them, with no checkpoint. */
  const closureOf = (...heads: string[]): HeadClosureQuery => ({
    actorId: "actor-a",
    heads,
    baseline: {
      selectedHeads: new Map(
        heads.map((id) => [
          id,
          { ownerId: "actor-a", checkpoint: null, checkpointAt: null, checkpointBy: null },
        ])
      ),
      preExistingChildIds: new Map(),
      preExistingPrerequisiteIds: new Map(),
    },
    rootId: null,
    retiring: new Set(),
  });

  const appendTo = (actorId: string, id: string) =>
    inbox.append([{ id, actorId, source: "chat", payload: { type: "mesh.message" } }]);

  const committedSnooze = (id: string) =>
    (
      inboxDb.prepare("SELECT snoozed_until FROM obligations WHERE id = ?").get(id) as {
        snoozed_until: string | null;
      }
    ).snoozed_until;

  it("decides closure against the state the mark commits on, not when it was asked", async () => {
    obligations.create({ id: "closes", ownerId: "actor-a", title: "closes" });
    obligations.create({ id: "reopens", ownerId: "actor-a", title: "reopens" });
    obligations.writeSnooze("reopens", new Date(clock + HOUR).toISOString(), "actor-a");
    appendTo("actor-a", "for-closes");
    appendTo("actor-a", "for-reopens");
    // Both questions are asked first: "closes" is still ready, "reopens" is
    // snoozed. Then other writes change both before either mark runs.
    const closesQuestion = closureOf("closes");
    const reopensQuestion = closureOf("reopens");
    await inboxWriter.write("obligations.setTerminalStatus", {
      id: "closes",
      status: "done",
      note: null,
      resolutionRef: null,
      principal: "actor-a",
    });
    await inboxWriter.write("obligations.setSnooze", {
      id: "reopens",
      until: null,
      principal: "actor-a",
    });

    const marked = await inboxWriter.write("inbox.markHandled", {
      actorId: "actor-a",
      entryIds: ["for-closes"],
      closure: closesQuestion,
    });
    const refused = await inboxWriter.write("inbox.markHandled", {
      actorId: "actor-a",
      entryIds: ["for-reopens"],
      closure: reopensQuestion,
    });

    expect(marked.refused).toBeNull();
    expect(inbox.read("actor-a", "for-closes")?.handledAt).toBeTruthy();
    expect(refused.refused?.map((shortfall) => shortfall.obligationId)).toEqual(["reopens"]);
    expect(inbox.read("actor-a", "for-reopens")?.handledAt).toBeFalsy();
  });

  it("keeps the due snoozes it cleared when closure refuses the mark", async () => {
    // Clearing a due snooze is the mesh's normalization of state that already
    // lapsed, so a refusal commits it rather than rolling it back, as the
    // check did when it ran outside the write.
    obligations.create({ id: "lapsed", ownerId: "actor-a", title: "lapsed" });
    obligations.writeSnooze("lapsed", new Date(clock + HOUR).toISOString(), "actor-a");
    appendTo("actor-a", "for-lapsed");
    clock += 2 * HOUR;

    const result = await inboxWriter.write("inbox.markHandled", {
      actorId: "actor-a",
      entryIds: ["for-lapsed"],
      closure: closureOf("lapsed"),
    });

    expect(result.refused).toEqual([
      expect.objectContaining({ obligationId: "lapsed", reason: "obligation is still ready" }),
    ]);
    expect(committedSnooze("lapsed")).toBeNull();
    expect(obligations.listHistory("lapsed")[0]).toMatchObject({
      mutationKind: "snooze",
      actingPrincipal: "system:mesh",
    });
    expect(inbox.read("actor-a", "for-lapsed")?.handledAt).toBeFalsy();
  });

  it("rolls the cleared snoozes back with the mark when the write itself fails", async () => {
    // Closure passes once the lapsed snooze is cleared: the head waits on a
    // prerequisite added during the run. The mark then fails, so the whole
    // write rolls back, the clearing included.
    obligations.create({ id: "gated", ownerId: "actor-a", title: "gated" });
    obligations.create({ id: "gate", ownerId: "actor-b", title: "gate" });
    obligations.addPrerequisite("gated", "gate", "actor-a");
    const until = new Date(clock + HOUR).toISOString();
    obligations.writeSnooze("gated", until, "actor-a");
    clock += 2 * HOUR;

    await expect(
      inboxWriter.write("inbox.markHandled", {
        actorId: "actor-a",
        entryIds: ["missing"],
        closure: closureOf("gated"),
      })
    ).rejects.toThrow("inbox entry not found");

    expect(committedSnooze("gated")).toBe(until);
  });

  it.each([
    ["a missing entry", ["missing"], "inbox entry not found"],
    ["another actor's entry", ["for-b"], "inbox entry not found"],
    ["a repeated id", ["for-lapsed", "for-lapsed"], "1 to 100 unique entry ids"],
  ])("throws for %s before closure could refuse and commit (#1289)", async (_, entryIds, message) => {
    // Closure would refuse here and commit the cleared snooze, so the ids
    // must be checked first for an invalid request to commit nothing.
    obligations.create({ id: "lapsed", ownerId: "actor-a", title: "lapsed" });
    const until = new Date(clock + HOUR).toISOString();
    obligations.writeSnooze("lapsed", until, "actor-a");
    appendTo("actor-a", "for-lapsed");
    appendTo("actor-b", "for-b");
    clock += 2 * HOUR;

    await expect(
      inboxWriter.write("inbox.markHandled", {
        actorId: "actor-a",
        entryIds,
        closure: closureOf("lapsed"),
      })
    ).rejects.toThrow(message);

    expect(committedSnooze("lapsed")).toBe(until);
  });

  it("commits the due snoozes a run-end closure check cleared with its answer (r4547468384)", async () => {
    obligations.create({ id: "lapsed", ownerId: "actor-a", title: "lapsed" });
    obligations.writeSnooze("lapsed", new Date(clock + HOUR).toISOString(), "actor-a");
    clock += 2 * HOUR;

    const shortfalls = await inboxWriter.write("obligations.closureShortfalls", {
      closure: closureOf("lapsed"),
    });

    expect(shortfalls).toEqual([
      expect.objectContaining({ obligationId: "lapsed", reason: "obligation is still ready" }),
    ]);
    expect(committedSnooze("lapsed")).toBeNull();
    expect(obligations.listHistory("lapsed")[0]).toMatchObject({
      mutationKind: "snooze",
      actingPrincipal: "system:mesh",
    });
  });

  it("rolls a run-end closure check's cleared snoozes back when it throws (r4547468384)", async () => {
    obligations.create({ id: "lapsed", ownerId: "actor-a", title: "lapsed" });
    const until = new Date(clock + HOUR).toISOString();
    obligations.writeSnooze("lapsed", until, "actor-a");
    clock += 2 * HOUR;
    // Evaluation fails after the snoozes are cleared, inside the write.
    const expire = obligations.expireDueSnoozes.bind(obligations);
    vi.spyOn(obligations, "expireDueSnoozes").mockImplementation((...args) => {
      expire(...args);
      throw new Error("closure evaluation failed");
    });

    await expect(
      inboxWriter.write("obligations.closureShortfalls", { closure: closureOf("lapsed") })
    ).rejects.toThrow("closure evaluation failed");

    expect(committedSnooze("lapsed")).toBe(until);
  });

  it("carries a seen mark's named entries across the writer boundary (r4547468362)", async () => {
    appendTo("actor-a", "named");
    appendTo("actor-a", "unnamed");

    const seen = await inboxWriter.write("inbox.markSeen", {
      actorId: "actor-a",
      entryIds: ["named"],
    });

    // The repository's own filters are pinned in sqlite-inbox-repository.test.ts.
    expect(seen.map((entry) => entry.id)).toEqual(["named"]);
    expect(inbox.read("actor-a", "unnamed")?.seenAt).toBeNull();
  });

  it("delivers a mark's handled notice after it commits, before its caller continues", async () => {
    appendTo("actor-a", "plain");
    const order: string[] = [];
    inbox.onItemsHandled((actorId, results) => {
      expect(inboxDb.inTransaction).toBe(false);
      expect(inbox.read(actorId, results[0]?.id ?? "")?.handledAt).toBeTruthy();
      order.push(`handled:${results.map((result) => result.id).join(",")}`);
    });

    await inboxWriter.write("inbox.markHandled", { actorId: "actor-a", entryIds: ["plain"] });
    order.push("continuation");

    expect(order).toEqual(["handled:plain", "continuation"]);
  });

  describe("a parent clearing its child's exhausted work", () => {
    const clearance = (note: string, entryIds: string[]) => ({
      callerId: "parent",
      childId: "child",
      entryIds,
      note,
      rootId: null,
    });

    beforeEach(() => {
      for (const [id, parentId] of [
        ["parent", "root"],
        ["other-parent", "root"],
        ["child", "parent"],
      ] as const) {
        actors.upsert({
          id,
          charter: id,
          parentId,
          status: "active",
          createdAt: "2026-07-01T00:00:00.000Z",
        });
      }
      appendTo("child", "spent");
      focusCounts.set("child", new Map([["spent", 2]]));
    });

    it("decides authority against what committed before it: the first clearance wins", async () => {
      const [marked, released] = await Promise.allSettled([
        inboxWriter.write("inbox.markChildHandled", clearance("first", ["spent"])),
        inboxWriter.write("inbox.releaseChildSelectionLock", clearance("second", ["spent"])),
      ]);

      expect(marked.status).toBe("fulfilled");
      expect(released).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: "inbox entry already handled: spent" }),
      });
      expect(inbox.read("child", "spent")?.handledNote).toBe(
        "Marked handled by parent (parent): first"
      );
      // The refused release appended no replacement.
      expect(inbox.list("child", { status: "all" }).entries.map((entry) => entry.id)).toEqual([
        "spent",
      ]);
    });

    it("refuses a parent the child no longer has", async () => {
      const child = actors.get("child");
      if (!child) throw new Error("expected the child record");
      actors.upsert({ ...child, parentId: "other-parent" });

      await expect(
        inboxWriter.write("inbox.markChildHandled", clearance("too late", ["spent"]))
      ).rejects.toThrow("Only the parent thread (other-parent) can clear exhausted inbox work");
      expect(inbox.read("child", "spent")?.handledAt).toBeFalsy();
    });

    it.each([
      ["by its id", "configured-root"],
      ["by the legacy alias", "root"],
    ])("refuses clearing the configured root %s even when its record names a parent (#1289)", async (_, childId) => {
      // Nothing makes the configured root's durable record carry a null
      // parentId, so the rootId comparison is what refuses this, not the
      // parentless check: without it the named parent would clear root's work.
      actors.upsert({
        id: "configured-root",
        charter: "root",
        parentId: "parent",
        status: "active",
        createdAt: "2026-07-01T00:00:00.000Z",
      });
      appendTo("configured-root", "root-spent");
      focusCounts.set("configured-root", new Map([["root-spent", 2]]));

      await expect(
        inboxWriter.write("inbox.markChildHandled", {
          ...clearance("not root's parent", ["root-spent"]),
          childId,
          rootId: "configured-root",
        })
      ).rejects.toThrow(/Root has no parent in the mesh/);
      expect(inbox.read("configured-root", "root-spent")?.handledAt).toBeFalsy();
    });

    it("refuses entries that have not exhausted bounded recovery", async () => {
      focusCounts.set("child", new Map([["spent", 1]]));

      await expect(
        inboxWriter.write("inbox.releaseChildSelectionLock", clearance("early", ["spent"]))
      ).rejects.toThrow(/has not exhausted bounded recovery/);
      expect(inbox.read("child", "spent")?.handledAt).toBeFalsy();
    });
  });
});
