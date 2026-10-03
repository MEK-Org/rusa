import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ActorFactoryContext, ActorMeshOptions } from "../../actor/actor-mesh.js";
import { EXPERIMENT_ADMIN_CAPABILITY } from "../../actor/administrative-capabilities.js";
import { COMPUTER_USE_CAPABILITY, ComputerUseLock } from "../../actor/computer-use-lock.js";
import {
  InMemoryExperimentEnrollmentStore,
  STRICT_OBLIGATION_HANDLING_EXPERIMENT,
} from "../../actor/experiments.js";
import { ProviderPacer } from "../../actor/provider-pacer.js";
import { runMigrations } from "../../db/migrations/runner.js";
import { ObligationRepository } from "../../db/repositories/obligation-repository.js";
import { ClaudeProvider } from "../../providers/claude.js";
import { FollowerInstance } from "./follower-instance.js";
import { createHarness, waitUntil } from "./harness.js";
import type { ActorEvent, LeaderCommand, ProviderFactory } from "./protocol.js";

const instances: ReturnType<typeof createHarness>[] = [];
const dirs: string[] = [];
function setup(
  options: {
    delayMs?: number;
    failInit?: boolean;
    pacer?: ProviderPacer;
    startupTimeoutMs?: number;
    stateStaleTimeoutMs?: number;
    providerFactory?: ProviderFactory;
    isHalted?: (provider?: string, model?: string) => boolean;
    onEvent?: (actorId: string, event: ActorEvent) => void;
    maxConcurrent?: number;
    obligations?: ActorMeshOptions["obligations"];
    experimentEnrollments?: ActorMeshOptions["experimentEnrollments"];
  } = {}
) {
  const cwd = mkdtempSync(join(tmpdir(), "rusa-follower-unit-"));
  dirs.push(cwd);
  const h = createHarness({
    cwd,
    delayMs: options.delayMs ?? 25,
    pacer: options.pacer,
    startupTimeoutMs: options.startupTimeoutMs,
    stateStaleTimeoutMs: options.stateStaleTimeoutMs,
    isHalted: options.isHalted,
    onEvent: options.onEvent,
    maxConcurrent: options.maxConcurrent,
    obligations: options.obligations,
    experimentEnrollments: options.experimentEnrollments,
    providerFactory: options.failInit
      ? () => {
          throw new Error("test provider initialization failed");
        }
      : options.providerFactory,
  });
  instances.push(h);
  return h;
}

function grantComputerUse(h: ReturnType<typeof createHarness>, actorId: string): void {
  h.capabilityGrants.grant({
    actorId,
    capability: COMPUTER_USE_CAPABILITY,
    grantedBy: "root",
    grantedAt: "2026-09-25T00:00:00Z",
  });
}

