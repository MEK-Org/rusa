import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActorLifecycle,
  ActorLifecycleListener,
  ActorLifecycleTerminal,
} from "../actor/actor-lifecycle.js";
import { runMigrations } from "../db/migrations/runner.js";
import { createFollowerRepositories, type FollowerRepositories } from "../db/repositories/index.js";
import type { RunTermination } from "../providers/types.js";
import { createActorRuntime } from "./actor-runtime.js";
import type { ActorEvent, ProviderFactory } from "./protocol.js";

/**
 * The runtime is the one seam that hands a run's termination evidence from
 * the Actor's lifecycle to the host's receipt write (#1119). These cases drive
 * that lifecycle directly against a real host database, so a runtime that
 * drops the evidence, or bypasses the receipt store, fails here.
 */
const lifecycles = vi.hoisted(() => [] as ActorLifecycle[]);
vi.mock("../actor/actor-lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../actor/actor-lifecycle.js")>();
  return {
    ...actual,
    createActorLifecycle: (...args: Parameters<typeof actual.createActorLifecycle>) => {
      const lifecycle = actual.createActorLifecycle(...args);
      lifecycles.push(lifecycle);
      return lifecycle;
    },
  };
});

const ACTOR_ID = "runtime-actor";
const RUN_ID = "run-1";
const RESULT = { success: false, output: "provider output", exitCode: 1 };

const createProvider: ProviderFactory = () => ({
  name: "instance-fixture",
  providerName: "instance-fixture",
  run: () => Promise.reject(new Error("runs are driven through the lifecycle")),
});

describe("actor runtime terminal evidence", () => {
  let db: Database.Database;
  let cwd: string;
  let sent: ActorEvent[];

  /** Repositories as `rusa start` composes them once receipts are negotiated. */
  const receiptRepositories = (): FollowerRepositories => {
    const repos = createFollowerRepositories(db, { instanceId: "host-a" });
    const receipts = repos.runReceipts;
    if (!receipts) throw new Error("expected receipt repositories");
    return {
      ...repos,
      actorRuns: {
        ...repos.actorRuns,
        start: (opts) => {
          const id = opts.id ?? RUN_ID;
          receipts.start({ ...opts, id });
          return id;
        },
      },
    };
  };

  const localRun = () =>
    db.prepare("SELECT outcome, abandon_reason FROM actor_runs WHERE id = ?").get(RUN_ID) as {
      outcome: string | null;
      abandon_reason: string | null;
    };
  const receipts = () =>
    db.prepare("SELECT run_id FROM host_run_receipts").all() as Array<{ run_id: string }>;

  /** One run from start to the given terminal, ended while the runtime stops. */
  async function endRun(repositories: FollowerRepositories, terminal: ActorLifecycleTerminal) {
    let closed = 0;
    const runtime = createActorRuntime(
      createProvider,
      (event) => sent.push(event),
      () => closed++,
      undefined,
      repositories
    );
    runtime.dispatch({
      type: "init",
      bootstrap: { id: ACTOR_ID, cwd, modelConfig: [{ provider: "instance-fixture" }] },
    });
    await vi.waitFor(() => expect(sent.some((event) => event.type === "ready")).toBe(true));
    const lifecycle = lifecycles.at(-1);
    if (!lifecycle) throw new Error("expected the runtime's lifecycle");
    const emit = <K extends keyof ActorLifecycleListener>(
      name: K,
      payload: Parameters<NonNullable<ActorLifecycleListener[K]>>[0]
    ) => lifecycle.emit(name, payload);

    await emit("onStart", {
      actorId: ACTOR_ID,
      runId: RUN_ID,
      responsive: false,
      mode: "ordinary",
      selected: { provider: "instance-fixture", model: "fixture" },
    });
    // Stopping first keeps the result path from waiting on a leader reply, and
    // shows the runtime stays open until terminal accounting has run.
    runtime.close();
    expect(closed).toBe(0);
    await emit("onEnd", { actorId: ACTOR_ID, runId: RUN_ID, terminal });
    expect(closed).toBe(1);
    expect(sent.filter((event) => event.type === "error")).toEqual([]);
  }

  const result = (termination?: RunTermination): ActorLifecycleTerminal => ({
    kind: "result",
    result: { ...RESULT, ...(termination ? { termination } : {}) },
  });
  const abandoned = (termination?: RunTermination): ActorLifecycleTerminal => ({
    kind: "abandoned",
    reason: "coalesced",
    started: true,
    ...(termination ? { termination } : {}),
  });

  beforeEach(() => {
    lifecycles.length = 0;
    sent = [];
    db = new Database(":memory:");
    runMigrations(db);
    cwd = mkdtempSync(join(tmpdir(), "rusa-actor-runtime-"));
  });

  afterEach(() => {
    db.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  it.each([
    ["result", result("observed"), "completed"],
    ["abandonment", abandoned("observed"), "abandoned"],
  ])("closes the run and commits its receipt on an observed %s", async (_, terminal, outcome) => {
    await endRun(receiptRepositories(), terminal);
    expect(localRun().outcome).toBe(outcome);
    expect(receipts()).toEqual([{ run_id: RUN_ID }]);
  });

  it.each([
    ["an unproven result", result("unproven")],
    ["a result without evidence", result()],
    ["an unproven abandonment", abandoned("unproven")],
    ["an abandonment without evidence", abandoned()],
  ])("leaves the run open with no receipt on %s", async (_, terminal) => {
    await endRun(receiptRepositories(), terminal);
    expect(localRun().outcome).toBeNull();
    expect(receipts()).toEqual([]);
  });

  it.each([
    ["a result", result("unproven"), "completed"],
    ["an abandonment", abandoned("unproven"), "abandoned"],
  ])("closes %s locally, as before receipts, without a receipt store", async (_, terminal, outcome) => {
    const repositories = createFollowerRepositories(db);
    expect(repositories.runReceipts).toBeUndefined();
    await endRun(repositories, terminal);
    expect(localRun().outcome).toBe(outcome);
    expect(receipts()).toEqual([]);
  });
});
