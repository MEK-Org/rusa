import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderPacer } from "../../actor/provider-pacer.js";
import { createHarness, waitUntil } from "./harness.js";

const instances: ReturnType<typeof createHarness>[] = [];
const dirs: string[] = [];
function setup(options: { delayMs?: number; failInit?: boolean; pacer?: ProviderPacer } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "rusa-follower-unit-"));
  dirs.push(cwd);
  const h = createHarness({
    cwd,
    delayMs: options.delayMs ?? 25,
    pacer: options.pacer,
    providerFactory: options.failInit
      ? () => {
          throw new Error("test provider initialization failed");
        }
      : undefined,
  });
  instances.push(h);
  return h;
}
afterEach(async () => {
  for (const h of instances.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("monolithic follower instance", () => {
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

    h.mesh.notifyInboxChanged(id, { priority: "responsive" });

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

    h.mesh.notifyInboxChanged(queued, { priority: "responsive" });

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

    h.mesh.notifyInboxChanged(queued, { priority: "responsive" });
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
    h.mesh.notifyInboxChanged(id, { priority: "responsive" });
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
    // What start.ts does on register: re-derive the wake from the durable inbox.
    h.mesh.notifyInboxChanged(id, { priority: "responsive" });
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
    h.mesh.notifyInboxChanged(id, { priority: "responsive" });

    const beforeReattach = h.events.length;
    const reconnect = h.reconnect();
    h.runtime(id).attachHost(reconnect.createHost(id));
    h.mesh.notifyInboxChanged(id, { priority: "responsive" });
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
    h.mesh.notifyInboxChanged(queued, { priority: "responsive" });

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

    // What start.ts does on register: re-derives normal priority wake from durable inbox
    h.mesh.notifyInboxChanged(id);

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

  it("books a retained queued admission as start-cancelled if a fresh admission replaces it on reconnect", async () => {
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

    // Reconnect without inviting resume (simulate follower reconnecting without resumeAdmission)
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

    // Queue fresh work on the reconnected follower
    h.mesh.sendMessage(id, "Next run work", "root");

    // Follower re-queues fresh work and runs
    await waitUntil(() =>
      h.events.some((event) => event.actorId === id && event.event.type === "runStart")
    );
    const started = h.events.find(
      (event) => event.actorId === id && event.event.type === "runStart"
    )?.event;
    expect(started?.type === "runStart" && started.runId).toBeTruthy();
    expect(started?.type === "runStart" && started.runId).not.toBe(oldRunId);

    // The old retained admission was cancelled and booked as abandoned start-cancelled
    expect(h.meshEvents).toContainEqual(
      expect.objectContaining({
        kind: "run_abandoned",
        actorId: id,
        detail: "start-cancelled",
      })
    );
    await waitUntil(() =>
      h.events.some(
        (event) =>
          event.actorId === id && event.event.type === "result" && event.event.result.success
      )
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
});
