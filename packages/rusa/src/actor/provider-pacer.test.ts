import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import { ProviderPacer, selectPoolLane, submitPoolGate } from "./provider-pacer.js";

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
      {
        threadId: "head-thread",
        position: 0,
        estimatedStartAt: base + 10_000,
        pacingIntervalMs: 10_000,
        blocker: "provider-pacing",
      },
      {
        threadId: "following-thread",
        position: 1,
        estimatedStartAt: base + 20_000,
        pacingIntervalMs: 10_000,
        blocker: "provider-pacing",
      },
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
      {
        threadId: "staged-thread",
        position: 0,
        estimatedStartAt: null,
        pacingIntervalMs: 10_000,
        blocker: "mesh-concurrency",
      },
      {
        threadId: "following-thread",
        position: 1,
        estimatedStartAt: null,
        pacingIntervalMs: 10_000,
        blocker: "provider-pacing",
      },
    ]);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(pacer.getQueueSnapshot()).toEqual([
      {
        threadId: "following-thread",
        position: 0,
        estimatedStartAt: base + 10_000,
        pacingIntervalMs: 10_000,
        blocker: "provider-pacing",
      },
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
      {
        threadId: "delayed-thread",
        position: 0,
        estimatedStartAt: base + 5_000,
        pacingIntervalMs: 0,
        blocker: "provider-pacing",
      },
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

  it("does not strand the lane when revalidateProvider throws — the next queued request still starts", async () => {
    const mesh = new ConcurrencyLimiter(1);
    let release!: () => void;
    void mesh.run(() => new Promise<void>((resolve) => (release = resolve)));
    await Promise.resolve();

    const pacer = new ProviderPacer(0);
    let secondStarted = false;
    const first = pacer.submit(async () => "first", {
      enqueueNormal: (fn) => mesh.enqueue(fn),
      revalidateProvider: () => {
        throw new Error("registry read failed");
      },
    });
    const second = pacer.submit(
      async () => {
        secondStarted = true;
        return "second";
      },
      {
        enqueueNormal: (fn) => mesh.enqueue(fn),
        revalidateProvider: () => true,
      }
    );

    // Admits `first` into the mesh queue, where its revalidateProvider throws.
    release();
    await expect(first.result).rejects.toThrow(/registry read failed/);

    // The throw must not strand `second`, still queued behind `first`.
    await vi.advanceTimersByTimeAsync(0);
    expect(secondStarted).toBe(true);
    await expect(second.result).resolves.toBe("second");
  });

  describe("quote", () => {
    it("quotes an idle lane as immediately eligible", () => {
      const pacer = new ProviderPacer(10_000, () => Date.now());
      expect(pacer.quote(Date.now())).toBe(Date.now());
    });

    it("quotes a lane deferred by a past run at lastStartedAt + interval", async () => {
      const base = Date.now();
      const mesh = new ConcurrencyLimiter(1);
      const pacer = new ProviderPacer(10_000, () => Date.now());
      await pacer.submit(async () => "first", { enqueueNormal: (fn) => mesh.enqueue(fn) }).result;
      expect(pacer.quote(base)).toBe(base + 10_000);
    });

    it("adds one interval per already-waiting request", async () => {
      const base = Date.now();
      const mesh = new ConcurrencyLimiter(1);
      const pacer = new ProviderPacer(10_000, () => Date.now());
      await pacer.submit(async () => "first", { enqueueNormal: (fn) => mesh.enqueue(fn) }).result;
      pacer.submit(async () => "second", { enqueueNormal: (fn) => mesh.enqueue(fn) });
      expect(pacer.waiting).toBe(1);
      expect(pacer.quote(base)).toBe(base + 10_000 + 10_000);
    });

    it("honors an explicit deferUntil floor even with a zero interval", () => {
      const base = Date.now();
      const pacer = new ProviderPacer(0, () => Date.now());
      pacer.deferUntil(base + 5_000);
      expect(pacer.quote(base)).toBe(base + 5_000);
    });
  });

  describe("selectPoolLane", () => {
    it("selects the candidate with the earliest quote", () => {
      const now = Date.now();
      const soon = new ProviderPacer(0, () => now);
      const later = new ProviderPacer(0, () => now);
      later.deferUntil(now + 1_000);
      const winner = selectPoolLane(
        [
          { config: "later", lane: "later", pacer: later },
          { config: "soon", lane: "soon", pacer: soon },
        ],
        now
      );
      expect(winner?.config).toBe("soon");
    });

    it("breaks ties by declaration order", () => {
      const now = Date.now();
      const first = new ProviderPacer(0, () => now);
      const second = new ProviderPacer(0, () => now);
      const winner = selectPoolLane(
        [
          { config: "first", lane: "a", pacer: first },
          { config: "second", lane: "b", pacer: second },
        ],
        now
      );
      expect(winner?.config).toBe("first");
    });

    it("returns undefined for an empty candidate list", () => {
      expect(selectPoolLane([], Date.now())).toBeUndefined();
    });
  });

  describe("submitPoolGate", () => {
    const laneFor = (config: string, intervalMs = 0) => ({
      config,
      lane: config,
      pacer: new ProviderPacer(intervalMs, () => Date.now()),
    });

    it("excludes a halted candidate from selection", async () => {
      const mesh = new ConcurrencyLimiter(1);
      const a = laneFor("a");
      const b = laneFor("b");
      const started: string[] = [];
      const handle = submitPoolGate(
        async (config: string) => {
          started.push(config);
          return config;
        },
        [a, b],
        {
          isHalted: (config) => config === "a",
          enqueueNormal: (fn) => mesh.enqueue(fn),
        }
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(handle.result).resolves.toBe("b");
      expect(started).toEqual(["b"]);
    });

    it("responsive requests bypass pacing and reserve the first healthy declared candidate, ignoring quotes", async () => {
      const mesh = new ConcurrencyLimiter(1);
      const a = laneFor("a", 10_000);
      const b = laneFor("b", 10_000);
      // Make "a" quote later than "b" so a naive earliest-quote pick would
      // choose "b" — responsive must still land on "a", the first declared.
      await a.pacer.submit(async () => "prior", { enqueueNormal: (fn) => mesh.enqueue(fn) }).result;

      const handle = submitPoolGate(async (config: string) => config, [a, b], {
        responsive: true,
        enqueueNormal: (fn) => mesh.enqueue(fn),
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(handle.result).resolves.toBe("a");
    });

    it("breaks quote ties by declaration order", async () => {
      const mesh = new ConcurrencyLimiter(1);
      const first = laneFor("first");
      const second = laneFor("second");
      const handle = submitPoolGate(async (config: string) => config, [first, second], {
        enqueueNormal: (fn) => mesh.enqueue(fn),
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(handle.result).resolves.toBe("first");
    });

    it("promote() on the already-reserved lane promotes in place without cancelling", async () => {
      const mesh = new ConcurrencyLimiter(1);
      let release!: () => void;
      void mesh.run(() => new Promise<void>((resolve) => (release = resolve)));
      await Promise.resolve();

      const a = laneFor("a");
      const b = laneFor("b");
      const selections: string[] = [];
      const handle = submitPoolGate(async (config: string) => config, [a, b], {
        enqueueNormal: (fn) => mesh.enqueue(fn),
        onSelected: (sel) => selections.push(sel.candidate),
      });
      expect(selections).toEqual(["a"]);

      handle.promote();
      await vi.advanceTimersByTimeAsync(0);
      expect(mesh.inFlight).toBe(1); // promoted out of the mesh queue, not started as a duplicate
      release();
      await expect(handle.result).resolves.toBe("a");
      // No reselection needed: "a" was already the earliest healthy candidate.
      expect(selections).toEqual(["a"]);
    });

    it("promote() reselects onto an earlier-declared healthy lane, cancelling the stale reservation, with exactly one invocation", async () => {
      const mesh = new ConcurrencyLimiter(1);
      let release!: () => void;
      void mesh.run(() => new Promise<void>((resolve) => (release = resolve)));
      await Promise.resolve();

      const a = laneFor("a", 10_000);
      const b = laneFor("b", 10_000);
      // Defer "a" so the initial normal selection reserves "b" instead.
      a.pacer.deferUntil(Date.now() + 20_000);

      const started: string[] = [];
      const selections: string[] = [];
      const handle = submitPoolGate(
        async (config: string) => {
          started.push(config);
          return config;
        },
        [a, b],
        {
          enqueueNormal: (fn) => mesh.enqueue(fn),
          onSelected: (sel) => selections.push(sel.candidate),
        }
      );
      expect(selections).toEqual(["b"]);

      // Responsive input arrives while queued on "b": must reselect to "a",
      // the earliest declared healthy candidate, cancelling "b"'s reservation.
      handle.promote();
      expect(selections).toEqual(["b", "a"]);

      await vi.advanceTimersByTimeAsync(0);
      release();
      await expect(handle.result).resolves.toBe("a");
      expect(started).toEqual(["a"]);

      // "b"'s lane must not have been charged/left with a stranded ticket.
      expect(b.pacer.waiting).toBe(0);
    });

    it("cancel() rejects the outer handle and stops the reserved lane from starting", async () => {
      const mesh = new ConcurrencyLimiter(1);
      const a = laneFor("a", 10_000);
      const b = laneFor("b", 10_000);
      await a.pacer.submit(async () => "prior", { enqueueNormal: (fn) => mesh.enqueue(fn) }).result;

      let started = false;
      const handle = submitPoolGate(
        async (config: string) => {
          started = true;
          return config;
        },
        [a, b],
        { enqueueNormal: (fn) => mesh.enqueue(fn) }
      );

      expect(handle.cancel?.()).toBe(true);
      await expect(handle.result).rejects.toThrow(/cancelled before start/);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(started).toBe(false);
    });

    it("onSelected reports the declared index and lane alongside the config", async () => {
      const mesh = new ConcurrencyLimiter(1);
      const a = laneFor("provider-a");
      const b = laneFor("provider-b");
      let seen:
        | { candidate: string; lane: string; declaredIndex: number; responsive: boolean }
        | undefined;
      submitPoolGate(async (config: string) => config, [a, b], {
        enqueueNormal: (fn) => mesh.enqueue(fn),
        onSelected: (sel) => {
          seen = sel;
        },
      });
      expect(seen).toMatchObject({
        candidate: "provider-a",
        lane: "provider-a",
        declaredIndex: 0,
        responsive: false,
      });
    });
  });
});
