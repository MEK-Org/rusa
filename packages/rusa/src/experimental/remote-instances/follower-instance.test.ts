import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, waitUntil } from "./harness.js";

const instances: ReturnType<typeof createHarness>[] = [];
const dirs: string[] = [];
function setup(options: { delayMs?: number; failInit?: boolean } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "rusa-follower-unit-"));
  dirs.push(cwd);
  const h = createHarness({
    cwd,
    delayMs: options.delayMs ?? 25,
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
