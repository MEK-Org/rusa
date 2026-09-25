import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderPacer } from "../../actor/provider-pacer.js";
import { FollowerInstance } from "./follower-instance.js";
import { createHarness, waitUntil } from "./harness.js";
import type { LeaderCommand, ProviderFactory } from "./protocol.js";

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
    providerFactory: options.failInit
      ? () => {
          throw new Error("test provider initialization failed");
        }
      : options.providerFactory,
  });
  instances.push(h);
  return h;
}
afterEach(async () => {
  for (const h of instances.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("monolithic follower instance", () => {
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

  it("applies a staged model pin on a running follower-hosted actor at next-run boundary without leader restart", async () => {
    const h = setup();
    const id = h.spawn("Charter D");
    await expect(h.runtime(id).ready).resolves.toBe(process.pid);
    await waitUntil(() => h.events.some((e) => e.actorId === id && e.event.type === "result"));

    // Pin model via mesh.setActorModel
    h.mesh.setActorModel(id, [{ provider: "instance-fixture", model: "model-pinned-d" }], "root");

    // Next run dispatched without leader restart or follower re-registration
    h.inboxStore.append([
      { actorId: id, source: "test:durable-d", payload: { type: "test.work" } },
    ]);
    h.mesh.dispatch(id);

    await waitUntil(
      () => h.events.filter((e) => e.actorId === id && e.event.type === "result").length === 2
    );
    const starts = h.events.filter((e) => e.actorId === id && e.event.type === "runStart");
    expect(starts).toHaveLength(2);
    const startEvent = starts[1]?.event;
    if (startEvent && startEvent.type === "runStart") {
      expect(startEvent.selected).toMatchObject({ model: "model-pinned-d" });
    } else {
      expect.fail("Expected second event to be runStart");
    }
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
});
