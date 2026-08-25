import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("ConcurrencyLimiter", () => {
  it("rejects a max below 1", () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow(/>= 1/);
  });

  it("runs up to max concurrently and queues the rest", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const a = deferred<string>();
    const b = deferred<string>();
    const c = deferred<string>();

    const ra = limiter.run(() => a.promise);
    const rb = limiter.run(() => b.promise);
    const rc = limiter.run(() => c.promise);
    await flush();

    expect(limiter.inFlight).toBe(2);
    expect(limiter.waiting).toBe(1);

    a.resolve("a");
    await flush();
    // c starts as a's slot frees.
    expect(limiter.inFlight).toBe(2);
    expect(limiter.waiting).toBe(0);

    b.resolve("b");
    c.resolve("c");
    expect(await Promise.all([ra, rb, rc])).toEqual(["a", "b", "c"]);
    expect(limiter.inFlight).toBe(0);
  });

  it("runs queued tasks in FIFO order", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const order: number[] = [];
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const runs = gates.map((g, i) =>
      limiter.run(async () => {
        order.push(i);
        await g.promise;
      })
    );
    await flush();
    expect(order).toEqual([0]); // only first running
    gates[0]?.resolve();
    await flush();
    expect(order).toEqual([0, 1]);
    gates[1]?.resolve();
    await flush();
    expect(order).toEqual([0, 1, 2]);
    gates[2]?.resolve();
    await Promise.all(runs);
  });

  it("frees the slot even when a task throws", async () => {
    const limiter = new ConcurrencyLimiter(1);
    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(limiter.inFlight).toBe(0);
    // The slot is reusable.
    expect(await limiter.run(async () => "ok")).toBe("ok");
  });

  it("cancels a queued task without starting it", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const blocker = deferred<void>();
    void limiter.run(() => blocker.promise);
    await flush();
    let started = false;
    const queued = limiter.enqueue(async () => {
      started = true;
    });

    expect(queued.cancel?.()).toBe(true);
    await expect(queued.result).rejects.toThrow(/cancelled before start/);
    blocker.resolve();
    await flush();
    expect(started).toBe(false);
    expect(limiter.waiting).toBe(0);
  });
});
