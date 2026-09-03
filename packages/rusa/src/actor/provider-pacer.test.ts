import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import { ProviderPacer } from "./provider-pacer.js";

describe("ProviderPacer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts its interval when the mesh queue actually starts the run", async () => {
    const base = Date.now();
    const mesh = new ConcurrencyLimiter(1);
    let release!: () => void;
    void mesh.run(() => new Promise<void>((resolve) => (release = resolve)));
    await Promise.resolve();

    const starts: number[] = [];
    const pacer = new ProviderPacer(1_000, () => Date.now());
    const first = pacer.submit(async () => 1, {
      enqueueNormal: (fn) => mesh.enqueue(fn),
      onStarted: () => starts.push(Date.now()),
    });
    const second = pacer.submit(async () => 2, {
      enqueueNormal: (fn) => mesh.enqueue(fn),
      onStarted: () => starts.push(Date.now()),
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(starts).toEqual([]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([base + 5_000]);

    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([base + 5_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([base + 5_000, base + 6_000]);
    await expect(first.result).resolves.toBe(1);
    await expect(second.result).resolves.toBe(2);
  });

  it("promotes a provider-waiting normal run and charges its responsive start", async () => {
    const mesh = new ConcurrencyLimiter(1);
    const pacer = new ProviderPacer(10_000, () => Date.now());
    await pacer.submit(async () => 1, { enqueueNormal: (fn) => mesh.enqueue(fn) }).result;

    const promoted = pacer.submit(async () => 2, {
      enqueueNormal: (fn) => mesh.enqueue(fn),
    });
    promoted.promote();
    await vi.advanceTimersByTimeAsync(0);
    await expect(promoted.result).resolves.toBe(2);

    const next = pacer.submit(async () => 3, { enqueueNormal: (fn) => mesh.enqueue(fn) });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(next.started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(next.result).resolves.toBe(3);
  });

  it("promotes a run out of a saturated mesh queue without consuming normal capacity", async () => {
    const mesh = new ConcurrencyLimiter(1);
    let release!: () => void;
    void mesh.run(() => new Promise<void>((resolve) => (release = resolve)));
    await Promise.resolve();
    const pacer = new ProviderPacer(0);
    const promoted = pacer.submit(async () => "responsive", {
      enqueueNormal: (fn) => mesh.enqueue(fn),
    });

    promoted.promote();
    await vi.advanceTimersByTimeAsync(0);
    await expect(promoted.result).resolves.toBe("responsive");
    expect(mesh.inFlight).toBe(1);
    release();
  });

  it("rejects invalid intervals", () => {
    expect(() => new ProviderPacer(-1)).toThrow(/intervalMs/);
    const pacer = new ProviderPacer();
    expect(() => pacer.setInterval(Number.NaN)).toThrow(/intervalMs/);
  });

  it("cancels a provider-paced run before it reaches the mesh queue", async () => {
    const mesh = new ConcurrencyLimiter(1);
    const pacer = new ProviderPacer(10_000, () => Date.now());
    await pacer.submit(async () => "first", { enqueueNormal: (fn) => mesh.enqueue(fn) }).result;
    let started = false;
    const queued = pacer.submit(
      async () => {
        started = true;
      },
      { enqueueNormal: (fn) => mesh.enqueue(fn) }
    );

    expect(queued.cancel?.()).toBe(true);
    await expect(queued.result).rejects.toThrow(/cancelled before start/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toBe(false);
    expect(pacer.waiting).toBe(0);
  });

  it("reports FIFO positions and compounding ETAs for the queued lane", async () => {
    const base = Date.now();
    const mesh = new ConcurrencyLimiter(1);
    const pacer = new ProviderPacer(10_000, () => Date.now());
    await pacer.submit(async () => "first", { enqueueNormal: (fn) => mesh.enqueue(fn) }).result;

    pacer.submit(async () => "head", {
      threadId: "head-thread",
      enqueueNormal: (fn) => mesh.enqueue(fn),
    });
    pacer.submit(async () => "following", {
      threadId: "following-thread",
      enqueueNormal: (fn) => mesh.enqueue(fn),
    });

    expect(pacer.getQueueSnapshot()).toEqual([
      { threadId: "head-thread", position: 0, estimatedStartAt: base + 10_000 },
      { threadId: "following-thread", position: 1, estimatedStartAt: base + 20_000 },
    ]);
  });

  it("reports a null ETA for the staged request and every entry behind it", async () => {
    const base = Date.now();
    const mesh = new ConcurrencyLimiter(1);
    let release!: () => void;
    void mesh.run(() => new Promise<void>((resolve) => (release = resolve)));
    await Promise.resolve();

    const pacer = new ProviderPacer(10_000, () => Date.now());
    pacer.submit(async () => "staged", {
      threadId: "staged-thread",
      enqueueNormal: (fn) => mesh.enqueue(fn),
    });
    const following = pacer.submit(async () => "following", {
      threadId: "following-thread",
      enqueueNormal: (fn) => mesh.enqueue(fn),
    });

    // The staged request can't become eligible until it actually starts and
    // recomputes nextAvailableAt, so every entry's ETA is unknown.
    expect(pacer.getQueueSnapshot()).toEqual([
      { threadId: "staged-thread", position: 0, estimatedStartAt: null },
      { threadId: "following-thread", position: 1, estimatedStartAt: null },
    ]);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(pacer.getQueueSnapshot()).toEqual([
      { threadId: "following-thread", position: 0, estimatedStartAt: base + 10_000 },
    ]);

    await vi.advanceTimersByTimeAsync(10_000);
    await expect(following.result).resolves.toBe("following");
  });

  it("defers next available start with deferUntil even when no runs have started yet", async () => {
    const base = Date.now();
    const mesh = new ConcurrencyLimiter(1);
    const pacer = new ProviderPacer(0, () => Date.now());
    pacer.deferUntil(base + 5_000);

    const run = pacer.submit(async () => "delayed", {
      threadId: "delayed-thread",
      enqueueNormal: (fn) => mesh.enqueue(fn),
    });

    expect(pacer.getQueueSnapshot()).toEqual([
      { threadId: "delayed-thread", position: 0, estimatedStartAt: base + 5_000 },
    ]);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run.started).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(run.result).resolves.toBe("delayed");
  });

  it("rejects invalid timestamps in deferUntil", () => {
    const pacer = new ProviderPacer();
    expect(() => pacer.deferUntil(Number.NaN)).toThrow(/availableAtMs/);
    expect(() => pacer.deferUntil(-1)).toThrow(/availableAtMs/);
  });
});
