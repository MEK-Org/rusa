import { describe, expect, it, vi } from "vitest";
import { ComputerUseLock } from "./computer-use-lock.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("ComputerUseLock", () => {
  it("enters the lock only after provider admission", async () => {
    const lock = new ComputerUseLock();
    const slowProvider = deferred<string>();
    const events: string[] = [];
    let slowProviderStarted = false;
    let startSlow!: (selected: string) => Promise<string>;

    const slow = lock.gateAfterProvider<string, string>(
      "slow",
      false,
      (start) => {
        startSlow = start;
        return {
          result: slowProvider.promise,
          get started() {
            return slowProviderStarted;
          },
          promote: () => {},
          cancel: () => false,
        };
      },
      async (selected) => {
        events.push(`${selected}:lock`);
        return selected;
      },
      () => true
    );
    const fast = lock.gateAfterProvider<string, string>(
      "fast",
      false,
      (start) => start("fast"),
      async (selected) => {
        events.push(`${selected}:lock`);
        return selected;
      },
      () => true
    );

    await expect(fast instanceof Promise ? fast : fast.result).resolves.toBe("fast");
    // Slow was still waiting in its provider lane, so it never reserved this
    // instance's computer or delayed the shorter-paced run.
    expect(events).toEqual(["fast:lock"]);

    slowProviderStarted = true;
    void startSlow("slow").then(slowProvider.resolve, slowProvider.reject);
    await expect(slow instanceof Promise ? slow : slow.result).resolves.toBe("slow");
    expect(events).toEqual(["fast:lock", "slow:lock"]);
  });

  it("carries promotion into a lock entry admitted after provider pacing", async () => {
    const lock = new ComputerUseLock();
    const holder = deferred<string>();
    const pacedProvider = deferred<string>();
    const events: string[] = [];
    let admitPaced!: (selected: string) => Promise<string>;

    const held = lock.gate("holder", false, () => {
      events.push("holder:start");
      return holder.promise;
    });
    await flush();
    const normal = lock.gate("normal", false, async () => {
      events.push("normal:start");
      return "normal";
    });
    const paced = lock.gateAfterProvider<string, string>(
      "paced",
      false,
      (start) => {
        admitPaced = start;
        return {
          result: pacedProvider.promise,
          get started() {
            return false;
          },
          promote: () => {},
          cancel: () => false,
        };
      },
      async (selected) => {
        events.push(`${selected}:start`);
        return selected;
      },
      () => true
    );
    if (paced instanceof Promise) throw new Error("expected a provider admission handle");

    // Promotion happens while this run is still paced, before a lock entry
    // exists. The later provider admission must create a responsive entry.
    paced.promote();
    void admitPaced("paced").then(pacedProvider.resolve, pacedProvider.reject);

    holder.resolve("holder");
    await expect(held.result).resolves.toBe("holder");
    await expect(paced.result).resolves.toBe("paced");
    await expect(normal.result).resolves.toBe("normal");
    expect(events).toEqual(["holder:start", "paced:start", "normal:start"]);
  });

  it("serializes capable actors while unrelated work can proceed", async () => {
    const lock = new ComputerUseLock();
    const first = deferred<string>();
    const events: string[] = [];

    const a = lock.gate("a", false, () => {
      events.push("a:start");
      return first.promise;
    });
    const b = lock.gate("b", false, async () => {
      events.push("b:start");
      return "b";
    });
    const unrelated = Promise.resolve().then(() => events.push("unrelated:start"));

    await flush();
    await unrelated;
    expect(events).toEqual(["a:start", "unrelated:start"]);
    first.resolve("a");
    await expect(a.result).resolves.toBe("a");
    await expect(b.result).resolves.toBe("b");
    expect(events).toEqual(["a:start", "unrelated:start", "b:start"]);
  });

  it("preempts a normal holder but grants responsive work only after it releases", async () => {
    const lock = new ComputerUseLock();
    const first = deferred<string>();
    const events: string[] = [];
    const interrupt = vi.fn(() => events.push("a:interrupt"));

    const a = lock.gate(
      "a",
      false,
      () => {
        events.push("a:start");
        return first.promise;
      },
      interrupt
    );
    await flush();
    const b = lock.gate("b", true, async () => {
      events.push("b:start");
      return "b";
    });

    expect(interrupt).toHaveBeenCalledOnce();
    expect(events).toEqual(["a:start", "a:interrupt"]);
    first.resolve("a");
    await expect(a.result).resolves.toBe("a");
    await expect(b.result).resolves.toBe("b");
    expect(events).toEqual(["a:start", "a:interrupt", "b:start"]);
  });

  it("does not preempt a responsive holder for a later responsive wake", async () => {
    const lock = new ComputerUseLock();
    const first = deferred<string>();
    const interrupt = vi.fn();
    const a = lock.gate("a", true, () => first.promise, interrupt);
    await flush();
    const b = lock.gate("b", true, async () => "b");

    expect(interrupt).not.toHaveBeenCalled();
    first.resolve("a");
    await expect(a.result).resolves.toBe("a");
    await expect(b.result).resolves.toBe("b");
  });

  it("cancels a durable queued waiter before it can acquire the lock", async () => {
    const lock = new ComputerUseLock();
    const first = deferred<string>();
    const a = lock.gate("a", false, () => first.promise);
    await flush();
    const b = lock.gate("b", false, async () => "b");

    expect(b.cancel?.()).toBe(true);
    await expect(b.result).rejects.toMatchObject({ name: "RunStartCancelledError" });
    first.resolve("a");
    await expect(a.result).resolves.toBe("a");
  });

  it("cancels queued work during instance shutdown and asks the holder to stop", async () => {
    const lock = new ComputerUseLock();
    const first = deferred<string>();
    const interrupt = vi.fn();
    const a = lock.gate("a", false, () => first.promise, interrupt);
    await flush();
    const b = lock.gate("b", false, async () => "b");

    lock.close();
    expect(interrupt).toHaveBeenCalledOnce();
    await expect(b.result).rejects.toMatchObject({ name: "RunStartCancelledError" });
    first.resolve("a");
    await expect(a.result).resolves.toBe("a");
  });

  it("preserves FIFO order among responsive waiters when a normal waiter is promoted", async () => {
    const lock = new ComputerUseLock();
    const holder = deferred<string>();
    const events: string[] = [];

    const h = lock.gate("holder", true, () => {
      events.push("holder:start");
      return holder.promise;
    });
    await flush();

    // r1 queues as responsive first
    const r1 = lock.gate("r1", true, async () => {
      events.push("r1:start");
      return "r1";
    });

    // n1 queues as normal
    const n1 = lock.gate("n1", false, async () => {
      events.push("n1:start");
      return "n1";
    });

    // Promote n1 to responsive — must push behind earlier responsive waiter r1
    n1.promote();

    holder.resolve("holder");
    await expect(h.result).resolves.toBe("holder");
    await Promise.all([r1.result, n1.result]);

    expect(events).toEqual(["holder:start", "r1:start", "n1:start"]);
  });

  it("re-requests a preempted holder after responsive work finishes", async () => {
    const lock = new ComputerUseLock();
    const first = deferred<string>();
    const second = deferred<string>();
    const events: string[] = [];
    const interrupt = vi.fn(() => events.push("a:interrupt"));
    const reRequest = vi.fn(() => events.push("a:reRequest"));

    const a = lock.gate(
      "a",
      false,
      () => {
        events.push("a:start");
        return first.promise;
      },
      interrupt,
      reRequest
    );
    await flush();

    const b = lock.gate("b", true, () => {
      events.push("b:start");
      return second.promise;
    });

    expect(interrupt).toHaveBeenCalledOnce();
    expect(reRequest).not.toHaveBeenCalled();
    expect(events).toEqual(["a:start", "a:interrupt"]);

    // a releases the lock
    first.resolve("a");
    await expect(a.result).resolves.toBe("a");
    await flush();

    // b is now running; reRequest must wait until responsive work finishes
    expect(events).toEqual(["a:start", "a:interrupt", "b:start"]);
    expect(reRequest).not.toHaveBeenCalled();

    // b finishes and releases the lock
    second.resolve("b");
    await expect(b.result).resolves.toBe("b");
    await flush();

    // Now that responsive waiter has finished, reRequest is called
    expect(reRequest).toHaveBeenCalledOnce();
    expect(events).toEqual(["a:start", "a:interrupt", "b:start", "a:reRequest"]);
  });

  it("re-requests a preempted holder only after all chained responsive waiters finish", async () => {
    const lock = new ComputerUseLock();
    const first = deferred<string>();
    const second = deferred<string>();
    const third = deferred<string>();
    const events: string[] = [];
    const interrupt = vi.fn(() => events.push("a:interrupt"));
    const reRequest = vi.fn(() => events.push("a:reRequest"));

    const a = lock.gate(
      "a",
      false,
      () => {
        events.push("a:start");
        return first.promise;
      },
      interrupt,
      reRequest
    );
    await flush();

    const b = lock.gate("b", true, () => {
      events.push("b:start");
      return second.promise;
    });
    const c = lock.gate("c", true, () => {
      events.push("c:start");
      return third.promise;
    });

    first.resolve("a");
    await expect(a.result).resolves.toBe("a");
    await flush();

    // b finishes, c starts; reRequest must still not be called while c is queued/running
    expect(reRequest).not.toHaveBeenCalled();
    second.resolve("b");
    await expect(b.result).resolves.toBe("b");
    await flush();

    expect(events).toEqual(["a:start", "a:interrupt", "b:start", "c:start"]);
    expect(reRequest).not.toHaveBeenCalled();

    // c finishes; now that all responsive work is done, reRequest fires
    third.resolve("c");
    await expect(c.result).resolves.toBe("c");
    await flush();

    expect(reRequest).toHaveBeenCalledOnce();
    expect(events).toEqual(["a:start", "a:interrupt", "b:start", "c:start", "a:reRequest"]);
  });

  it("reports callback errors to onError when reRequest throws", async () => {
    const onError = vi.fn();
    const lock = new ComputerUseLock(onError);
    const first = deferred<string>();
    const second = deferred<string>();
    const thrownError = new Error("re-request exploded");

    const a = lock.gate(
      "a",
      false,
      () => first.promise,
      undefined,
      () => {
        throw thrownError;
      }
    );
    await flush();

    const b = lock.gate("b", true, () => second.promise);
    first.resolve("a");
    await expect(a.result).resolves.toBe("a");
    await flush();

    second.resolve("b");
    await expect(b.result).resolves.toBe("b");
    await flush();

    expect(onError).toHaveBeenCalledWith(thrownError);
  });
});
