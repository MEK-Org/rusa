import { describe, expect, it } from "vitest";
import { GracefulShutdown } from "../actor/graceful-shutdown.js";
import { MeshDrainer, waitForQuiescence } from "./drain.js";

function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

describe("waitForQuiescence", () => {
  it("returns immediately when already quiescent", async () => {
    const res = await waitForQuiescence(() => true, { timeoutMs: 60_000, ...fakeClock() });
    expect(res).toEqual({ quiesced: true, waitedMs: 0 });
  });

  it("is BOUNDED: gives up at the deadline", async () => {
    const res = await waitForQuiescence(() => false, {
      timeoutMs: 5000,
      intervalMs: 1000,
      ...fakeClock(),
    });
    expect(res).toEqual({ quiesced: false, waitedMs: 5000 });
  });

  it("crosses a macrotask before the first check (never trusts a stale 'idle' read)", async () => {
    // Mimic the elder's race: a run committed just before the brake whose
    // `executing` flag is set one MICROTASK later. At synchronous call time it reads
    // idle; a pending microtask makes it busy. The fixed function crosses a macrotask
    // first, so the microtask has run and it must NOT report quiesced.
    let running = false;
    Promise.resolve().then(() => {
      running = true;
    });
    const res = await waitForQuiescence(() => !running, { timeoutMs: 20, intervalMs: 5 });
    expect(res.quiesced).toBe(false); // would be true (waitedMs 0) on a synchronous fast-path
  });

  it("resolves as soon as the predicate flips", async () => {
    let n = 0;
    const res = await waitForQuiescence(() => ++n >= 3, {
      timeoutMs: 60_000,
      intervalMs: 1000,
      ...fakeClock(),
    });
    expect(res.quiesced).toBe(true);
    expect(res.waitedMs).toBe(2000);
  });
});

describe("MeshDrainer — self-excluding barrier (deadlock regression)", () => {
  const ROOT = "root";

  it("quiesces immediately when ONLY self (root) is running — does NOT deadlock", async () => {
    // The exact deadlock the elder flagged: the tool runs in root's own run, so
    // root is in runningThreadIds. A naive "wait until empty" waits on itself.
    const drainer = new MeshDrainer(new GracefulShutdown(), () => new Set([ROOT]), ROOT, 5);
    const res = await drainer.waitForQuiescence(5000);
    expect(res.quiesced).toBe(true);
    // Self excluded → quiesces on the first check (after one macrotask tick), never
    // loops/deadlocks. waitedMs is ~0 (well under the 5ms interval), not a long wait.
    expect(res.waitedMs).toBeLessThan(50);
  });

  it("waits while ANOTHER actor runs, then quiesces once it clears", async () => {
    const running = new Set([ROOT, "worker-1"]);
    const drainer = new MeshDrainer(new GracefulShutdown(), () => new Set(running), ROOT, 5);
    const p = drainer.waitForQuiescence(10_000);
    // worker-1 finishes its in-flight run
    running.delete("worker-1");
    const res = await p;
    expect(res.quiesced).toBe(true);
  });

  it("times out (bounded) if another actor never clears — exit anyway", async () => {
    const drainer = new MeshDrainer(
      new GracefulShutdown(),
      () => new Set([ROOT, "stuck"]),
      ROOT,
      5
    );
    const res = await drainer.waitForQuiescence(20);
    expect(res.quiesced).toBe(false);
    expect(res.waitedMs).toBeGreaterThanOrEqual(20);
  });

  it("engage/cancel drive the in-memory gracefulShutdown brake directly", () => {
    const g = new GracefulShutdown();
    const drainer = new MeshDrainer(g, () => new Set([ROOT]), ROOT);
    drainer.engage("update");
    expect(g.isShuttingDown()).toBe(true);
    drainer.cancel();
    expect(g.isShuttingDown()).toBe(false);
  });
});
