import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createLogger } from "../observability/logger.js";
import { ComputerUseLock } from "./computer-use-lock.js";
import { RunStartCancelledError } from "./concurrency-limiter.js";

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

  it("logs a responsive wait, cancellation and acquisition after natural holder settlement", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    onTestFinished(() => now.mockRestore());
    const records: Record<string, unknown>[] = [];
    const logger = createLogger({
      format: "json",
      destination: { write: (line: string) => records.push(JSON.parse(line)) },
      context: { component: "computer-use-lock" },
    });
    const lock = new ComputerUseLock(undefined, logger);
    const first = deferred<string>();
    const second = deferred<string>();
    const starts: string[] = [];
    const interruptHolder = vi.fn();
    const holder = lock.gate(
      "holder",
      true,
      () => {
        starts.push("holder");
        return first.promise;
      },
      interruptHolder
    );
    const waiter = lock.gate("waiter", true, () => {
      starts.push("waiter");
      return second.promise;
    });
    const cancelledStart = vi.fn(async () => "cancelled");
    const cancelled = lock.gate("cancelled", true, cancelledStart);
    now.mockReturnValue(1250);
    expect(cancelled.cancel?.()).toBe(true);
    await expect(cancelled.result).rejects.toMatchObject({ name: "RunStartCancelledError" });

    expect(records.map(({ msg, actorId }) => [msg, actorId])).toEqual([
      ["computer_use_acquired", "holder"],
      ["computer_use_wait", "waiter"],
      ["computer_use_wait", "cancelled"],
      ["computer_use_wait_ended", "cancelled"],
    ]);
    expect(records[3]).toMatchObject({ outcome: "cancelled", waitedMs: 250 });
    expect(records[1]).toMatchObject({
      component: "computer-use-lock",
      actorId: "waiter",
      holderActorId: "holder",
      responsive: true,
      holderResponsive: true,
    });
    expect(interruptHolder).not.toHaveBeenCalled();
    expect(starts).toEqual(["holder"]);
    expect(waiter.started).toBe(false);

    now.mockReturnValue(1900);
    first.resolve("holder:done");
    await expect(holder.result).resolves.toBe("holder:done");
    await flush();
    expect(starts).toEqual(["holder", "waiter"]);
    expect(records[4]).toMatchObject({
      msg: "computer_use_acquired",
      actorId: "waiter",
      responsive: true,
      waited: true,
      waitedMs: 900,
    });
    expect(records).toHaveLength(5);
    expect(cancelledStart).not.toHaveBeenCalled();
    second.resolve("waiter:done");
    await expect(waiter.result).resolves.toBe("waiter:done");
  });

  it("updates the blocker as queued holders advance and ends waits on close", async () => {
    const records: Record<string, unknown>[] = [];
    const lock = new ComputerUseLock(
      undefined,
      createLogger({
        format: "json",
        destination: { write: (line: string) => records.push(JSON.parse(line)) },
      })
    );
    const first = deferred<string>();
    const second = deferred<string>();
    const holder = lock.gate("first", true, () => first.promise);
    const next = lock.gate("second", true, () => second.promise);
    const cancelledStart = vi.fn(async () => "third");
    const third = lock.gate("third", true, cancelledStart);
    first.resolve("first");
    await expect(holder.result).resolves.toBe("first");
    await flush();
    expect(
      records
        .filter((r) => r.msg === "computer_use_wait" && r.actorId === "third")
        .map((r) => r.holderActorId)
    ).toEqual(["first", "second"]);
    lock.close();
    await expect(third.result).rejects.toMatchObject({ name: "RunStartCancelledError" });
    expect(records.filter((r) => r.msg === "computer_use_wait_ended")).toEqual([
      expect.objectContaining({
        actorId: "third",
        outcome: "closed",
        waitedMs: expect.any(Number),
      }),
    ]);
    expect(cancelledStart).not.toHaveBeenCalled();
    second.resolve("second");
    await expect(next.result).resolves.toBe("second");
  });

  it.each([
    "computer_use_wait",
    "computer_use_acquired",
    "computer_use_wait_ended",
  ])("preserves admission, cancellation and release when the %s logger sink throws", async (throwOn) => {
    const attempted: string[] = [];
    const logger = createLogger({
      format: "json",
      destination: {
        write: (line: string) => {
          const { msg } = JSON.parse(line);
          attempted.push(msg);
          if (msg === throwOn) throw new Error("synthetic sink failure");
        },
      },
    });
    const lock = new ComputerUseLock(undefined, logger);
    const held = deferred<string>();
    const interrupt = vi.fn();
    let holder!: ReturnType<typeof lock.gate<string>>;
    expect(() => {
      holder = lock.gate("holder", true, () => held.promise, interrupt);
    }).not.toThrow();
    const start = vi.fn(async () => "waiter:done");
    let waiter!: ReturnType<typeof lock.gate<string>>;
    expect(() => {
      waiter = lock.gate("waiter", true, start);
    }).not.toThrow();
    const cancelledStart = vi.fn(async () => "cancelled");
    const cancelled = lock.gate("cancelled", true, cancelledStart);
    expect(cancelled.cancel?.()).toBe(true);
    await expect(cancelled.result).rejects.toMatchObject({ name: "RunStartCancelledError" });
    expect(start).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
    held.resolve("holder:done");
    await expect(holder.result).resolves.toBe("holder:done");
    await expect(waiter.result).resolves.toBe("waiter:done");
    await flush();
    const next = lock.gate("next", false, async () => "next:done");
    await expect(next.result).resolves.toBe("next:done");
    expect(start).toHaveBeenCalledOnce();
    expect(cancelledStart).not.toHaveBeenCalled();
    expect(attempted).toContain(throwOn);
  });
  it("distinguishes unresolved provider admission, admitted lock wait and execution", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    onTestFinished(() => now.mockRestore());
    const records: Record<string, unknown>[] = [];
    const lock = new ComputerUseLock(
      undefined,
      createLogger({
        format: "json",
        destination: { write: (line: string) => records.push(JSON.parse(line)) },
      })
    );
    const held = deferred<string>();
    const holder = lock.gate("holder", true, () => held.promise);
    const result = deferred<string>();
    let admit!: (selected: string) => Promise<string>;
    const execute = vi.fn(async () => "done");
    const waiter = lock.gateAfterProvider<string, string>(
      "waiter",
      true,
      (start) => {
        admit = start;
        return { result: result.promise, started: false, promote: () => {} };
      },
      execute,
      () => true
    );
    expect(records.filter((r) => r.actorId === "waiter")).toEqual([
      expect.objectContaining({ msg: "provider_admission", phase: "pending", elapsedMs: 0 }),
    ]);
    expect(execute).not.toHaveBeenCalled();
    now.mockReturnValue(1200);
    void admit("selected").then(result.resolve, result.reject);
    expect(records.filter((r) => r.actorId === "waiter").map((r) => r.phase ?? r.msg)).toEqual([
      "pending",
      "admitted",
      "computer_use_wait",
    ]);
    expect(records.find((r) => r.phase === "admitted")).toMatchObject({ elapsedMs: 200 });
    expect(execute).not.toHaveBeenCalled();
    now.mockReturnValue(1500);
    held.resolve("holder");
    await holder.result;
    await expect(waiter instanceof Promise ? waiter : waiter.result).resolves.toBe("done");
    expect(execute).toHaveBeenCalledOnce();
    expect(records.filter((r) => r.msg === "provider_admission")).toEqual([
      expect.objectContaining({ actorId: "waiter", phase: "pending", responsive: true }),
      expect.objectContaining({ actorId: "waiter", phase: "admitted", elapsedMs: 200 }),
      expect.objectContaining({
        actorId: "waiter",
        phase: "ended",
        admitted: true,
        outcome: "resolved",
        elapsedMs: 500,
      }),
    ]);
  });

  it.each([
    "cancelled",
    "failed",
    "thrown",
  ])("ends %s admission without claiming execution", async (outcome) => {
    const records: Record<string, unknown>[] = [];
    const lock = new ComputerUseLock(
      undefined,
      createLogger({
        format: "json",
        destination: { write: (line: string) => records.push(JSON.parse(line)) },
      })
    );
    const execute = vi.fn(async () => "done");
    const reason =
      outcome === "cancelled" ? new RunStartCancelledError() : new Error("synthetic failure");
    if (outcome === "thrown") {
      expect(() =>
        lock.gateAfterProvider(
          "actor",
          false,
          () => {
            throw reason;
          },
          execute,
          () => false
        )
      ).toThrow(reason);
    } else {
      const result = deferred<string>();
      const handle = lock.gateAfterProvider(
        "actor",
        false,
        () => ({
          result: result.promise,
          started: false,
          promote: () => {},
          cancel: () => {
            result.reject(reason);
            return true;
          },
        }),
        execute,
        () => false
      );
      if (handle instanceof Promise) throw new Error("expected handle");
      if (outcome === "cancelled") expect(handle.cancel?.()).toBe(true);
      else result.reject(reason);
      await expect(handle.result).rejects.toBe(reason);
    }
    expect(execute).not.toHaveBeenCalled();
    expect(records.map((r) => r.phase)).toEqual(["pending", "ended"]);
    expect(records[1]).toMatchObject({
      admitted: false,
      outcome: outcome === "cancelled" ? "cancelled" : "failed",
    });
  });

  it.each([
    "pending",
    "admitted",
    "ended",
  ])("preserves progress when provider %s logging throws", async (throwOn) => {
    const attempted: string[] = [];
    const lock = new ComputerUseLock(
      undefined,
      createLogger({
        format: "json",
        destination: {
          write: (line: string) => {
            const record = JSON.parse(line);
            if (record.msg === "provider_admission") {
              attempted.push(record.phase);
              if (record.phase === throwOn) throw new Error("synthetic sink failure");
            }
          },
        },
      })
    );
    // Exercise the Promise path without computer-use and the handle path with it.
    const direct = lock.gateAfterProvider(
      "direct",
      false,
      (start) => start("selected"),
      async () => "done",
      () => false
    );
    await expect(direct instanceof Promise ? direct : direct.result).resolves.toBe("done");
    const queued = deferred<string>();
    const cancelled = lock.gateAfterProvider(
      "cancelled",
      false,
      () => ({
        result: queued.promise,
        started: false,
        promote: () => {},
        cancel: () => {
          queued.reject(new RunStartCancelledError());
          return true;
        },
      }),
      async () => "unexpected",
      () => true
    );
    if (cancelled instanceof Promise) throw new Error("expected handle");
    expect(cancelled.cancel?.()).toBe(true);
    await expect(cancelled.result).rejects.toBeInstanceOf(RunStartCancelledError);
    const next = lock.gateAfterProvider(
      "next",
      true,
      (start) => start("selected"),
      async () => "next",
      () => true
    );
    await expect(next instanceof Promise ? next : next.result).resolves.toBe("next");
    expect(attempted).toEqual([
      "pending",
      "admitted",
      "ended",
      "pending",
      "ended",
      "pending",
      "admitted",
      "ended",
    ]);
  });
});