afterEach(async () => {
  for (const h of instances.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Holds each run until the test releases its charter, so capability-boundary
 * tests order events explicitly instead of relying on wall-clock margins.
 */
function releasableCapabilityProvider() {
  const gates = new Map<string, { promise: Promise<void>; release: () => void }>();
  const gate = (charter: string) => {
    let entry = gates.get(charter);
    if (!entry) {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      entry = { promise, release };
      gates.set(charter, entry);
    }
    return entry;
  };
  const factory: ProviderFactory = (bridge, _options, selected) => ({
    name: "instance-fixture",
    providerName: "instance-fixture",
    model: selected?.model,
    async run(run) {
      const prompt = JSON.parse(run.prompt) as { charter: string; parentId: string };
      await new Promise<void>((resolve, reject) => {
        run.signal?.addEventListener("abort", () => reject(run.signal?.reason), { once: true });
        void gate(prompt.charter).promise.then(resolve);
      });
      await bridge.sendMessage(prompt.parentId, prompt.charter);
      return {
        success: true,
        output: prompt.charter,
        exitCode: 0,
        sessionId: run.session?.id,
        model: selected?.model,
      };
    },
  });
  return { factory, release: (charter: string) => gate(charter).release() };
}

/**
 * Hold normal admissions in provider pacing until the test releases them, so
 * a retained ticket's drop is ordered by the test rather than by a wall-clock
 * pacing window (#613).
 */
function heldPacer() {
  const holdMs = 3_600_000;
  let skewMs = 0;
  const pacer = new ProviderPacer(0, () => Date.now() + skewMs);
  pacer.deferUntil(Date.now() + holdMs);
  return {
    pacer,
    release: () => {
      skewMs = 2 * holdMs;
      // Re-arm the lane's timer against the advanced clock.
      pacer.deferUntil(0);
    },
  };
}

type Harness = ReturnType<typeof createHarness>;

async function flap(h: Harness, id: string): Promise<void> {
  h.remote.close();
  await h.runtime(id).exited;
}

/** Reattach as a follower that never reclaims the ticket the leader retained. */
async function reattachWithoutClaim(h: Harness, id: string): Promise<void> {
  const reconnect = h.reconnect();
  const dispatch = h.follower.dispatch.bind(h.follower);
  h.follower.dispatch = (envelope) => {
    if (envelope.message.type === "init") envelope.message.bootstrap.resumeAdmission = false;
    dispatch(envelope);
  };
  h.runtime(id).attachHost(reconnect.createHost(id));
  await expect(h.runtime(id).ready).resolves.toBe(process.pid);
}

function queuedRuns(h: Harness, id: string) {
  return h.events.flatMap(({ actorId, event }) =>
    actorId === id && event.type === "queued" ? [event] : []
  );
}

function runStarts(h: Harness, id: string) {
  return h.events.flatMap(({ actorId, event }) =>
    actorId === id && event.type === "runStart" ? [event.runId] : []
  );
}

function runResults(h: Harness, id: string) {
  return h.events.filter(({ actorId, event }) => actorId === id && event.type === "result");
}

function abandonedRuns(h: Harness, id: string) {
  return h.meshEvents.filter((event) => event.kind === "run_abandoned" && event.actorId === id);
}

describe("monolithic follower instance", () => {
  it("#866 forwards exact real follower argv to leader and rejects stale receipts", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "rusa-follower-prompt-"));
    dirs.push(cwd);
    const dump = join(cwd, "argv.json");
    const cli = join(cwd, "synthetic-cli");
    writeFileSync(
      cli,
      `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({type:"result", subtype:"success", result:"synthetic result"}));
`
    );
    chmodSync(cli, 0o755);
    const h = setup({
      providerFactory: () => new ClaudeProvider("fixture", { cliCommand: cli }),
    });
    const id = h.spawn("Synthetic charter ✓\n  indentation");
    await waitUntil(() => h.promptEvents.length === 1 && existsSync(dump));
    const event = h.promptEvents[0];
    const argv = JSON.parse(readFileSync(dump, "utf8")) as string[];
    expect(event).toMatchObject({ actorId: id, runId: runStarts(h, id)[0], provider: "claude" });
    expect(event?.prompt).toBe(argv[argv.indexOf("-p") + 1]);
    expect(event?.prompt).toContain("Synthetic charter");
    expect(
      JSON.stringify(h.meshEvents.filter((entry) => entry.kind === "run_start"))
    ).not.toContain(JSON.stringify(event?.prompt));
    h.remote.receive({
      actorId: id,
      message: { type: "runPrompt", runId: "stale-run", prompt: "stale", provider: "fixture" },
    });
    await delay(0);
    expect(h.promptEvents).toHaveLength(1);
  });

  it("serializes three computer-capable actors without holding unrelated actors", async () => {
    // Provider admission happens before the per-instance lock. Give all four
    // runs capacity here so the unrelated control proves the lock — rather
    // than global provider capacity — is what keeps the other capable actors
    // queued.
    let activeComputerRuns = 0;
    let maxActiveComputerRuns = 0;
    const h = setup({
      maxConcurrent: 4,
      providerFactory: (bridge, _options, selected) => ({
        name: "instance-fixture",
        providerName: "instance-fixture",
        model: selected?.model,
        async run(run) {
          const prompt = JSON.parse(run.prompt) as { charter: string; parentId: string };
          const controlsComputer = prompt.charter !== "Read-only work";
          if (controlsComputer) {
            activeComputerRuns++;
            maxActiveComputerRuns = Math.max(maxActiveComputerRuns, activeComputerRuns);
          }
          try {
            await delay(400, undefined, { signal: run.signal });
            await bridge.sendMessage(prompt.parentId, prompt.charter);
            return {
              success: true,
              output: prompt.charter,
              exitCode: 0,
              sessionId: run.session?.id,
              model: selected?.model,
            };
          } finally {
            if (controlsComputer) activeComputerRuns--;
          }
        },
      }),
    });
    const long = h.spawn("Long computer run");
    grantComputerUse(h, long);
    await waitUntil(() => h.runtime(long).isRunning);
    const short = h.spawn("Short computer run");
    grantComputerUse(h, short);
    const third = h.spawn("Third computer run");
    grantComputerUse(h, third);
    const unrelated = h.spawn("Read-only work");

    await waitUntil(() => h.runtime(unrelated).isRunning);
    expect(h.runtime(short).isRunning).toBe(false);
    expect(h.runtime(third).isRunning).toBe(false);
    await waitUntil(() => h.events.filter((event) => event.event.type === "result").length === 4);
    // The leader can book a terminal result asynchronously after a follower's
    // provider has returned. Count the actual provider runs rather than use
    // that cross-process bookkeeping order as a proxy for computer control.
    expect(maxActiveComputerRuns).toBe(1);
    expect(h.failures).toEqual([]);
  });

  it("reads a newly granted computer-use capability at provider admission", async () => {
    // Record which actors enter the instance lock, so the test waits for the
    // target's admission to reach it instead of inferring that from timing.
    const lockEntries: string[] = [];
    const originalGate = ComputerUseLock.prototype.gate;
    const gateSpy = vi.spyOn(ComputerUseLock.prototype, "gate").mockImplementation(function (
      this: ComputerUseLock,
      actorId,
      ...rest
    ) {
      lockEntries.push(actorId);
      return originalGate.call(this, actorId, ...rest);
    } as typeof originalGate);
    onTestFinished(() => gateSpy.mockRestore());
    const provider = releasableCapabilityProvider();
    const h = setup({
      delayMs: 0,
      maxConcurrent: 2,
      providerFactory: provider.factory,
    });
    const holder = h.spawn("long computer holder");
    grantComputerUse(h, holder);
    await waitUntil(() => h.runtime(holder).isRunning);
    const blocker = h.spawn("short provider blocker");
    await waitUntil(() => h.runtime(blocker).isRunning);
    const target = h.spawn("late capability target");
    await waitUntil(() => h.runtime(target).isQueued);

    h.capabilityGrants.grant({
      actorId: target,
      capability: COMPUTER_USE_CAPABILITY,
      grantedBy: "root",
      grantedAt: "2026-09-26T00:00:00Z",
    });
    provider.release("short provider blocker");
    // The grant happened after beforeRun, while the target paced, so its
    // provider admission must still send it into the lock. Bound the wait under
    // the test timeout so a run admitted without the lock fails here.
    await waitUntil(() => lockEntries.includes(target), 3_000);
    // The target is queued behind the holder, which the test has not released.
    expect(
      h.events.some((event) => event.actorId === target && event.event.type === "runStart")
    ).toBe(false);
    provider.release("long computer holder");
    await waitUntil(() =>
      h.events.some((event) => event.actorId === holder && event.event.type === "result")
    );
    await waitUntil(() =>
      h.events.some((event) => event.actorId === target && event.event.type === "runStart")
    );

    const resultIndex = h.events.findIndex(
      (event) => event.actorId === holder && event.event.type === "result"
    );
    const startIndex = h.events.findIndex(
      (event) => event.actorId === target && event.event.type === "runStart"
    );
    expect(startIndex).toBeGreaterThan(resultIndex);
    provider.release("late capability target");
    expect(h.failures).toEqual([]);
  });

  it("does not retain a revoked computer-use capability through provider pacing", async () => {
    const provider = releasableCapabilityProvider();
    const h = setup({
      delayMs: 0,
      maxConcurrent: 2,
      providerFactory: provider.factory,
    });
    const holder = h.spawn("long computer holder");
    grantComputerUse(h, holder);
    await waitUntil(() => h.runtime(holder).isRunning);
    const blocker = h.spawn("short provider blocker");
    await waitUntil(() => h.runtime(blocker).isRunning);
    const target = h.spawn("revoked capability target");
    grantComputerUse(h, target);
    await waitUntil(() => h.runtime(target).isQueued);

    h.capabilityGrants.revoke(target, COMPUTER_USE_CAPABILITY, "2026-09-26T00:00:00Z");
    provider.release("short provider blocker");
    // The holder keeps the computer until the test releases it, so the target
    // can start here only if its revoked capability no longer takes the lock.
    // Bound the wait under the test timeout so a retained lock fails here.
    await waitUntil(
      () => h.events.some((event) => event.actorId === target && event.event.type === "runStart"),
      3_000
    );

    const holderResult = h.events.findIndex(
      (event) => event.actorId === holder && event.event.type === "result"
    );
    const targetStart = h.events.findIndex(
      (event) => event.actorId === target && event.event.type === "runStart"
    );
    expect(holderResult).toBe(-1);
    expect(targetStart).toBeGreaterThanOrEqual(0);
    provider.release("long computer holder");
    provider.release("revoked capability target");
    expect(h.failures).toEqual([]);
  });

  it("lets separate follower instances control their own computers concurrently", async () => {
    const left = setup({ delayMs: 500, maxConcurrent: 3 });
    const right = setup({ delayMs: 500, maxConcurrent: 3 });
    const leftActor = left.spawn("Left computer run");
    grantComputerUse(left, leftActor);
    const rightActor = right.spawn("Right computer run");
    grantComputerUse(right, rightActor);

    await waitUntil(() => left.runtime(leftActor).isRunning && right.runtime(rightActor).isRunning);
    expect(left.failures).toEqual([]);
    expect(right.failures).toEqual([]);
  });

  it("stops a normal computer holder before granting its responsive waiter", async () => {
    const h = setup({ delayMs: 1500, maxConcurrent: 3 });
    const holder = h.spawn("Long computer run");
    grantComputerUse(h, holder);
    await waitUntil(() => h.runtime(holder).isRunning);
    const responsive = h.spawn("Urgent computer run");
    grantComputerUse(h, responsive);
    await waitUntil(() => h.runtime(responsive).isQueued);

    h.dispatchResponsive(responsive);
    await waitUntil(() => !h.runtime(holder).isRunning);
    await waitUntil(() =>
      h.events.some((event) => event.actorId === responsive && event.event.type === "runStart")
    );
    const initialStarts = h.events
      .filter((event) => event.event.type === "runStart")
      .map((event) => event.actorId);
    expect(initialStarts.indexOf(responsive)).toBeGreaterThan(initialStarts.indexOf(holder));

    // After the responsive waiter finishes, the preempted holder must automatically
    // re-run without a new delivery and complete its durable work.
    await waitUntil(() =>
      h.events.some((event) => event.actorId === responsive && event.event.type === "result")
    );
    await waitUntil(
      () =>
        h.events.some(
          (event) =>
            event.actorId === holder && event.event.type === "result" && event.event.result.success
        ),
      15_000
    );
    const allStarts = h.events
      .filter((event) => event.event.type === "runStart")
      .map((event) => event.actorId);
    expect(allStarts).toEqual([holder, responsive, holder]);
    expect(h.messages.filter((msg) => msg.fromId === holder)).toHaveLength(1);
    expect(h.messages.filter((msg) => msg.fromId === responsive)).toHaveLength(1);
    expect(h.failures).toEqual([]);
  });

  it("cancels queued computer work when the follower disconnects", async () => {
    const h = setup({ delayMs: 1000, maxConcurrent: 3 });
    const holder = h.spawn("Long computer run");
    grantComputerUse(h, holder);
    await waitUntil(() => h.runtime(holder).isRunning);
    const queued = h.spawn("Queued computer run");
    grantComputerUse(h, queued);
    await waitUntil(() => h.runtime(queued).isQueued);

    h.follower.close();
    h.remote.close();
    await Promise.all([h.runtime(holder).exited, h.runtime(queued).exited]);
    expect(
      h.events.some((event) => event.actorId === queued && event.event.type === "runStart")
    ).toBe(false);
  });

  it("closes admission before waiting for active actors to quiesce", async () => {
    const follower = new FollowerInstance("/tmp/rusa-follower-drain", false, () => {});
    follower.beginDrain();
    follower.dispatch({
      actorId: "new-during-drain",
      message: {
        type: "init",
        bootstrap: { id: "new-during-drain", cwd: "/tmp/rusa-follower-drain" },
      },
    });

    expect(follower.actorIds).toEqual([]);
    await expect(follower.waitForQuiescence(20)).resolves.toMatchObject({ quiesced: true });
    follower.close();
  });

  it("hosts multiple Actors in one PID and retires one without stopping its sibling", async () => {
    const h = setup();
    const first = h.spawn("First charter");
    const second = h.spawn("Second charter");
    expect(await h.runtime(first).ready).toBe(process.pid);
    expect(await h.runtime(second).ready).toBe(process.pid);
    await waitUntil(
      () =>
        h.events.filter((e) => e.event.type === "result").length === 2 &&
        !h.mesh.runningThreadIds().size
    );
    h.mesh.retire(first, { force: true });
    await h.runtime(first).exited;
    expect(h.follower.actorIds).toEqual([second]);
    expect(h.remote.hosts.has(second)).toBe(true);
    h.mesh.sendMessage(second, "Still connected", "root");
    await waitUntil(() => h.events.filter((e) => e.event.type === "result").length === 3);
    expect(h.failures).toEqual([]);
  });

  it("preserves per-actor session and gets fresh prompt/messages after admission", async () => {
    const h = setup({ delayMs: 150 });
    const first = h.spawn("First");
    await waitUntil(() => h.runtime(first).isRunning);
    const second = h.spawn("Second");
    await waitUntil(() => h.runtime(second).isQueued);
    h.actors.patch(second, { charter: "Updated second" });
    h.mesh.sendMessage(second, "Fresh queued message", "root");
    await waitUntil(
      () =>
        h.events.filter((e) => e.event.type === "result").length === 2 &&
        !h.runtime(second).isRunning
    );
    const session = h.actors.get(second)?.sessionId;
    expect(session).toBeTruthy();
    expect(session).not.toBe(h.actors.get(first)?.sessionId);
    const report = JSON.parse(h.messages.filter((m) => m.fromId === second).at(-1)?.body ?? "{}");
    expect(report.charter).toBe("Updated second");
    expect(report.messages).toContain("Fresh queued message");
    h.mesh.sendMessage(second, "Resume", "root");
    await waitUntil(() => h.events.filter((e) => e.event.type === "result").length === 3);
    expect(h.actors.get(second)?.sessionId).toBe(session);
    expect(
      JSON.parse(h.messages.filter((m) => m.fromId === second).at(-1)?.body ?? "{}").resumed
    ).toBe(true);
  });

  it("contains initialization failure to the actor without closing the instance", async () => {
    const h = setup({ failInit: true });
    const id = h.spawn("Broken");
    await expect(h.runtime(id).ready).rejects.toThrow();
    await h.runtime(id).exited;
    expect(h.failures[0]?.message).toContain("test provider initialization failed");
    expect(h.follower.actorIds).toEqual([]);
    expect(h.remote.hosts.size).toBe(0);
  });

  it("closes all actor handles and releases admission on instance disconnect", async () => {
    const h = setup({ delayMs: 250 });
    const a = h.spawn("A");
    const b = h.spawn("B");
    await waitUntil(() => h.runtime(a).isRunning && h.runtime(b).isQueued);
    h.follower.close();
    h.remote.close();
    await Promise.all([h.runtime(a).exited, h.runtime(b).exited]);
    await waitUntil(() => h.follower.actorIds.length === 0);
    expect(h.follower.actorIds).toEqual([]);
    expect(h.runtime(a).isRunning).toBe(false);
    expect(h.runtime(b).isQueued).toBe(false);
  });

  it("interrupts a running actor without killing the instance or stranding its queued sibling", async () => {
    const h = setup({ delayMs: 250 });
    const a = h.spawn("Retire me");
    const b = h.spawn("Keep running");
    await waitUntil(() => h.runtime(a).isRunning && h.runtime(b).isQueued);
    h.mesh.retire(a, { force: true });
    await h.runtime(a).exited;
    await waitUntil(() => h.events.some((e) => e.actorId === b && e.event.type === "result"));
    expect(h.follower.actorIds).toEqual([b]);
    expect(h.failures).toEqual([]);
  });

  it("preempts an in-flight remote run only after the follower confirms it", async () => {
    const h = setup({ delayMs: 500 });
    const id = h.spawn("Replace this run");
    await waitUntil(() => h.runtime(id).isRunning);

    h.dispatchResponsive(id);

    // The leader has handed a command to its transport, not claimed that an
    // unseen follower/provider abort already happened.
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        event: "remote_preempt_requested",
        fields: expect.objectContaining({ actorId: id, phase: "running" }),
      })
    );
    expect(h.meshEvents.some((event) => event.kind === "run_preempted")).toBe(false);

    await waitUntil(() =>
      h.events.some(
        (event) =>
          event.actorId === id &&
          event.event.type === "preempted" &&
          event.event.preempted &&
          event.event.phase === "running"
      )
    );
    expect(h.meshEvents).toContainEqual(
      expect.objectContaining({
        kind: "run_preempted",
        actorId: id,
        detail: "running",
        payload: JSON.stringify({ reason: "responsive_notification" }),
      })
    );
    await waitUntil(() =>
      h.events.some(
        (event) =>
          event.actorId === id && event.event.type === "result" && event.event.result.success
      )
    );
  });

  it("promotes queued remote work through the leader-owned admission handle", async () => {
    const h = setup({ delayMs: 500 });
    const first = h.spawn("Occupy the ordinary admission lane");
    await waitUntil(() => h.runtime(first).isRunning);
    const queued = h.spawn("Promote me");
    await waitUntil(() => h.runtime(queued).isQueued);

    h.dispatchResponsive(queued);

    await waitUntil(() =>
      h.events.some((event) => event.actorId === queued && event.event.type === "runStart")
    );
    // Promotion carries the responsive truth across the admission seam: the
    // follower reports the run at the priority the leader admitted it under.
    expect(h.events).toContainEqual({
      actorId: queued,
      event: expect.objectContaining({ type: "runStart", responsive: true }),
    });
    expect(h.events.some((event) => event.actorId === first && event.event.type === "result")).toBe(
      false
    );
    // Queue promotion is not a run abort, so it never impersonates a confirmed preemption.
    expect(
      h.meshEvents.some((event) => event.kind === "run_preempted" && event.actorId === queued)
    ).toBe(false);
  });

  it("admits at responsive priority when the item lands before the admission request", async () => {
    const h = setup({ delayMs: 500 });
    const first = h.spawn("Occupy the ordinary admission lane");
    await waitUntil(() => h.runtime(first).isRunning);
    // Hold the follower's admission request on the wire: the leader has seen
    // `state: queued` but holds no gate to promote yet.
    const held: Parameters<typeof h.remote.receive>[0][] = [];
    const receive = h.remote.receive.bind(h.remote);
    h.remote.receive = (event) => {
      if (event.message.type === "request" && event.message.request.op === "admit") {
        held.push(event);
        return;
      }
      receive(event);
    };
    const queued = h.spawn("Promote me before you admit me");
    await waitUntil(() => h.runtime(queued).isQueued && held.length === 1);

    h.dispatchResponsive(queued);
    h.remote.receive = receive;
    for (const event of held.splice(0)) receive(event);

    await waitUntil(() =>
      h.events.some((event) => event.actorId === queued && event.event.type === "runStart")
    );
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        event: "remote_admission_promoted",
        fields: expect.objectContaining({ actorId: queued }),
      })
    );
    expect(h.events).toContainEqual({
      actorId: queued,
      event: expect.objectContaining({ type: "runStart", responsive: true }),
    });
    expect(h.events.some((event) => event.actorId === first && event.event.type === "result")).toBe(
      false
    );
  });

  describe("joining responsive work (#829)", () => {
    function noDisplacement(h: Harness, id: string) {
      expect(h.logs.some((log) => log.event === "remote_preempt_requested")).toBe(false);
      expect(
        h.events.some((event) => event.actorId === id && event.event.type === "preempted")
      ).toBe(false);
      expect(h.meshEvents.some((event) => event.kind === "run_preempted")).toBe(false);
    }

    it("lets an in-flight remote run finish and starts one responsive follow-up", async () => {
      const h = setup({ delayMs: 500 });
      const id = h.spawn("Finish this run");
      await waitUntil(() => h.runtime(id).isRunning);
      const [original] = runStarts(h, id);

      h.dispatchJoining(id);

      await waitUntil(() => runStarts(h, id).length === 2);
      noDisplacement(h, id);
      // The original run was not aborted: it ended exactly once, successfully,
      // before the follow-up that sees the joining row started.
      const results = runResults(h, id);
      expect(results).toHaveLength(1);
      expect(results[0]?.event.type === "result" && results[0].event.result.success).toBe(true);
      const starts = h.events.filter(
        (event) => event.actorId === id && event.event.type === "runStart"
      );
      expect(starts[0]?.event.type === "runStart" && starts[0].event.runId).toBe(original);
      expect(starts[1]?.event).toEqual(expect.objectContaining({ responsive: true }));
      expect(h.events.indexOf(results[0] as (typeof h.events)[number])).toBeLessThan(
        h.events.indexOf(starts[1] as (typeof h.events)[number])
      );
      await waitUntil(() => runResults(h, id).length === 2);
      expect(h.failures).toEqual([]);
    });

    it("promotes a queued remote admission from the after-commit join seam", async () => {
      const h = setup({ delayMs: 500 });
      const first = h.spawn("Occupy the ordinary admission lane");
      await waitUntil(() => h.runtime(first).isRunning);
      const queued = h.spawn("Promote me from a subscriber copy");
      await waitUntil(() => h.runtime(queued).isQueued);
      const queuedRun = queuedRuns(h, queued)[0];

      // No caller dispatch: the append's own after-commit wake joins, which
      // never reaches preemptForResponsive, so only the wake can promote.
      h.inboxStore.append([
        {
          actorId: queued,
          source: "test:subscriber",
          payload: { type: "test.event", priority: "responsive", deliveryRole: "subscriber" },
        },
      ]);

      await waitUntil(() => runStarts(h, queued).length === 1);
      // The queued run itself absorbs the row at responsive priority: no
      // second run, and the occupying run was not displaced either.
      expect(runStarts(h, queued)).toEqual([queuedRun?.runId]);
      expect(h.events).toContainEqual({
        actorId: queued,
        event: expect.objectContaining({ type: "runStart", responsive: true }),
      });
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          event: "remote_admission_promoted",
          fields: expect.objectContaining({ actorId: queued }),
        })
      );
      expect(runResults(h, first)).toHaveLength(0);
      noDisplacement(h, queued);
    });

    it("admits responsive when the joining row lands before the admission request", async () => {
      const h = setup({ delayMs: 500 });
      const first = h.spawn("Occupy the ordinary admission lane");
      await waitUntil(() => h.runtime(first).isRunning);
      const held: Parameters<typeof h.remote.receive>[0][] = [];
      const receive = h.remote.receive.bind(h.remote);
      h.remote.receive = (event) => {
        if (event.message.type === "request" && event.message.request.op === "admit") {
          held.push(event);
          return;
        }
        receive(event);
      };
      const queued = h.spawn("Join before you admit me");
      await waitUntil(() => h.runtime(queued).isQueued && held.length === 1);

      h.dispatchJoining(queued);
      h.remote.receive = receive;
      for (const event of held.splice(0)) receive(event);

      await waitUntil(() => runStarts(h, queued).length === 1);
      expect(h.events).toContainEqual({
        actorId: queued,
        event: expect.objectContaining({ type: "runStart", responsive: true }),
      });
      expect(h.logs).toContainEqual(
        expect.objectContaining({
          event: "remote_admission_promoted",
          fields: expect.objectContaining({ actorId: queued }),
        })
      );
      expect(runResults(h, first)).toHaveLength(0);
      noDisplacement(h, queued);
    });

    it("keeps joining across a disconnect and its reconciliation replay", async () => {
      const h = setup({ delayMs: 1500 });
      const id = h.spawn("Keep running across the gap");
      await waitUntil(() => h.runtime(id).isRunning);
      const [original] = runStarts(h, id);

      h.remote.close();
      await h.runtime(id).exited;
      h.dispatchJoining(id);
      await waitUntil(() =>
        h.logs.some(
          (log) =>
            log.event === "remote_wake_dropped" &&
            log.fields?.actorId === id &&
            log.fields?.priority === "responsive"
        )
      );
      expect(h.logs.some((log) => log.event === "remote_preempt_deferred")).toBe(false);

      const reconnect = h.reconnect();
      h.runtime(id).attachHost(reconnect.createHost(id));
      // Register-time and boot reconciliation re-read the same durable row.
      h.mesh.dispatch(id);
      h.mesh.reconcileInbox();
      await expect(h.runtime(id).ready).resolves.toBe(process.pid);

      await waitUntil(() => runStarts(h, id).length === 2);
      noDisplacement(h, id);
      const results = runResults(h, id);
      expect(results).toHaveLength(1);
      expect(results[0]?.event.type === "result" && results[0].event.result.success).toBe(true);
      expect(runStarts(h, id)[0]).toBe(original);
      expect(
        h.events.filter((event) => event.actorId === id && event.event.type === "runStart")[1]
          ?.event
      ).toEqual(expect.objectContaining({ responsive: true }));
    });
  });

  it("drops a pre-gate remote admission without retaining it and replays newer work (#787)", async () => {
    const h = setup({ delayMs: 500 });
    // Hold the follower's admission request after its queued state reaches the
    // leader. This is the ActorHandle pendingQueuedCancel path, not a gate stub.
    const held: Parameters<typeof h.remote.receive>[0][] = [];
    const receive = h.remote.receive.bind(h.remote);
    h.remote.receive = (event) => {
      if (event.message.type === "request" && event.message.request.op === "admit") {
        held.push(event);
        return;
      }
      receive(event);
    };
    const queued = h.spawn("Cancel before leader admission");
    await waitUntil(() => h.runtime(queued).isQueued && held.length === 1);

    const entries = h.inboxStore.list(queued, { status: "unhandled" }).entries;
    h.inboxStore.markHandled(
      queued,
      entries.map((entry) => entry.id)
    );
    // New durable work crosses the refusal before the old admit is released.
    h.mesh.sendMessage(queued, "fresh work after cancellation", "root");
    h.remote.receive = receive;
    for (const event of held.splice(0)) receive(event);

    await waitUntil(() =>
      h.events.some(
        (event) =>
          event.actorId === queued && event.event.type === "result" && event.event.result.success
      )
    );
    expect(runStarts(h, queued)).toHaveLength(1);
    expect(abandonedRuns(h, queued)).toHaveLength(1);
    expect(h.failures).toEqual([]);
  });

  it("re-decides a preemption requested during disconnect against the follower's reattach state", async () => {
    const h = setup({ delayMs: 1500 });
    const id = h.spawn("Survive the gap");
    await waitUntil(() => h.runtime(id).isRunning);

    // A transport loss drops the leader's channel while the follower keeps
    // executing the run it admitted. The responsive item arrives in the gap.
    h.remote.close();
    await h.runtime(id).exited;
    h.dispatchResponsive(id);
    // The handle retains nothing: the wake is reported dropped and the
    // preemption is deferred until the follower says what it is doing.
    await waitUntil(() =>
      h.logs.some(
        (log) =>
          log.event === "remote_wake_dropped" &&
          log.fields?.actorId === id &&
          log.fields?.priority === "responsive"
      )
    );
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        event: "remote_preempt_deferred",
        fields: expect.objectContaining({ actorId: id }),
      })
    );
    expect(h.logs.some((log) => log.event === "remote_preempt_requested")).toBe(false);

    const beforeReattach = h.events.length;
    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));
    // What start.ts does on register: a content-free dispatch, which re-reads
    // the responsive entry the gap left unhandled.
    h.mesh.dispatch(id);
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);

    await waitUntil(() =>
      h.events
        .slice(beforeReattach)
        .some(
          (event) =>
            event.actorId === id &&
            event.event.type === "preempted" &&
            event.event.preempted &&
            event.event.phase === "running"
        )
    );
    expect(h.meshEvents).toContainEqual(
      expect.objectContaining({ kind: "run_preempted", actorId: id, detail: "running" })
    );
    await waitUntil(() =>
      h.events
        .slice(beforeReattach)
        .some(
          (event) =>
            event.actorId === id && event.event.type === "runStart" && event.event.responsive
        )
    );
  });

  it("does not replay a preemption against a follower that reattaches idle", async () => {
    const h = setup();
    const id = h.spawn("Idle across the gap");
    await waitUntil(() =>
      h.events.some((event) => event.actorId === id && event.event.type === "result")
    );
    h.remote.close();
    await h.runtime(id).exited;
    h.dispatchResponsive(id);

    const beforeReattach = h.events.length;
    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));
    h.mesh.dispatch(id);
    await waitUntil(() =>
      h.events
        .slice(beforeReattach)
        .some(
          (event) =>
            event.actorId === id && event.event.type === "runStart" && event.event.responsive
        )
    );
    // Nothing was in flight, so nothing is asked to stop and nothing is booked as displaced.
    expect(h.logs.some((log) => log.event === "remote_preempt_requested")).toBe(false);
    expect(h.events.slice(beforeReattach).some((event) => event.event.type === "preempted")).toBe(
      false
    );
    expect(h.meshEvents.some((event) => event.kind === "run_preempted")).toBe(false);
  });

  it("resumes a promoted queued admission after a lease flap", async () => {
    const h = setup({ delayMs: 1500 });
    const first = h.spawn("Occupy concurrency");
    await waitUntil(() => h.runtime(first).isRunning);

    const queued = h.spawn("Await admission");
    await waitUntil(() => h.runtime(queued).isQueued);
    const queuedRun = h.events.find(
      (event) => event.actorId === queued && event.event.type === "queued"
    )?.event;

    // Responsive work arrives while awaiting admission
    h.dispatchResponsive(queued);

    // Disconnect while queued awaiting admission
    h.remote.close();
    await h.runtime(queued).exited;

    // The admission is the leader's own: the transport loss does not end the
    // run holding it, so nothing is booked as abandoned here.
    expect(h.meshEvents.filter((event) => event.kind === "run_abandoned")).toEqual([]);

    const beforeReattach = h.events.length;
    const reconnect = h.reconnect();
    h.runtime(first).attachHost(reconnect.createHost(first));
    h.runtime(queued).attachHost(reconnect.createHost(queued));

    // The run that starts is the one queued before the flap, still carrying the
    // responsive priority the leader granted its admission before the loss.
    await waitUntil(() =>
      h.events
        .slice(beforeReattach)
        .some(
          (event) =>
            event.actorId === queued && event.event.type === "runStart" && event.event.responsive
        )
    );
    const started = h.events
      .slice(beforeReattach)
      .find((event) => event.actorId === queued && event.event.type === "runStart")?.event;
    expect(started?.type === "runStart" && started.runId).toBe(
      queuedRun?.type === "queued" && queuedRun.runId
    );
  });

  it("does not let the reattach startup deadline drop a retained admission", async () => {
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 60_000);
    const h = setup({ pacer });
    const id = h.spawn("Keep this retained admission");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);

    h.remote.close();
    await h.runtime(id).exited;

    const reconnect = h.reconnect();
    const dispatch = h.follower.dispatch.bind(h.follower);
    h.follower.dispatch = (envelope) => {
      if (envelope.message.type !== "init") dispatch(envelope);
    };
    h.runtime(id).attachHost(reconnect.createHost(id));

    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(10_001);
      expect(pacer.waiting).toBe(1);
      expect(
        h.meshEvents.some(
          (event) =>
            event.kind === "run_abandoned" &&
            event.actorId === id &&
            event.detail === "start-cancelled"
        )
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers a run admitted before a lease flap when disconnect abandons it at start", async () => {
    const h = setup({ delayMs: 500 });

    // Hold runStart to simulate the lease flap occurring after admission was
    // granted by the leader but before the start was acknowledged across the wire.
    let heldRunStart = false;
    const receive = h.remote.receive.bind(h.remote);
    h.remote.receive = (event) => {
      if (event.message.type === "runStart") {
        heldRunStart = true;
        return;
      }
      receive(event);
    };

    const id = h.spawn("Admitted during flap");
    await waitUntil(() => heldRunStart);

    // Lease flap occurs: channel drops while admitted run is in-flight before start acknowledgment
    h.remote.close();
    await h.runtime(id).exited;

    // The leader records run_abandoned with start-cancelled, started: false (synthetic fixture pattern)
    expect(h.meshEvents).toContainEqual(
      expect.objectContaining({
        kind: "run_abandoned",
        actorId: id,
        detail: "start-cancelled",
      })
    );

    // Restore receiver for reconnect
    h.remote.receive = receive;

    const beforeReattach = h.events.length;
    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));

    // What start.ts does on register: a content-free dispatch over the actor's
    // remaining ordinary work.
    h.dispatchNormal(id);

    // Prove the replacement run executes after the old admission rejection and completes
    await waitUntil(() =>
      h.events
        .slice(beforeReattach)
        .some(
          (event) =>
            event.actorId === id && event.event.type === "runStart" && !event.event.responsive
        )
    );
    await waitUntil(() =>
      h.events
        .slice(beforeReattach)
        .some(
          (event) =>
            event.actorId === id && event.event.type === "result" && event.event.result.success
        )
    );
  });

  it("keeps a queued run waiting in provider pacing across a lease flap", async () => {
    // The lane is busy until well after the flap, so the run spends the whole
    // disconnect/reconnect cycle holding a place it has not reached yet.
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 500);
    const h = setup({ pacer });

    const id = h.spawn("Wait out the pacing gap");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
    const queuedRunId = h.events.find(
      (event) => event.actorId === id && event.event.type === "queued"
    )?.event;
    expect(queuedRunId?.type === "queued" && queuedRunId.runId).toBeTruthy();

    // Lease flap: the transport drops and comes back inside the pacing wait.
    h.remote.close();
    await h.runtime(id).exited;
    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);

    // The run the leader queued before the flap is the run that starts.
    await waitUntil(() =>
      h.events.some((event) => event.actorId === id && event.event.type === "runStart")
    );
    const started = h.events.find(
      (event) => event.actorId === id && event.event.type === "runStart"
    )?.event;
    expect(started?.type === "runStart" && started.runId).toBe(
      queuedRunId?.type === "queued" && queuedRunId.runId
    );
    // A transport loss is not a run outcome, and the admission it interrupted
    // is the same one: the run never re-entered the pacer as fresh work.
    expect(h.meshEvents.filter((event) => event.kind === "run_abandoned")).toEqual([]);
    // The follower asked to be admitted once and then re-announced that same
    // request after the flap; it never queued behind the pacer as fresh work.
    const admits = h.events.flatMap((entry) =>
      entry.event.type === "request" && entry.event.request.op === "admit"
        ? [{ requestId: entry.event.requestId, resume: entry.event.request.resume === true }]
        : []
    );
    expect(admits).toHaveLength(2);
    expect(admits[0].resume).toBe(false);
    expect(admits[1]).toEqual({ requestId: admits[0].requestId, resume: true });
    await waitUntil(() =>
      h.events.some(
        (event) =>
          event.actorId === id && event.event.type === "result" && event.event.result.success
      )
    );
  });

  it("re-retains an unstarted queued admission across multiple lease flaps", async () => {
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 800);
    const h = setup({ pacer });

    const id = h.spawn("Wait out multiple flaps");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
    const queuedRunId = h.events.find(
      (event) => event.actorId === id && event.event.type === "queued"
    )?.event;
    expect(queuedRunId?.type === "queued" && queuedRunId.runId).toBeTruthy();

    // First flap inside pacing wait
    h.remote.close();
    await h.runtime(id).exited;
    const reconnect1 = h.reconnect();
    h.runtime(id).attachHost(reconnect1.createHost(id));
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);

    // Second flap inside pacing wait
    h.remote.close();
    await h.runtime(id).exited;
    const reconnect2 = h.reconnect();
    h.runtime(id).attachHost(reconnect2.createHost(id));
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);

    // The queued run still starts once pacing turns
    await waitUntil(() =>
      h.events.some((event) => event.actorId === id && event.event.type === "runStart")
    );
    const started = h.events.find(
      (event) => event.actorId === id && event.event.type === "runStart"
    )?.event;
    expect(started?.type === "runStart" && started.runId).toBe(
      queuedRunId?.type === "queued" && queuedRunId.runId
    );
    expect(h.meshEvents.filter((event) => event.kind === "run_abandoned")).toEqual([]);
    await waitUntil(() =>
      h.events.some(
        (event) =>
          event.actorId === id && event.event.type === "result" && event.event.result.success
      )
    );
  });

  it("books a retained queued admission as start-cancelled for the old run id if a fresh admission arrives before state", async () => {
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 600);
    const h = setup({ pacer });

    const id = h.spawn("Fresh admission replacement test");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
    const queuedRunId = h.events.find(
      (event) => event.actorId === id && event.event.type === "queued"
    )?.event;
    expect(queuedRunId?.type === "queued" && queuedRunId.runId).toBeTruthy();
    const oldRunId = (queuedRunId as { runId: string }).runId;

    // Lease flap occurs while waiting in pacing
    h.remote.close();
    await h.runtime(id).exited;

    // Intercept follower dispatch so the leader channel can be driven directly before state
    const origDispatch = h.follower.dispatch.bind(h.follower);
    let blockDispatch = true;
    h.follower.dispatch = (envelope) => {
      if (blockDispatch) return;
      origDispatch(envelope);
    };
    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));

    // Feed the channel directly before any post-reattach state report:
    // 1. ready
    // 2. queued for a replacement run id (advances queuedRunId)
    // 3. non-resume admit request (triggers cancelRetainedAdmission with queuedRunId !== retained.runId)
    const replacementRunId = "fresh-replacement-run-id";
    reconnect.receive({ actorId: id, message: { type: "ready", pid: process.pid } });
    reconnect.receive({
      actorId: id,
      message: { type: "queued", runId: replacementRunId, mode: "ordinary", responsive: false },
    });
    reconnect.receive({
      actorId: id,
      message: {
        type: "request",
        requestId: 99,
        request: {
          op: "admit",
          candidates: [{ provider: "instance-fixture", model: "scripted" }],
          responsive: false,
          mode: "ordinary",
        },
      },
    });

    // The old retained admission was cancelled and booked as abandoned start-cancelled
    // via cancelRetainedAdmission's emit branch, specifically preserving oldRunId
    await waitUntil(() =>
      h.meshEvents.some(
        (event) =>
          event.kind === "run_abandoned" &&
          event.actorId === id &&
          event.detail === "start-cancelled"
      )
    );
    const abandoned = h.meshEvents.find(
      (event) => event.kind === "run_abandoned" && event.actorId === id
    );
    expect(abandoned).toBeDefined();
    expect(JSON.parse(abandoned?.payload ?? "{}")).toEqual({
      started: false,
      runId: oldRunId,
    });

    blockDispatch = false;
    h.follower.dispatch = origDispatch;
    reconnect.receive({ actorId: id, message: { type: "exit", code: 0, signal: null } });
  });

  it("logs a warning and ignores attachHost if called after close", async () => {
    const h = setup();
    const id = h.spawn("Attach after close");
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);

    h.runtime(id).close();
    h.remote.close();
    await h.runtime(id).exited;

    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));

    expect(h.logs).toContainEqual(
      expect.objectContaining({
        event: "remote_attach_after_close",
        fields: expect.objectContaining({ actorId: id }),
      })
    );
  });

  it("cancels retained admission immediately on genuine leader close during transport loss gap", async () => {
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 5000);
    const h = setup({ pacer });

    const id = h.spawn("Close during flap");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
    const queuedRunId = h.events.find(
      (event) => event.actorId === id && event.event.type === "queued"
    )?.event;
    expect(queuedRunId?.type === "queued" && queuedRunId.runId).toBeTruthy();

    // Flap transport
    h.remote.close();
    await h.runtime(id).exited;

    // Leader closes the actor while disconnected
    h.runtime(id).close();

    // Retained admission cancelled immediately from pacer queue
    expect(pacer.waiting).toBe(0);
    expect(h.meshEvents).toContainEqual(
      expect.objectContaining({
        kind: "run_abandoned",
        actorId: id,
        detail: "start-cancelled",
      })
    );
  });

  it("drops retained ticket and books start-cancelled when pacing delay elapses during transport loss", async () => {
    const { pacer, release } = heldPacer();
    const h = setup({ pacer });

    const id = h.spawn("Pacing timeout while disconnected");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);

    // Transport drops
    h.remote.close();
    await h.runtime(id).exited;

    // Do not reconnect. Turn pacing only after the transport loss is observed,
    // so the retained ticket cannot leave the queue before the test reaches it.
    release();
    await waitUntil(() =>
      h.meshEvents.some(
        (event) =>
          event.kind === "run_abandoned" &&
          event.actorId === id &&
          event.detail === "start-cancelled"
      )
    );
    expect(pacer.waiting).toBe(0);
  });

  it("drops retained ticket on first post-reattach state report if follower does not resume", async () => {
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 1000);
    const h = setup({ pacer });

    const id = h.spawn("State without claim test");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);

    // Lease flap occurs while waiting in pacing
    h.remote.close();
    await h.runtime(id).exited;

    // Reconnect: simulate old follower that ignores resumeAdmission and never sends admit with resume: true,
    // sending its state report instead.
    const reconnect = h.reconnect();
    const origDispatch = h.follower.dispatch.bind(h.follower);
    h.follower.dispatch = (envelope) => {
      if (envelope.message.type === "init") {
        envelope.message.bootstrap.resumeAdmission = false;
      }
      origDispatch(envelope);
    };
    h.runtime(id).attachHost(reconnect.createHost(id));
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);

    // Leader drops retained admission on first post-reattach state report
    await waitUntil(() =>
      h.meshEvents.some(
        (event) =>
          event.kind === "run_abandoned" &&
          event.actorId === id &&
          event.detail === "start-cancelled"
      )
    );
    expect(pacer.waiting).toBe(0);
  });

  it("re-dispatches unhandled work after the reattach report drops an unclaimed admission (#613)", async () => {
    const { pacer, release } = heldPacer();
    const h = setup({ pacer });
    const id = h.spawn("Dropped admission recovery test");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
    const [original] = queuedRuns(h, id);

    await flap(h, id);
    await reattachWithoutClaim(h, id);
    await waitUntil(() => abandonedRuns(h, id).length === 1);
    expect(JSON.parse(abandonedRuns(h, id)[0].payload ?? "{}")).toEqual({
      started: false,
      runId: original.runId,
    });

    // No message arrives: the durable entry alone earns a fresh admission.
    await waitUntil(() => queuedRuns(h, id).length === 2 && pacer.waiting === 1);
    const replacement = queuedRuns(h, id)[1];
    expect(replacement.runId).not.toBe(original.runId);
    release();
    await waitUntil(() => runResults(h, id).length === 1);
    expect(runStarts(h, id)).toEqual([replacement.runId]);
    expect(abandonedRuns(h, id)).toHaveLength(1);
    expect(h.messages.filter((message) => message.toId === id)).toHaveLength(1);
  });

  it("re-dispatches on reattach when the retained admission is dropped during the transport gap (#613)", async () => {
    const { pacer, release } = heldPacer();
    const h = setup({ pacer });
    const id = h.spawn("Gap drop recovery test");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);

    await flap(h, id);
    // The ticket reaches its turn with no channel to admit into.
    release();
    await waitUntil(() => abandonedRuns(h, id).length === 1);
    expect(pacer.waiting).toBe(0);

    // A current follower reattaches with nothing left to reclaim.
    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);
    await waitUntil(() => runResults(h, id).length === 1);
    const runs = queuedRuns(h, id);
    expect(runs).toHaveLength(2);
    expect(runStarts(h, id)).toEqual([runs[1].runId]);
    expect(abandonedRuns(h, id)).toHaveLength(1);
    expect(h.messages.filter((message) => message.toId === id)).toHaveLength(1);
  });

  it("does not re-dispatch a dropped admission's work after a genuine close (#613)", async () => {
    const { pacer, release } = heldPacer();
    const h = setup({ pacer });
    const id = h.spawn("Genuine close test");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
    const reconcile = vi.spyOn(h.mesh, "reconcileActorInbox");

    await flap(h, id);
    release();
    await waitUntil(() => abandonedRuns(h, id).length === 1);
    // The drop owes a wake to the next channel; close cancels that debt.
    h.runtime(id).close();
    h.runtime(id).attachHost(h.reconnect().createHost(id));
    await delay(0);

    expect(reconcile).not.toHaveBeenCalled();
    expect(queuedRuns(h, id)).toHaveLength(1);
    expect(runStarts(h, id)).toHaveLength(0);
  });

  it("keeps one replacement admission when reconciliation overlaps the re-dispatch (#613)", async () => {
    const { pacer, release } = heldPacer();
    const h = setup({ pacer });
    const id = h.spawn("Overlapping reconciliation test");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);

    await flap(h, id);
    await reattachWithoutClaim(h, id);
    await waitUntil(() => queuedRuns(h, id).length === 2 && pacer.waiting === 1);
    // Reconciliation passes while the replacement waits join it rather than queue another.
    h.mesh.reconcileInbox();
    h.mesh.reconcileInbox();
    await delay(0);
    expect(pacer.waiting).toBe(1);
    expect(queuedRuns(h, id)).toHaveLength(2);

    release();
    await waitUntil(() => runResults(h, id).length === 1);
    expect(runStarts(h, id)).toHaveLength(1);
    expect(abandonedRuns(h, id)).toHaveLength(1);
  });

  it("rejects duplicate actor init without reconnect flag but permits reconnect", async () => {
    const h = setup();
    const id = h.spawn("Duplicate test");
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);

    // Attempting duplicate init without reconnect flag throws
    expect(() =>
      h.follower.dispatch({
        actorId: id,
        message: {
          type: "init",
          bootstrap: {
            id,
            cwd: "/tmp",
          },
        },
      })
    ).toThrow("Actor already exists on follower");

    // Reconnect flag permits re-initialization
    expect(() =>
      h.follower.dispatch({
        actorId: id,
        message: {
          type: "init",
          bootstrap: {
            id,
            cwd: "/tmp",
            reconnect: true,
          },
        },
      })
    ).not.toThrow();
  });

  // Issue #679 regressions
  it("rebinds and dispatches pending durable work after lease flap following remote_run_end without remote_attach_after_close", async () => {
    const h = setup();
    const id = h.spawn("Charter A");
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);
    await waitUntil(() => h.events.some((e) => e.actorId === id && e.event.type === "result"));

    // Add pending durable work in inbox
    h.inboxStore.append([
      { actorId: id, source: "test:durable-a", payload: { type: "test.work" } },
    ]);

    // Flap transport right after run end: transport loss or error lands on live channel
    h.runtime(id).channel.emit("error", new Error("Transport lost"));
    h.remote.close();
    await h.runtime(id).exited;

    // Follower reconnects and reattaches
    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));
    h.mesh.dispatch(id);

    // Verify handle did not log remote_attach_after_close
    expect(h.logs).not.toContainEqual(
      expect.objectContaining({
        event: "remote_attach_after_close",
        fields: expect.objectContaining({ actorId: id }),
      })
    );

    // Verify second run starts and completes for the pending durable work
    await waitUntil(
      () => h.events.filter((e) => e.actorId === id && e.event.type === "runStart").length >= 2
    );
    await waitUntil(
      () => h.events.filter((e) => e.actorId === id && e.event.type === "result").length >= 2
    );
  });

  it("times out of stateStale into a recoverable path when follower state report is missing or delayed after reconnect", async () => {
    const h = setup({ stateStaleTimeoutMs: 50 });
    const id = h.spawn("Charter B");
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);
    await waitUntil(() => h.events.some((e) => e.actorId === id && e.event.type === "result"));

    // Follower drops
    h.remote.close();
    await h.runtime(id).exited;

    // Follower reconnects with a new process, but state report is suppressed/missing
    const reconnect = h.reconnect();
    const origReceive = reconnect.receive.bind(reconnect);
    reconnect.receive = (event) => {
      // Suppress state event to simulate missing/delayed report
      if (
        event.message &&
        typeof event.message === "object" &&
        "type" in event.message &&
        event.message.type === "state"
      ) {
        return;
      }
      origReceive(event);
    };

    h.runtime(id).attachHost(reconnect.createHost(id));
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);

    // Add pending durable work and dispatch
    h.inboxStore.append([
      { actorId: id, source: "test:durable-b", payload: { type: "test.work" } },
    ]);
    h.mesh.dispatch(id);

    // Handle times out of stateStale into recoverable path, runs and completes
    await waitUntil(
      () => h.events.filter((e) => e.actorId === id && e.event.type === "runStart").length >= 2
    );
    await waitUntil(
      () => h.events.filter((e) => e.actorId === id && e.event.type === "result").length >= 2
    );
  });

  it("keeps a retained admission when the reattach report lands after the stale-state deadline", async () => {
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 1000);
    const h = setup({ pacer, stateStaleTimeoutMs: 50 });
    const id = h.spawn("Keep the ticket past a slow report");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
    const queuedRun = h.events.find(
      (event) => event.actorId === id && event.event.type === "queued"
    )?.event;

    h.remote.close();
    await h.runtime(id).exited;

    // Hold every command on the reattached channel, in order, so the follower's
    // resume claim and its first state report both land after the deadline.
    const reconnect = h.reconnect();
    const dispatch = h.follower.dispatch.bind(h.follower);
    const held: Parameters<typeof dispatch>[0][] = [];
    h.follower.dispatch = (envelope) => {
      held.push(envelope);
    };
    h.runtime(id).attachHost(reconnect.createHost(id));
    await waitUntil(() =>
      h.logs.some((log) => log.event === "remote_state_stale_timeout" && log.fields?.actorId === id)
    );
    // A late report is not an abandoned admission: the ticket keeps its place.
    expect(pacer.waiting).toBe(1);
    expect(h.meshEvents.some((event) => event.kind === "run_abandoned")).toBe(false);

    h.follower.dispatch = dispatch;
    for (const envelope of held.splice(0)) dispatch(envelope);
    await waitUntil(() =>
      h.events.some((event) => event.actorId === id && event.event.type === "runStart")
    );
    const started = h.events.find(
      (event) => event.actorId === id && event.event.type === "runStart"
    )?.event;
    expect(started?.type === "runStart" && started.runId).toBe(
      queuedRun?.type === "queued" && queuedRun.runId
    );
    expect(h.meshEvents.some((event) => event.kind === "run_abandoned")).toBe(false);
  });

  it("asks the follower to preempt when its reattach state report never arrives", async () => {
    const h = setup({ delayMs: 1500, stateStaleTimeoutMs: 50 });
    const id = h.spawn("Run through a silent reattach");
    await waitUntil(() => h.runtime(id).isRunning);

    h.remote.close();
    await h.runtime(id).exited;
    h.dispatchResponsive(id);
    await waitUntil(() =>
      h.logs.some((log) => log.event === "remote_preempt_deferred" && log.fields?.actorId === id)
    );

    // The follower keeps executing but never reports state after the reattach,
    // so the leader cannot tell a running follower from an idle one.
    const beforeReattach = h.events.length;
    const reconnect = h.reconnect();
    const receive = reconnect.receive.bind(reconnect);
    reconnect.receive = (event) => {
      if (event.message.type === "state") return;
      receive(event);
    };
    h.runtime(id).attachHost(reconnect.createHost(id));
    h.mesh.dispatch(id);

    await waitUntil(() =>
      h.events
        .slice(beforeReattach)
        .some(
          (event) =>
            event.actorId === id &&
            event.event.type === "preempted" &&
            event.event.preempted &&
            event.event.phase === "running"
        )
    );
    expect(h.meshEvents).toContainEqual(
      expect.objectContaining({ kind: "run_preempted", actorId: id, detail: "running" })
    );
  });

  it("recovers an omitted actor handle without termination when boot re-registration omits it initially", async () => {
    const h = setup({ startupTimeoutMs: 50 });
    const first = h.spawn("First actor");
    await expect(h.runtime(first).ready).resolves.toBe(process.pid);

    // Suppress dispatch for the second actor to simulate follower omitting it at boot
    const origDispatch = h.follower.dispatch.bind(h.follower);
    h.follower.dispatch = (envelope) => {
      if (envelope.actorId !== first) return; // omit second actor
      origDispatch(envelope);
    };

    const second = h.spawn("Second actor (omitted at boot)");
    // Second actor was omitted by follower during initial boot (never received ready),
    // so its startupTimer expires and fires fail()
    await expect(h.runtime(second).ready).rejects.toThrow("Remote actor startup timed out");

    // Later registration completes for the omitted actor
    h.follower.dispatch = origDispatch;
    const reconnect = h.reconnect();
    h.runtime(second).attachHost(reconnect.createHost(second));

    // Handle should NOT log remote_attach_after_close
    expect(h.logs).not.toContainEqual(
      expect.objectContaining({
        event: "remote_attach_after_close",
        fields: expect.objectContaining({ actorId: second }),
      })
    );

    // Now dispatch work to the recovered actor
    h.inboxStore.append([
      { actorId: second, source: "test:durable-c", payload: { type: "test.work" } },
    ]);
    h.mesh.dispatch(second);

    await waitUntil(
      () => h.events.filter((e) => e.actorId === second && e.event.type === "runStart").length >= 1
    );
    await waitUntil(
      () => h.events.filter((e) => e.actorId === second && e.event.type === "result").length >= 1
    );
  });

  it("re-quotes a follower admission with a pin applied while it waits in the provider gate", async () => {
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 1_000);
    const h = setup({ pacer });
    const id = h.spawn("Re-quote a queued follower admission");

    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
    h.mesh.setActorModel(
      id,
      [{ provider: "instance-fixture", model: "model-pinned-queued" }],
      "root"
    );

    await waitUntil(() =>
      h.events.some((event) => event.actorId === id && event.event.type === "runStart")
    );
    const started = h.events.find(
      (event) => event.actorId === id && event.event.type === "runStart"
    )?.event;
    expect(started?.type === "runStart" && started.selected).toMatchObject({
      model: "model-pinned-queued",
    });
  });

  it("does not re-quote a queued admission when its pool is republished unchanged", async () => {
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 1_000);
    const h = setup({ pacer });
    const id = h.spawn("Keep an unchanged queued remote pool");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);

    const runtime = h.runtime(id);
    const sent: LeaderCommand[] = [];
    const send = runtime.channel.send.bind(runtime.channel);
    runtime.channel.send = (message, callback) => {
      sent.push(message);
      return send(message, callback);
    };
    runtime.setModelConfig([{ provider: "instance-fixture", model: "scripted" }]);

    expect(sent.filter((message) => message.type === "modelConfig")).toEqual([]);
    expect(pacer.waiting).toBe(1);
  });

  describe("model changes on a queued remote actor (#608)", () => {
    const runStarts = (h: ReturnType<typeof setup>, id: string) =>
      h.events.flatMap((event) =>
        event.actorId === id && event.event.type === "runStart" ? [event.event] : []
      );

    it("adopts a pool without re-quoting until the mesh asks for a reschedule", async () => {
      const pacer = new ProviderPacer(0);
      pacer.deferUntil(Date.now() + 1_000);
      const h = setup({ pacer });
      const id = h.spawn("Adopt then reschedule");
      await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
      const runtime = h.runtime(id);

      // A quote under the current pool is not stale.
      expect(runtime.rescheduleQueuedRun()).toBe(false);
      // As on a local Actor, adopting a pool is a next-run assignment...
      runtime.setModelConfig([{ provider: "instance-fixture", model: "model-rescheduled" }]);
      await delay(50);
      expect(pacer.waiting).toBe(1);
      expect(runStarts(h, id)).toEqual([]);

      // ...and the reschedule is what releases the stale quote and re-admits.
      expect(runtime.rescheduleQueuedRun()).toBe(true);
      await waitUntil(() => runStarts(h, id).length === 1);
      expect(runStarts(h, id)[0]?.selected).toMatchObject({ model: "model-rescheduled" });
      expect(h.meshEvents.some((event) => event.kind === "run_abandoned")).toBe(false);
    });

    it("re-quotes an admission request that the pin overtook on the wire", async () => {
      const h = setup();
      // Hold the follower's admission request, quoted under the bootstrap pool,
      // while the leader has seen `state: queued` but holds no gate yet.
      const held: Parameters<typeof h.remote.receive>[0][] = [];
      const receive = h.remote.receive.bind(h.remote);
      let holding = true;
      h.remote.receive = (event) => {
        if (event.message.type === "request" && event.message.request.op === "admit") {
          held.push(event);
          if (holding) return;
        }
        receive(event);
      };
      const id = h.spawn("Pinned before its admission request arrives");
      await waitUntil(() => h.runtime(id).isQueued && held.length === 1);

      const pool = [{ provider: "instance-fixture", model: "model-overtaking" }];
      h.mesh.setActorModel(id, pool, "root");
      receive(held[0]);
      // The refused request's re-ask is quoted under the pin, so republishing
      // that pool while the re-ask is on the wire must not refuse it too.
      await waitUntil(() => held.length === 2);
      h.mesh.setActorModel(id, pool, "root");
      holding = false;
      receive(held[1]);

      await waitUntil(() => runStarts(h, id).length === 1);
      expect(runStarts(h, id)[0]?.selected).toMatchObject({ model: "model-overtaking" });
      expect(held).toHaveLength(2);
      expect(h.failures).toEqual([]);
    });

    it("re-quotes an admission whose queued report the pin crossed on the wire (#725)", async () => {
      const h = setup();
      // Hold the follower's queued report and its admission request, both
      // quoted under the bootstrap pool, so the leader still books it idle.
      const held: Parameters<typeof h.remote.receive>[0][] = [];
      const receive = h.remote.receive.bind(h.remote);
      h.remote.receive = (event) => {
        const { message } = event;
        if (
          (message.type === "state" && message.state === "queued") ||
          (message.type === "request" && message.request.op === "admit")
        ) {
          held.push(event);
          return;
        }
        receive(event);
      };
      const id = h.spawn("Pinned across its queued report");
      await waitUntil(() => held.length === 2);

      h.mesh.setActorModel(id, [{ provider: "instance-fixture", model: "model-crossing" }], "root");
      h.remote.receive = receive;
      for (const event of held.splice(0)) receive(event);

      await waitUntil(() => runStarts(h, id).length === 1);
      expect(runStarts(h, id)[0]?.selected).toMatchObject({ model: "model-crossing" });
      expect(h.failures).toEqual([]);
    });

    it("re-quotes an admission that names no pool, from a follower built before #725, that the pin overtook", async () => {
      const h = setup();
      // A v7/v8 follower built before #725 ignores the numbered pool and sends
      // `admit` without the generation it quoted under (the pre-echo adapter).
      const held: Parameters<typeof h.remote.receive>[0][] = [];
      const receive = h.remote.receive.bind(h.remote);
      h.remote.receive = (event) => {
        const { message } = event;
        if (message.type === "request" && message.request.op === "admit") {
          const { modelConfigGeneration: _omitted, ...preEchoRequest } = message.request;
          const preEchoEvent = { ...event, message: { ...message, request: preEchoRequest } };
          if (held.length === 0) {
            held.push(preEchoEvent);
            return;
          }
          return receive(preEchoEvent);
        }
        receive(event);
      };
      const id = h.spawn("Pinned before a pre-echo admission arrives");
      await waitUntil(() => h.runtime(id).isQueued && held.length === 1);

      h.mesh.setActorModel(id, [{ provider: "instance-fixture", model: "model-pre-echo" }], "root");
      receive(held[0]);

      await waitUntil(() => runStarts(h, id).length === 1);
      expect(runStarts(h, id)[0]?.selected).toMatchObject({ model: "model-pre-echo" });
      expect(h.failures).toEqual([]);
    });

    it("admits an unanswered request unchanged when the pin republishes its pool", async () => {
      const h = setup();
      const id = h.spawn("Republished while its admission request is on the wire");
      await waitUntil(() =>
        h.events.some((event) => event.actorId === id && event.event.type === "result")
      );
      // Pinned while idle: the next queued report is already under this pool.
      const pool = [{ provider: "instance-fixture", model: "model-pinned-idle" }];
      h.mesh.setActorModel(id, pool, "root");

      const admits: Parameters<typeof h.remote.receive>[0][] = [];
      const receive = h.remote.receive.bind(h.remote);
      let holding = true;
      h.remote.receive = (event) => {
        if (event.message.type === "request" && event.message.request.op === "admit") {
          admits.push(event);
          if (holding) return;
        }
        receive(event);
      };
      h.mesh.sendMessage(id, "Run again", "root");
      await waitUntil(() => h.runtime(id).isQueued && admits.length === 1);

      h.mesh.setActorModel(id, pool, "root");
      holding = false;
      receive(admits[0]);

      await waitUntil(() => runStarts(h, id).length === 2);
      expect(runStarts(h, id)[1]?.selected).toMatchObject({ model: "model-pinned-idle" });
      // The request was quoted under the current pool, so it is not asked again.
      expect(admits).toHaveLength(1);
    });

    it("re-quotes a request whose pool was pinned during the host-authority preflight", async () => {
      const h = setup();
      const held: Parameters<typeof h.remote.receive>[0][] = [];
      const receive = h.remote.receive.bind(h.remote);
      h.remote.receive = (event) => {
        if (event.message.type === "request" && event.message.request.op === "admit") {
          held.push(event);
          return;
        }
        receive(event);
      };
      const id = h.spawn("Pinned while its admission is in preflight");
      await waitUntil(() => h.runtime(id).isQueued && held.length === 1);

      const context = (h.runtime(id) as unknown as { opts: { context: ActorFactoryContext } }).opts
        .context;
      const admitRun = context.admitRun;
      let pinned = false;
      context.admitRun = (request) => {
        if (!pinned) {
          pinned = true;
          h.mesh.setActorModel(
            id,
            [{ provider: "instance-fixture", model: "model-in-preflight" }],
            "root"
          );
        }
        return admitRun?.(request) ?? true;
      };
      h.remote.receive = receive;
      for (const event of held.splice(0)) receive(event);

      await waitUntil(() => runStarts(h, id).length === 1);
      expect(pinned).toBe(true);
      expect(runStarts(h, id)[0]?.selected).toMatchObject({ model: "model-in-preflight" });
      expect(h.failures).toEqual([]);
    });

    it("admits and executes a remote run on the second candidate when the first is halted", async () => {
      const h = setup({
        pacer: new ProviderPacer(0),
        isHalted: (_provider, model) => model === "model-halted",
      });
      const id = h.spawn("Run on whichever candidate can", [
        { provider: "instance-fixture", model: "model-halted" },
        { provider: "instance-fixture", model: "model-second" },
      ]);
      await waitUntil(() =>
        h.events.some(
          (event) =>
            event.actorId === id && event.event.type === "result" && event.event.result.success
        )
      );
      expect(runStarts(h, id).map((event) => event.selected)).toEqual([
        expect.objectContaining({ model: "model-second" }),
      ]);
      // The follower built and ran the provider for the admitted tuple.
      expect(
        h.events.find((event) => event.actorId === id && event.event.type === "result")?.event
      ).toMatchObject({ result: { model: "model-second" } });
      expect(h.failures).toEqual([]);
    });

    it("parks a queued remote run pinned onto a halted pool and replays it on unhalt", async () => {
      let haltedModel: string | undefined;
      const pacer = new ProviderPacer(0);
      pacer.deferUntil(Date.now() + 1_000);
      const h = setup({ pacer, isHalted: (_provider, model) => model === haltedModel });
      const id = h.spawn("Pinned onto a halted pool");
      await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);

      haltedModel = "model-halted";
      h.mesh.setActorModel(id, [{ provider: "instance-fixture", model: "model-halted" }], "root");
      // The same boundary as a local Actor: cancel and retain, never re-quote
      // the opportunity into a pool that cannot run.
      await waitUntil(
        () =>
          h.meshEvents.some(
            (event) =>
              event.kind === "run_abandoned" &&
              event.actorId === id &&
              event.detail === "start-cancelled"
          ) && !h.runtime(id).isQueued
      );
      // The parked run gave its place in pacing back.
      expect(pacer.waiting).toBe(0);
      await delay(100);
      expect(runStarts(h, id)).toEqual([]);

      haltedModel = undefined;
      expect(h.mesh.resumeCancelledRuns()).toEqual([id]);
      await waitUntil(() => runStarts(h, id).length === 1);
      expect(runStarts(h, id)[0]?.selected).toMatchObject({ model: "model-halted" });
    });
  });

  it("executes the follower provider constructed for a staged pin", async () => {
    const executedModels: string[] = [];
    const constructedModels: string[] = [];
    let releaseInitialRun: (() => void) | undefined;
    let initialRunStarted = false;
    const h = setup({
      providerFactory: (_bridge, _options, selected) => {
        constructedModels.push(selected?.model ?? "missing");
        return {
          name: "instance-fixture",
          providerName: "instance-fixture",
          model: selected?.model,
          async run() {
            executedModels.push(selected?.model ?? "missing");
            if (!initialRunStarted) {
              initialRunStarted = true;
              await new Promise<void>((resolve) => {
                releaseInitialRun = resolve;
              });
            }
            return { success: true, output: "", exitCode: 0, model: selected?.model };
          },
        };
      },
    });
    const id = h.spawn("Execute the staged follower pin");
    await waitUntil(() => initialRunStarted && h.runtime(id).isRunning);

    h.mesh.setActorModel(
      id,
      [{ provider: "instance-fixture", model: "model-pinned-executed" }],
      "root"
    );
    releaseInitialRun?.();
    await waitUntil(() =>
      h.events.some((event) => event.actorId === id && event.event.type === "result")
    );
    await waitUntil(() => h.actors.get(id)?.modelConfig?.[0]?.model === "model-pinned-executed");
    h.inboxStore.append([
      { actorId: id, source: "test:durable-executed-pin", payload: { type: "test.work" } },
    ]);
    h.mesh.dispatch(id);

    await waitUntil(
      () =>
        h.events.filter((event) => event.actorId === id && event.event.type === "result").length ===
        2
    );
    expect({ constructedModels, executedModels }).toEqual({
      constructedModels: ["scripted", "model-pinned-executed"],
      executedModels: ["scripted", "model-pinned-executed"],
    });
  });

  it("re-quotes a retained follower admission after a model pin during a lease flap", async () => {
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 1_000);
    const h = setup({ pacer });
    const id = h.spawn("Re-quote retained follower admission");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
    const queued = h.events.find(
      (event) => event.actorId === id && event.event.type === "queued"
    )?.event;

    h.remote.close();
    await h.runtime(id).exited;
    h.mesh.setActorModel(
      id,
      [{ provider: "instance-fixture", model: "model-pinned-retained" }],
      "root"
    );

    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));
    await waitUntil(() =>
      h.events.some((event) => event.actorId === id && event.event.type === "runStart")
    );
    const started = h.events.find(
      (event) => event.actorId === id && event.event.type === "runStart"
    )?.event;
    expect(started?.type === "runStart" && started.selected).toMatchObject({
      model: "model-pinned-retained",
    });
    expect(started?.type === "runStart" && started.runId).toBe(
      queued?.type === "queued" && queued.runId
    );
    expect(h.meshEvents.some((event) => event.kind === "run_abandoned")).toBe(false);
  });

  it("keeps genuine close() permanently terminated and never re-dispatches", async () => {
    const h = setup();
    const id = h.spawn("Charter Negative");
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);
    await waitUntil(() => h.events.some((e) => e.actorId === id && e.event.type === "result"));

    // Genuine close() called
    h.runtime(id).close();
    h.remote.close();
    await h.runtime(id).exited;

    // Reattach attempt must be refused with remote_attach_after_close
    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));
    expect(h.logs).toContainEqual(
      expect.objectContaining({
        event: "remote_attach_after_close",
        fields: expect.objectContaining({ actorId: id }),
      })
    );

    // Attempting to dispatch must drop wake and never start
    h.inboxStore.append([{ actorId: id, source: "test:negative", payload: { type: "test.work" } }]);
    h.mesh.dispatch(id);
    expect(h.events.filter((e) => e.actorId === id && e.event.type === "runStart")).toHaveLength(1);
  });

  describe("operator interrupt and halt cancellation (#607)", () => {
    const queuedRunId = (h: ReturnType<typeof setup>, id: string) => {
      const queued = h.events.find((e) => e.actorId === id && e.event.type === "queued")?.event;
      return queued?.type === "queued" ? queued.runId : undefined;
    };
    const abandoned = (h: ReturnType<typeof setup>, id: string) =>
      h.meshEvents.filter((e) => e.kind === "run_abandoned" && e.actorId === id);
    const started = (h: ReturnType<typeof setup>, id: string) =>
      h.events.filter((e) => e.actorId === id && e.event.type === "runStart");
    const finished = (h: ReturnType<typeof setup>, id: string) =>
      h.events.some((e) => e.actorId === id && e.event.type === "result");

    it("cancels a queued remote run via mesh.interrupt and books start-cancelled", async () => {
      const h = setup({ delayMs: 300 });
      const first = h.spawn("Occupy the only admission slot");
      await waitUntil(() => h.runtime(first).isRunning);
      const second = h.spawn("Queued worker");
      await waitUntil(() => h.runtime(second).isQueued);
      const runId = queuedRunId(h, second);
      expect(runId).toBeTruthy();

      expect(h.mesh.interrupt(second, "human:operator")).toEqual({ interrupted: true });
      expect(h.runtime(second).isQueued).toBe(false);
      expect(h.runtime(second).getInterruptedWatermark()).not.toBeNull();
      expect(h.meshEvents).toContainEqual(
        expect.objectContaining({ kind: "root_control_action", actorId: second })
      );

      // The follower books the cancelled start once, under the run id it queued.
      await waitUntil(() => abandoned(h, second).length === 1);
      expect(abandoned(h, second)[0]).toMatchObject({
        detail: "start-cancelled",
        payload: JSON.stringify({ started: false, runId }),
      });
      // Its admission left the concurrency queue: when the slot frees, it does not run.
      await waitUntil(() => finished(h, first));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(started(h, second)).toEqual([]);
      expect(abandoned(h, second)).toHaveLength(1);
      expect(h.failures).toEqual([]);
    });

    it("interrupts a running remote actor via mesh.interrupt and honors the watermark", async () => {
      const h = setup({ delayMs: 5_000 });
      const id = h.spawn("Run long");
      await waitUntil(() => h.runtime(id).isRunning);
      const before = Date.now();

      expect(h.mesh.interrupt(id, "human:operator")).toEqual({ interrupted: true });
      expect(h.meshEvents).toContainEqual(
        expect.objectContaining({ kind: "root_control_action", actorId: id })
      );

      // The follower aborted the provider call instead of letting it run out.
      await waitUntil(() => finished(h, id));
      expect(Date.now() - before).toBeLessThan(4_000);
      const result = h.events.find((e) => e.actorId === id && e.event.type === "result")?.event;
      expect(result?.type === "result" && result.result.success).toBe(false);
      expect(h.follower.actorIds).toContain(id);

      // Work that predates the interrupted run does not wake it again...
      await waitUntil(() => !h.runtime(id).isRunning);
      h.mesh.dispatch(id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(started(h, id)).toHaveLength(1);
      // ...while newer work does.
      h.dispatchNormal(id);
      await waitUntil(() => started(h, id).length === 2);
      expect(h.runtime(id).getInterruptedWatermark()).toBeNull();
    });

    it("cancels a queued remote run when its provider is halted and replays it after unhalt", async () => {
      let halted = false;
      const h = setup({ delayMs: 300, isHalted: () => halted });
      const first = h.spawn("Occupy the only admission slot");
      await waitUntil(() => h.runtime(first).isRunning);
      const second = h.spawn("Queued behind the halt");
      await waitUntil(() => h.runtime(second).isQueued);

      halted = true;
      expect(h.mesh.cancelHaltedQueuedRuns()).toEqual([second]);
      await waitUntil(() => abandoned(h, second).length === 1 && !h.runtime(second).isQueued);
      expect(abandoned(h, second)[0]).toMatchObject({ detail: "start-cancelled" });
      await waitUntil(() => finished(h, first));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(started(h, second)).toEqual([]);

      halted = false;
      expect(h.mesh.resumeCancelledRuns()).toEqual([second]);
      await waitUntil(() =>
        h.events.some(
          (e) => e.actorId === second && e.event.type === "result" && e.event.result.success
        )
      );
      expect(started(h, second)).toHaveLength(1);
      // Replay is one-shot.
      expect(h.mesh.resumeCancelledRuns()).toEqual([]);
    });

    it("cancels a retained admission halted during a lease flap and replays it after unhalt", async () => {
      let halted = false;
      const pacer = new ProviderPacer(0);
      pacer.deferUntil(Date.now() + 400);
      const h = setup({ pacer, isHalted: () => halted });
      const id = h.spawn("Wait out the pacing gap");
      await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);
      const runId = queuedRunId(h, id);

      h.remote.close();
      await h.runtime(id).exited;
      halted = true;
      expect(h.mesh.cancelHaltedQueuedRuns()).toEqual([id]);
      // The leader books the ticket it gave up; nothing else is left to report it.
      await waitUntil(() => abandoned(h, id).length === 1);
      expect(abandoned(h, id)[0]).toMatchObject({
        detail: "start-cancelled",
        payload: JSON.stringify({ started: false, runId }),
      });
      expect(pacer.waiting).toBe(0);

      const reconnect = h.reconnect();
      h.runtime(id).attachHost(reconnect.createHost(id));
      await expect(h.runtime(id).ready).resolves.toBe(process.pid);
      await waitUntil(() => !h.runtime(id).isQueued);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(started(h, id)).toEqual([]);
      expect(abandoned(h, id)).toHaveLength(1);

      halted = false;
      expect(h.mesh.resumeCancelledRuns()).toEqual([id]);
      await waitUntil(() =>
        h.events.some(
          (e) => e.actorId === id && e.event.type === "result" && e.event.result.success
        )
      );
      expect(abandoned(h, id)).toHaveLength(1);
      // The reattach re-dispatch (#613) and the unhalt replay share one run.
      expect(started(h, id)).toHaveLength(1);
    });

    it("keeps a replay requested during a transport gap until the follower reattaches", async () => {
      let halted = false;
      const pacer = new ProviderPacer(0);
      pacer.deferUntil(Date.now() + 400);
      const h = setup({ pacer, isHalted: () => halted });
      const id = h.spawn("Wait out the pacing gap");
      await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);

      h.remote.close();
      await h.runtime(id).exited;
      halted = true;
      expect(h.mesh.cancelHaltedQueuedRuns()).toEqual([id]);
      await waitUntil(() => abandoned(h, id).length === 1);

      // Unhalted, re-halted, and unhalted again before the follower is back:
      // the second halt parks the replay rather than letting it launch.
      halted = false;
      expect(h.mesh.resumeCancelledRuns()).toEqual([id]);
      halted = true;
      expect(h.mesh.cancelHaltedQueuedRuns()).toEqual([id]);
      halted = false;
      expect(h.mesh.resumeCancelledRuns()).toEqual([id]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(started(h, id)).toEqual([]);

      const reconnect = h.reconnect();
      h.runtime(id).attachHost(reconnect.createHost(id));
      await expect(h.runtime(id).ready).resolves.toBe(process.pid);
      await waitUntil(() =>
        h.events.some(
          (e) => e.actorId === id && e.event.type === "result" && e.event.result.success
        )
      );
      expect(started(h, id)).toHaveLength(1);
      expect(abandoned(h, id)).toHaveLength(1);
      expect(h.mesh.resumeCancelledRuns()).toEqual([]);
    });

    it("cancels a queued remote run whose admission request has not reached the leader", async () => {
      let interrupted: { interrupted: boolean } | undefined;
      const h: ReturnType<typeof setup> = setup({
        onEvent: (actorId, event) => {
          // The queued report precedes the admission request on the same channel.
          if (event.type === "queued" && !interrupted) {
            expect(h.runtime(actorId).isQueued).toBe(true);
            interrupted = h.mesh.interrupt(actorId, "human:operator");
          }
        },
      });
      const id = h.spawn("Interrupted before its admission request arrives");
      await waitUntil(() => interrupted !== undefined);
      expect(interrupted).toEqual({ interrupted: true });
      expect(h.runtime(id).isQueued).toBe(false);

      await waitUntil(() => abandoned(h, id).length === 1);
      expect(abandoned(h, id)[0]).toMatchObject({
        detail: "start-cancelled",
        payload: JSON.stringify({ started: false, runId: queuedRunId(h, id) }),
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(started(h, id)).toEqual([]);
      expect(h.failures).toEqual([]);
    });

    it("withdraws a halt cancellation the follower has not seen when unhalted first", async () => {
      let halted = false;
      let cancelled: string[] | undefined;
      let resumed: string[] | undefined;
      const h: ReturnType<typeof setup> = setup({
        isHalted: () => halted,
        onEvent: (actorId, event) => {
          // Halt and unhalt between the queued report and the admission request.
          if (event.type === "queued" && !cancelled) {
            halted = true;
            cancelled = h.mesh.cancelHaltedQueuedRuns();
            halted = false;
            resumed = h.mesh.resumeCancelledRuns();
            expect([cancelled, resumed]).toEqual([[actorId], [actorId]]);
          }
        },
      });
      const id = h.spawn("Halted and unhalted before its admission request arrives");
      await waitUntil(() =>
        h.events.some(
          (e) => e.actorId === id && e.event.type === "result" && e.event.result.success
        )
      );
      expect(started(h, id)).toHaveLength(1);
      expect(abandoned(h, id)).toEqual([]);
      expect(h.mesh.resumeCancelledRuns()).toEqual([]);
      expect(h.failures).toEqual([]);
    });

    it("refuses an admitted start that the interrupt reaches before the provider launches", async () => {
      const h = setup({ delayMs: 300 });
      const id = h.spawn("Interrupted between admission and launch");
      const runtime = h.runtime(id);
      const send = runtime.channel.send.bind(runtime.channel);
      let interrupted: { interrupted: boolean } | undefined;
      runtime.channel.send = ((message: LeaderCommand, callback: (error: Error | null) => void) => {
        const sent = send(message, callback);
        // The admission reply carries the reserved candidate; interrupt right behind it.
        if (
          !interrupted &&
          message.type === "reply" &&
          message.value &&
          typeof message.value === "object" &&
          "selected" in message.value
        ) {
          interrupted = h.mesh.interrupt(id, "human:operator");
        }
        return sent;
      }) as typeof runtime.channel.send;

      await waitUntil(() => interrupted !== undefined);
      expect(interrupted).toEqual({ interrupted: true });
      await waitUntil(() => abandoned(h, id).length === 1);
      expect(abandoned(h, id)[0]).toMatchObject({ detail: "start-cancelled" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(started(h, id)).toEqual([]);
      expect(finished(h, id)).toBe(false);
    });

    it("keeps the watermark when the interrupted run's runStart arrives after the interrupt", async () => {
      let interrupted: { interrupted: boolean } | undefined;
      const h: ReturnType<typeof setup> = setup({
        delayMs: 2_000,
        onEvent: (actorId, event) => {
          // The follower reports running before its runStart, so this lands in between.
          if (event.type === "state" && event.state === "running" && !interrupted) {
            interrupted = h.mesh.interrupt(actorId, "human:operator");
          }
        },
      });
      const id = h.spawn("Run long");
      await waitUntil(() => finished(h, id));
      expect(interrupted).toEqual({ interrupted: true });
      expect(started(h, id)).toHaveLength(1);
      expect(h.runtime(id).getInterruptedWatermark()).not.toBeNull();

      // The work the interrupted run held does not wake it again...
      await waitUntil(() => !h.runtime(id).isRunning);
      h.mesh.dispatch(id);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(started(h, id)).toHaveLength(1);
      // ...while newer work does, and that run clears the watermark.
      h.dispatchNormal(id);
      await waitUntil(() => started(h, id).length === 2);
      expect(h.runtime(id).getInterruptedWatermark()).toBeNull();
    });

    it("redispatches work delivered after admission when runStart has already arrived", async () => {
      const h = setup({ delayMs: 2_000 });
      const id = h.spawn("Run long");
      const runtime = h.runtime(id);
      const send = runtime.channel.send.bind(runtime.channel);
      let delivered = false;
      runtime.channel.send = ((message: LeaderCommand, callback: (error: Error | null) => void) => {
        const sent = send(message, callback);
        // The admission reply's snapshot is the run's prompt; this work misses it.
        if (
          !delivered &&
          message.type === "reply" &&
          message.value &&
          typeof message.value === "object" &&
          "selected" in message.value
        ) {
          delivered = true;
          const until = Date.now() + 5;
          while (Date.now() < until) {}
          h.dispatchNormal(id, "test:after-admission");
        }
        return sent;
      }) as typeof runtime.channel.send;

      await waitUntil(() => started(h, id).length === 1);
      expect(h.mesh.interrupt(id, "human:operator")).toEqual({ interrupted: true });
      await waitUntil(() => started(h, id).length === 2);
      expect(h.runtime(id).getInterruptedWatermark()).toBeNull();
    });

    it("redispatches work delivered after the remote start when runStart has not arrived", async () => {
      let interrupted: { interrupted: boolean } | undefined;
      const h: ReturnType<typeof setup> = setup({
        delayMs: 2_000,
        onEvent: (actorId, event) => {
          if (event.type === "state" && event.state === "running" && !interrupted) {
            // Deliver strictly after the admission in wall-clock ms, then interrupt.
            const until = Date.now() + 5;
            while (Date.now() < until) {}
            h.dispatchNormal(actorId, "test:after-start");
            interrupted = h.mesh.interrupt(actorId, "human:operator");
          }
        },
      });
      const id = h.spawn("Run long");
      await waitUntil(() => interrupted !== undefined);
      expect(interrupted).toEqual({ interrupted: true });
      // The watermark is the admission, not the interrupt, so this work is not hidden.
      await waitUntil(() => started(h, id).length === 2);
      expect(h.runtime(id).getInterruptedWatermark()).toBeNull();
    });
  });

  it.each([
    ["leaves its selected head as found", false],
    ["closes its selected head", true],
  ] as const)("checks strict head closure when a follower run that %s returns (#828)", async (_label, closes) => {
    const db = new Database(":memory:");
    onTestFinished(() => {
      db.close();
    });
    runMigrations(db);
    const repo = new ObligationRepository(db);
    const enrollments = new InMemoryExperimentEnrollmentStore();
    const h = setup({
      delayMs: 300,
      experimentEnrollments: enrollments,
      obligations: {
        findLiveByExternalRef: (ref) => repo.findLiveByExternalRef(ref),
        get: (id) => repo.get(id),
        listDirectChildEdges: (parentId) => repo.listDirectChildEdges(parentId),
        listPrerequisiteEdges: (dependentId) => repo.listPrerequisiteEdges(dependentId),
        expireDueSnoozes: (ids) => repo.expireDueSnoozes(ids, "system:mesh"),
      },
    });
    h.capabilityGrants.grant({
      actorId: "root",
      capability: EXPERIMENT_ADMIN_CAPABILITY,
      grantedBy: "root",
      grantedAt: "2026-10-01T00:00:00Z",
    });
    const id = h.mesh.spawn({
      charter: "strict follower",
      parentId: "root",
      modelConfig: { provider: "instance-fixture", model: "scripted" },
    });
    h.mesh.enrollActorInExperiment(id, STRICT_OBLIGATION_HANDLING_EXPERIMENT, "root");
    repo.create({ id: "remote-head", title: "Remote head", ownerId: id });
    h.mesh.deliverReadyHeadAttention(id, { id: "remote-head", intent: "handle it" }, null);
    await waitUntil(() => h.runtime(id).isRunning);

    // Selected mid-run on the leader, exactly as the follower's inbox MCP call
    // lands there.
    const entry = h.inboxStore
      .list(id)
      .entries.find((candidate) => candidate.payload.type === "obligation.ready_head");
    if (!entry) throw new Error("expected ready-head inbox entry");
    h.mesh.selectInboxEntries(id, [entry.id]);
    if (closes) {
      repo.setTerminalStatus("remote-head", "done", null, null, "system:mesh");
      h.mesh.assertInboxEntriesHandleable(id, [entry.id]);
      h.inboxStore.markHandled(id, [entry.id]);
    } else {
      expect(() => h.mesh.assertInboxEntriesHandleable(id, [entry.id])).toThrow(
        /Cannot mark handled: selected head obligation remote-head/
      );
    }

    await waitUntil(
      () =>
        h.events.some((event) => event.actorId === id && event.event.type === "result") &&
        h.mesh.selectedInboxEntries(id).length === 0
    );
    const rejections = h.meshEvents.filter(
      (event) => event.kind === "run_return_rejected" && event.actorId === id
    );
    expect(rejections).toEqual(
      closes
        ? []
        : [
            expect.objectContaining({
              detail: "Return rejected for head obligation remote-head: obligation is still ready",
            }),
          ]
    );
    expect(Boolean(h.inboxStore.read(id, entry.id)?.handledAt)).toBe(closes);
  });

  it("normalizes an admitted v7/v8 follower's winding_down state to running (#828)", async () => {
    const h = setup({ delayMs: 300 });
    const id = h.mesh.spawn({
      charter: "legacy follower",
      parentId: "root",
      modelConfig: { provider: "instance-fixture", model: "scripted" },
    });
    // Synthesize an older follower reporting winding_down while its provider is alive
    h.remote.receive({
      actorId: id,
      message: { type: "state", state: "winding_down" as const },
    });
    expect(h.mesh.activeRunState(id)).toEqual({ actorId: id, phase: "running" });
    expect(() => h.mesh.retire(id)).toThrow(/cannot retire/);
  });
});
