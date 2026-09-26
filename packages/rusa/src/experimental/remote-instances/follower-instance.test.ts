import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_USE_CAPABILITY } from "../../actor/computer-use-lock.js";
import { ProviderPacer } from "../../actor/provider-pacer.js";
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

const capabilityBoundaryProvider: ProviderFactory = (bridge, _options, selected) => ({
  name: "instance-fixture",
  providerName: "instance-fixture",
  model: selected?.model,
  async run(run) {
    const prompt = JSON.parse(run.prompt) as { charter: string; parentId: string };
    await delay(prompt.charter === "short provider blocker" ? 80 : 700, undefined, {
      signal: run.signal,
    });
    await bridge.sendMessage(prompt.parentId, prompt.charter);
    bridge.yieldRun("complete", "capability boundary fixture complete");
    return {
      success: true,
      output: prompt.charter,
      exitCode: 0,
      sessionId: run.session?.id,
      model: selected?.model,
    };
  },
});

describe("monolithic follower instance", () => {
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
            bridge.yieldRun("complete", "computer use fixture complete");
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
    const h = setup({
      delayMs: 0,
      maxConcurrent: 2,
      providerFactory: capabilityBoundaryProvider,
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
    await waitUntil(() =>
      h.events.some((event) => event.actorId === blocker && event.event.type === "result")
    );
    // The target is now provider-admitted but must wait for the current
    // computer holder: the grant happened after beforeRun, while it paced.
    expect(
      h.events.some((event) => event.actorId === target && event.event.type === "runStart")
    ).toBe(false);
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
    expect(h.failures).toEqual([]);
  });

  it("does not retain a revoked computer-use capability through provider pacing", async () => {
    const h = setup({
      delayMs: 0,
      maxConcurrent: 2,
      providerFactory: capabilityBoundaryProvider,
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
    await waitUntil(() =>
      h.events.some((event) => event.actorId === target && event.event.type === "runStart")
    );

    const holderResult = h.events.findIndex(
      (event) => event.actorId === holder && event.event.type === "result"
    );
    const targetStart = h.events.findIndex(
      (event) => event.actorId === target && event.event.type === "runStart"
    );
    expect(holderResult).toBe(-1);
    expect(targetStart).toBeGreaterThanOrEqual(0);
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
    const pacer = new ProviderPacer(0);
    pacer.deferUntil(Date.now() + 100);
    const h = setup({ pacer });

    const id = h.spawn("Pacing timeout while disconnected");
    await waitUntil(() => h.runtime(id).isQueued && pacer.waiting === 1);

    // Transport drops
    h.remote.close();
    await h.runtime(id).exited;

    // Do not reconnect; wait for pacing to turn while disconnected
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
});
