import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TriggerRunner } from "./trigger-runner.js";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("TriggerRunner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts promptly without debounce by default", async () => {
    const runs: unknown[] = [];
    const runner = new TriggerRunner({
      run: async (nudge) => void runs.push(nudge),
    });
    runner.requestRun();
    expect(runs).toHaveLength(0);
    runner.requestRun();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(runs).toHaveLength(1);
  });

  it("coalesces pre-run nudges when explicitly debounced", async () => {
    const runs: unknown[] = [];
    const runner = new TriggerRunner({
      debounceMs: 10,
      run: async (nudge) => void runs.push(nudge),
    });
    runner.requestRun();
    runner.requestRun({ priority: "responsive" });
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toEqual([{ priority: "responsive", mode: "ordinary" }]);
  });

  it("retains one dirty follow-up while a run is active", async () => {
    let release!: () => void;
    const runs: unknown[] = [];
    const runner = new TriggerRunner({
      debounceMs: 10,
      run: async (nudge) => {
        runs.push(nudge);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    runner.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    runner.requestRun();
    runner.requestRun();
    release();
    await flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(runs).toHaveLength(2);
  });

  it("retains one dirty follow-up for production default while a run is active", async () => {
    let release!: () => void;
    let concurrent = 0;
    let maxConcurrent = 0;
    const runs: unknown[] = [];
    const runner = new TriggerRunner({
      run: async (nudge) => {
        concurrent++;
        if (concurrent > maxConcurrent) maxConcurrent = concurrent;
        runs.push(nudge);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        concurrent--;
      },
    });

    runner.requestRun();
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    runner.requestRun();
    runner.requestRun();
    runner.requestRun();

    release();
    await flush();
    await vi.advanceTimersByTimeAsync(0);

    release();
    await flush();

    expect(maxConcurrent).toBe(1);
    expect(runs).toHaveLength(2);
  });

  it("quick-starts voice nudges", async () => {
    const run = vi.fn(async () => {});
    const runner = new TriggerRunner({ debounceMs: 30_000, run });
    runner.requestRun({ priority: "responsive", voiceTimestamp: Date.now() });
    await flush();
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs a content-free onIdle continuation", async () => {
    const runs: unknown[] = [];
    let continued = false;
    const runner = new TriggerRunner({
      debounceMs: 10,
      run: async (nudge) => void runs.push(nudge),
      onIdle: () => {
        if (continued) return null;
        continued = true;
        return { mode: "yield-elicitation" };
      },
    });
    runner.requestRun();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    expect(runs).toEqual([{}, { mode: "yield-elicitation" }]);
  });
});
