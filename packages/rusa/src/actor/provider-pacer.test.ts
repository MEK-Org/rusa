import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import {
  ProviderPacer,
  selectPoolLane,
  submitPoolGate,
  UnifiedAdmissionQueue,
} from "./provider-pacer.js";

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

  it("quotes the pacing interval as whole milliseconds even when the controller set a fraction", () => {
    const mesh = new ConcurrencyLimiter(1);
    // The adaptive controller persists a REAL interval, so `setInterval`
    // legitimately receives fractional milliseconds; the snapshot must still
    // put an integer on the wire.
    const pacer = new ProviderPacer(2_159_335.7, () => Date.now());
    pacer.submit(async () => "queued", {
      threadId: "queued-thread",
      enqueueNormal: (fn) => mesh.enqueue(fn),
    });

    const [entry] = pacer.getQueueSnapshot();
    expect(entry?.pacingIntervalMs).toBe(2_159_336);
    expect(Number.isInteger(entry?.pacingIntervalMs)).toBe(true);
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
      },
      {
        threadId: "following-thread",
        position: 1,
        estimatedStartAt: base + 20_000,
        pacingIntervalMs: 10_000,
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
      },
      {
        threadId: "following-thread",
        position: 1,
        estimatedStartAt: null,
        pacingIntervalMs: 10_000,
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

    it("responsive selection prefers quota headroom over pacing heat (#655)", () => {
      const now = Date.now();
      // The higher-headroom lane is pacing-hot (deferred); the lower-headroom
      // lane is available right now. Absolute quota gates, pacing ranks: the
      // responsive run takes the lane with more quota headroom, and pacing
      // heat never disqualifies it.
      const hot = new ProviderPacer(0, () => now);
      hot.deferUntil(now + 3_600_000);
      const cool = new ProviderPacer(0, () => now);
      const resetAtIso = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();
      const observedAt = new Date(now).toISOString();
      const candidates = [
        {
          config: "hot-high-headroom",
          lane: "a",
          pacer: hot,
          weeklyQuota: { percentLeft: 80, observedAt, resetAtIso },
        },
        {
          config: "cool-low-headroom",
          lane: "b",
          pacer: cool,
          weeklyQuota: { percentLeft: 20, observedAt, resetAtIso },
        },
      ];

      expect(selectPoolLane(candidates, now, { responsive: true })?.config).toBe(
        "hot-high-headroom"
      );
      // Normal priority keeps the quote-first rule: the pacing-hot lane waits.
      expect(selectPoolLane(candidates, now)?.config).toBe("cool-low-headroom");
    });

    it("responsive selection falls back to the quote rule without trustworthy evidence (#655)", () => {
      const now = Date.now();
      const hot = new ProviderPacer(0, () => now);
      hot.deferUntil(now + 3_600_000);
      const cool = new ProviderPacer(0, () => now);
      const winner = selectPoolLane(
        [
          { config: "hot", lane: "a", pacer: hot },
          { config: "cool", lane: "b", pacer: cool },
        ],
        now,
        { responsive: true }
      );

      expect(winner?.config).toBe("cool");
    });

    it("responsive selection retains the quote rule with only one comparable weekly reading (#655)", () => {
      const now = Date.now();
      const unknownButAvailable = new ProviderPacer(0, () => now);
      const knownButHot = new ProviderPacer(0, () => now);
      knownButHot.deferUntil(now + 3_600_000);
      const winner = selectPoolLane(
        [
          { config: "unknown", lane: "unknown", pacer: unknownButAvailable },
          {
            config: "known",
            lane: "known",
            pacer: knownButHot,
            weeklyQuota: {
              percentLeft: 2,
              observedAt: new Date(now).toISOString(),
              resetAtIso: new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString(),
            },
          },
        ],
        now,
        { responsive: true }
      );

      expect(winner?.config).toBe("unknown");
    });
  });

  describe("submitPoolGate", () => {
    const laneFor = (config: string, intervalMs = 0) => ({
      config,
      lane: config,
      pacer: new ProviderPacer(intervalMs, () => Date.now()),
    });

    it("excludes a halted candidate from responsive selection", async () => {
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
          responsive: true,
          isHalted: (config) => config === "a",
          enqueueNormal: (fn) => mesh.enqueue(fn),
        }
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(handle.result).resolves.toBe("b");
      expect(started).toEqual(["b"]);
    });

    it("starts the responsive headroom winner without waiting out its pace (#655)", async () => {
      const mesh = new ConcurrencyLimiter(1);
      const now = Date.now();
      const hot = laneFor("hot");
      hot.pacer.deferUntil(now + 3_600_000);
      const cool = laneFor("cool");
      const resetAtIso = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();
      const observedAt = new Date(now).toISOString();
      const started: string[] = [];
      const handle = submitPoolGate(
        async (config: string) => {
          started.push(config);
          return config;
        },
        [
          { ...hot, weeklyQuota: { percentLeft: 80, observedAt, resetAtIso } },
          { ...cool, weeklyQuota: { percentLeft: 20, observedAt, resetAtIso } },
        ],
        {
          responsive: true,
          enqueueNormal: (fn) => mesh.enqueue(fn),
        }
      );
      await vi.advanceTimersByTimeAsync(0);
      await expect(handle.result).resolves.toBe("hot");
      expect(started).toEqual(["hot"]);
    });

    it("responsive requests choose the same earliest available healthy candidate as normal admission while bypassing pacing", async () => {
      const mesh = new ConcurrencyLimiter(1);
      const a = laneFor("a", 10_000);
      const b = laneFor("b", 10_000);
      // Make "a" quote later than "b". Responsive priority changes its
      // pacing, not the model/provider lane selected for the run.
      await a.pacer.submit(async () => "prior", { enqueueNormal: (fn) => mesh.enqueue(fn) }).result;

      const handle = submitPoolGate(async (config: string) => config, [a, b], {
        responsive: true,
        enqueueNormal: (fn) => mesh.enqueue(fn),
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(handle.result).resolves.toBe("b");
    });

    it("prefers greater trustworthy weekly headroom when healthy lanes are immediately available", () => {
      const now = Date.now();
      const a = laneFor("a");
      const b = laneFor("b");
      const winner = selectPoolLane(
        [
          {
            ...a,
            weeklyQuota: {
              percentLeft: 40,
              observedAt: new Date(now).toISOString(),
              resetAtIso: new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString(),
            },
          },
          {
            ...b,
            weeklyQuota: {
              percentLeft: 30,
              observedAt: new Date(now).toISOString(),
              resetAtIso: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
            },
          },
        ],
        now
      );

      expect(winner?.config).toBe("b");
    });

    it("falls back to declared order when weekly headroom is unknown or stale", () => {
      const now = Date.now();
      const a = laneFor("a");
      const b = laneFor("b");
      const winner = selectPoolLane(
        [
          { ...a },
          {
            ...b,
            weeklyQuota: {
              percentLeft: 99,
              observedAt: new Date(now - 31 * 60 * 1000).toISOString(),
              resetAtIso: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
            },
          },
        ],
        now
      );

      expect(winner?.config).toBe("a");
    });

    it("falls back to declared order when weekly headroom is invalid", () => {
      const now = Date.now();
      const a = laneFor("a");
      const b = laneFor("b");
      const winner = selectPoolLane(
        [
          { ...a },
          {
            ...b,
            weeklyQuota: {
              percentLeft: 101,
              observedAt: new Date(now).toISOString(),
              resetAtIso: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
            },
          },
        ],
        now
      );

      expect(winner?.config).toBe("a");
    });

    it("does not let unknown weekly quota evidence outrank a known immediate candidate", () => {
      const now = Date.now();
      const a = laneFor("a");
      const b = laneFor("b");
      const winner = selectPoolLane(
        [
          { ...a },
          {
            ...b,
            weeklyQuota: {
              percentLeft: 30,
              observedAt: new Date(now).toISOString(),
              resetAtIso: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
            },
          },
        ],
        now
      );

      expect(winner?.config).toBe("b");
    });

    it("falls back to declared order when trustworthy weekly headroom is tied", () => {
      const now = Date.now();
      const a = laneFor("a");
      const b = laneFor("b");
      const resetAtIso = new Date(now + 24 * 60 * 60 * 1000).toISOString();
      const observedAt = new Date(now).toISOString();
      const winner = selectPoolLane(
        [
          { ...a, weeklyQuota: { percentLeft: 30, observedAt, resetAtIso } },
          { ...b, weeklyQuota: { percentLeft: 30, observedAt, resetAtIso } },
        ],
        now
      );

      expect(winner?.config).toBe("a");
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
      const selections: Array<{ candidate: string; responsive: boolean }> = [];
      const handle = submitPoolGate(async (config: string) => config, [a, b], {
        enqueueNormal: (fn) => mesh.enqueue(fn),
        onSelected: (sel) =>
          selections.push({ candidate: sel.candidate, responsive: sel.responsive }),
      });
      expect(selections).toEqual([{ candidate: "a", responsive: false }]);

      handle.promote();
      await vi.advanceTimersByTimeAsync(0);
      expect(mesh.inFlight).toBe(1); // promoted out of the mesh queue, not started as a duplicate
      release();
      await expect(handle.result).resolves.toBe("a");
      // No lane reselection is needed, but telemetry reflects the promotion.
      expect(selections).toEqual([
        { candidate: "a", responsive: false },
        { candidate: "a", responsive: true },
      ]);
    });

    it("promote() keeps the same next-available lane as normal admission, with exactly one invocation", async () => {
      const mesh = new ConcurrencyLimiter(1);
      let release!: () => void;
      void mesh.run(() => new Promise<void>((resolve) => (release = resolve)));
      await Promise.resolve();

      const a = laneFor("a", 10_000);
      const b = laneFor("b", 10_000);
      // Defer "a" so the initial normal selection reserves "b" instead.
      a.pacer.deferUntil(Date.now() + 20_000);

      const started: string[] = [];
      const selections: Array<{ candidate: string; responsive: boolean }> = [];
      const handle = submitPoolGate(
        async (config: string) => {
          started.push(config);
          return config;
        },
        [a, b],
        {
          enqueueNormal: (fn) => mesh.enqueue(fn),
          onSelected: (sel) =>
            selections.push({ candidate: sel.candidate, responsive: sel.responsive }),
        }
      );
      expect(selections).toEqual([{ candidate: "b", responsive: false }]);

      // Responsive input arrives while queued on "b": it bypasses pacing and
      // mesh concurrency, but preserves normal admission's selection of "b".
      handle.promote();
      expect(selections).toEqual([
        { candidate: "b", responsive: false },
        { candidate: "b", responsive: true },
      ]);

      await vi.advanceTimersByTimeAsync(0);
      release();
      await expect(handle.result).resolves.toBe("b");
      expect(started).toEqual(["b"]);

      // Promotion bypasses the mesh queue without stranding its selected lane.
      expect(b.pacer.waiting).toBe(0);
    });

    it("promote() reselects away from a lane reported exhausted after normal admission (#655)", async () => {
      const mesh = new ConcurrencyLimiter(1);
      let release!: () => void;
      void mesh.run(() => new Promise<void>((resolve) => (release = resolve)));
      await Promise.resolve();

      const a = laneFor("a");
      const b = laneFor("b");
      let aExhausted = false;
      const selected: Array<{ candidate: string; responsive: boolean }> = [];
      const handle = submitPoolGate(async (config: string) => config, [a, b], {
        enqueueNormal: (fn) => mesh.enqueue(fn),
        isExhausted: (config) => aExhausted && config === "a",
        onSelected: (selection) =>
          selected.push({ candidate: selection.candidate, responsive: selection.responsive }),
      });
      expect(selected).toEqual([{ candidate: "a", responsive: false }]);

      aExhausted = true;
      handle.promote();
      await expect(handle.result).resolves.toBe("b");
      expect(selected).toEqual([
        { candidate: "a", responsive: false },
        { candidate: "b", responsive: true },
      ]);

      release();
    });

    it("promote() fails instead of reselecting a known-exhausted pool (#655)", async () => {
      const mesh = new ConcurrencyLimiter(1);
      let release!: () => void;
      void mesh.run(() => new Promise<void>((resolve) => (release = resolve)));
      await Promise.resolve();

      const a = laneFor("a");
      const b = laneFor("b");
      let exhausted = false;
      const started = vi.fn(async (config: string) => config);
      const handle = submitPoolGate(started, [a, b], {
        enqueueNormal: (fn) => mesh.enqueue(fn),
        isExhausted: () => exhausted,
        onResponsivePoolExhausted: () => new Error("all lanes exhausted"),
      });

      exhausted = true;
      handle.promote();
      release();
      await expect(handle.result).rejects.toThrow("all lanes exhausted");
      expect(started).not.toHaveBeenCalled();
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

describe("UnifiedAdmissionQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const laneFor = (config: string, intervalMs = 0) => ({
    config,
    lane: config,
    pacer: new ProviderPacer(intervalMs, () => Date.now()),
  });

  it("claims unclaimed work in its reordered list order", async () => {
    const mesh = new ConcurrencyLimiter(1);
    const queue = new UnifiedAdmissionQueue<string>();
    const delayed = laneFor("delayed", 60_000);
    delayed.pacer.deferUntil(Date.now() + 60_000);
    const started: string[] = [];
    const run = (id: string) =>
      queue.enqueue(
        async () => {
          started.push(id);
          return id;
        },
        [delayed],
        { threadId: id, enqueueNormal: (fn) => mesh.enqueue(fn) }
      );

    const one = run("one");
    const two = run("two");
    // Projected starts stack one interval per entry on the shared lane.
    const opensAt = Date.now() + 60_000;
    expect(queue.snapshot()).toEqual([
      expect.objectContaining({ threadId: "one", position: 0, estimatedStartAt: opensAt }),
      expect.objectContaining({ threadId: "two", position: 1, estimatedStartAt: opensAt + 60_000 }),
    ]);
    expect(queue.reorder("two", "one")).toBe(true);
    expect(queue.snapshot().map((entry) => entry.threadId)).toEqual(["two", "one"]);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(two.result).resolves.toBe("two");
    expect(started).toEqual(["two"]);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(one.result).resolves.toBe("one");
    expect(started).toEqual(["two", "one"]);
  });

  it("applies an operator reorder only against the unclaimed order it observed (#570)", () => {
    const mesh = new ConcurrencyLimiter(1);
    const queue = new UnifiedAdmissionQueue<string>();
    const delayed = laneFor("delayed", 60_000);
    delayed.pacer.deferUntil(Date.now() + 60_000);
    const run = (id: string) =>
      queue.enqueue(async () => id, [delayed], {
        threadId: id,
        enqueueNormal: (fn) => mesh.enqueue(fn),
      });
    run("one");
    run("two");

    expect(queue.reorderObserved(["one", "two"], "two", "one")).toEqual({
      status: "ok",
      order: ["two", "one"],
    });
    // The operator's view still shows the old order: nothing moves.
    expect(queue.reorderObserved(["one", "two"], "one")).toEqual({
      status: "stale",
      order: ["two", "one"],
    });
    // An arrival the operator has not seen also makes the view stale.
    run("three");
    expect(queue.reorderObserved(["two", "one"], "one", "two")).toEqual({
      status: "stale",
      order: ["two", "one", "three"],
    });
    // A current view with an actor that is not in it is a bad request.
    expect(queue.reorderObserved(["two", "one", "three"], "missing")).toEqual({
      status: "invalid",
      order: ["two", "one", "three"],
    });
    expect(queue.unclaimedOrder()).toEqual(["two", "one", "three"]);
  });

  it("makes a claim race stale before invalidating a claimed target (#570)", async () => {
    const mesh = new ConcurrencyLimiter(1);
    const queue = new UnifiedAdmissionQueue<string>();
    const a = laneFor("a");
    const b = laneFor("b");
    b.pacer.deferUntil(Date.now() + 60_000);
    let releaseBlocker!: () => void;
    queue.enqueue(
      () => new Promise<string>((resolve) => (releaseBlocker = () => resolve("blocker"))),
      [a],
      { threadId: "blocker", enqueueNormal: (fn) => mesh.enqueue(fn) }
    );
    await vi.advanceTimersByTimeAsync(0);
    const run = (id: string, lanes: ReturnType<typeof laneFor>[]) =>
      queue.enqueue(async (config) => config, lanes, {
        threadId: id,
        enqueueNormal: (fn) => mesh.enqueue(fn),
      });
    run("claimed", [a, b]);
    run("waiting", [b, b]);
    await vi.advanceTimersByTimeAsync(0);

    expect(queue.snapshot()).toEqual([
      expect.objectContaining({
        threadId: "claimed",
        claimed: true,
        compatibleLanes: ["a", "b"],
        claimedLane: "a",
      }),
      expect.objectContaining({
        threadId: "waiting",
        claimed: false,
        compatibleLanes: ["b"],
        claimedLane: null,
      }),
    ]);
    expect(queue.unclaimedOrder()).toEqual(["waiting"]);
    // The operator saw `claimed` while it was still unclaimed. Its claim is a
    // concurrent list change, so the observed-order check wins over the later
    // "claimed entries cannot move" validation.
    expect(queue.reorderObserved(["claimed", "waiting"], "claimed")).toEqual({
      status: "stale",
      order: ["waiting"],
    });
    // A request rendered after that claim has the live unclaimed order, and
    // now correctly identifies the claimed target as invalid.
    expect(queue.reorderObserved(["waiting"], "claimed")).toMatchObject({ status: "invalid" });
    expect(queue.reorderObserved(["waiting"], "waiting", "claimed")).toMatchObject({
      status: "invalid",
    });
    releaseBlocker();
  });

  it("records a compatibility skip when a later actor claims a lane the waiting one cannot use (#570)", async () => {
    const mesh = new ConcurrencyLimiter(4);
    const queue = new UnifiedAdmissionQueue<string>();
    const open = laneFor("open", 60_000);
    const closed = laneFor("closed", 60_000);
    const later = laneFor("later", 60_000);
    closed.pacer.deferUntil(Date.now() + 120_000);
    open.pacer.deferUntil(Date.now() + 1_000);
    later.pacer.deferUntil(Date.now() + 2_000);
    const run = (id: string, lanes: ReturnType<typeof laneFor>[]) =>
      queue.enqueue(async (config) => config, lanes, {
        threadId: id,
        enqueueNormal: (fn) => mesh.enqueue(fn),
      });
    run("head", [closed]);
    run("flexible", [closed, open]);
    const narrow = run("narrow", [open]);
    run("tail", [later]);
    // Nothing has been passed over yet: a projected wait is not a skip.
    expect(queue.snapshot().map((entry) => entry.skip)).toEqual([null, null, null, null]);

    await vi.advanceTimersByTimeAsync(1_000);
    // `flexible` claimed `open`; `head` cannot use it, so it was skipped.
    expect(queue.snapshot()).toEqual([
      expect.objectContaining({ threadId: "head", skip: { lane: "open", count: 1 } }),
      expect.objectContaining({ threadId: "narrow", skip: null }),
      expect.objectContaining({ threadId: "tail", skip: null }),
    ]);

    // `tail` claims `later`: the count totals skips across lanes, and the
    // lane names only the most recent one.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queue.snapshot()).toEqual([
      expect.objectContaining({ threadId: "head", skip: { lane: "later", count: 2 } }),
      expect.objectContaining({ threadId: "narrow", skip: { lane: "later", count: 1 } }),
    ]);

    await vi.advanceTimersByTimeAsync(59_000);
    await expect(narrow.result).resolves.toBe("open");
    expect(queue.snapshot()).toEqual([
      expect.objectContaining({ threadId: "head", skip: { lane: "open", count: 3 } }),
    ]);
  });

  it("promotes waiting work past pacing, and claimed work only on its own lane", async () => {
    const mesh = new ConcurrencyLimiter(1);
    const queue = new UnifiedAdmissionQueue<string>();
    const quota = (percentLeft: number) => ({
      percentLeft,
      observedAt: new Date(Date.now()).toISOString(),
      resetAtIso: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString(),
    });
    const a = { ...laneFor("a"), weeklyQuota: quota(10) };
    const b = { ...laneFor("b"), weeklyQuota: quota(90) };
    b.pacer.deferUntil(Date.now() + 60_000);
    let releaseBlocker!: () => void;
    queue.enqueue(
      () => new Promise<string>((resolve) => (releaseBlocker = () => resolve("blocker"))),
      [a],
      { threadId: "blocker", enqueueNormal: (fn) => mesh.enqueue(fn) }
    );
    await vi.advanceTimersByTimeAsync(0);
    const selected: Array<{ id: string; lane: string; responsive: boolean }> = [];
    const run = (id: string, lanes: ReturnType<typeof laneFor>[]) =>
      queue.enqueue(async (config) => config, lanes, {
        threadId: id,
        enqueueNormal: (fn) => mesh.enqueue(fn),
        onSelected: ({ lane, responsive }) => selected.push({ id, lane, responsive }),
      });
    // `claimed` holds lane a, staged behind the full mesh; `waiting` has only
    // the deferred lane b, so it is still unclaimed.
    const claimed = run("claimed", [a, b]);
    const waiting = run("waiting", [b]);
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.snapshot()).toEqual([
      expect.objectContaining({ threadId: "claimed", estimatedStartAt: null }),
      expect.objectContaining({ threadId: "waiting" }),
    ]);

    // Normal admission chose a because b was deferred. At promotion time b
    // has decisively better weekly headroom, so a generic pool promotion
    // would transfer to b. A claimed admission must retain its a-only pool.
    expect(selectPoolLane([a, b], Date.now(), { responsive: true })?.lane).toBe("b");
    waiting.promote();
    claimed.promote();
    await expect(waiting.result).resolves.toBe("b");
    await expect(claimed.result).resolves.toBe("a");
    expect(selected).toEqual([
      { id: "claimed", lane: "a", responsive: false },
      { id: "waiting", lane: "b", responsive: true },
      { id: "claimed", lane: "a", responsive: true },
    ]);
    releaseBlocker();
  });

  it("skips a blocked head for a compatible actor, never letting a provider-wide lane claim a model-scoped one", async () => {
    const mesh = new ConcurrencyLimiter(2);
    const queue = new UnifiedAdmissionQueue<{ provider: string; model: string }>();
    const genericClaude = new ProviderPacer(0, () => Date.now());
    const fableOnly = new ProviderPacer(0, () => Date.now());
    // The Fable-scoped gate is closed; the Claude-wide lane is idle. A Fable
    // start must wait for its own gate, not slip through the wider one.
    fableOnly.deferUntil(Date.now() + 5_000);
    const selected: string[] = [];
    const run = (threadId: string, candidate: { provider: string; model: string }, lane: string) =>
      queue.enqueue(
        async (config) => {
          selected.push(`${config.provider}/${config.model}@${lane}`);
          return config.model;
        },
        [{ config: candidate, lane, pacer: lane === "claude" ? genericClaude : fableOnly }],
        { threadId, enqueueNormal: (fn) => mesh.enqueue(fn) }
      );

    const fable = run("fable", { provider: "claude", model: "fable" }, "claude:fable");
    const generic = run("generic", { provider: "claude", model: "sonnet" }, "claude");

    await expect(generic.result).resolves.toBe("sonnet");
    expect(selected).toEqual(["claude/sonnet@claude"]);
    expect(queue.snapshot()).toEqual([
      expect.objectContaining({
        threadId: "fable",
        position: 0,
        estimatedStartAt: Date.now() + 5_000,
      }),
    ]);

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(fable.result).resolves.toBe("fable");
    expect(selected).toEqual(["claude/sonnet@claude", "claude/fable@claude:fable"]);
  });

  it("claims an actor at most once when several compatible lanes open together", async () => {
    const mesh = new ConcurrencyLimiter(4);
    const queue = new UnifiedAdmissionQueue<string>();
    const a = laneFor("a");
    const b = laneFor("b");
    a.pacer.deferUntil(Date.now() + 1_000);
    b.pacer.deferUntil(Date.now() + 1_000);
    const runs: string[] = [];
    const selections: number[] = [];

    const only = queue.enqueue(
      async (config) => {
        runs.push(config);
        return config;
      },
      [a, b],
      {
        threadId: "only",
        enqueueNormal: (fn) => mesh.enqueue(fn),
        onSelected: (selection) => selections.push(selection.declaredIndex),
      }
    );
    // Both lanes reach capacity on the same tick, and a refresh (e.g. a
    // coordinator publication) re-enters the scan at the same moment.
    await vi.advanceTimersByTimeAsync(1_000);
    queue.refresh();
    await vi.advanceTimersByTimeAsync(0);

    await expect(only.result).resolves.toBe("a");
    expect(runs).toEqual(["a"]);
    expect(selections).toEqual([0]);
    expect(a.pacer.waiting + b.pacer.waiting).toBe(0);
  });

  it("holds unclaimed work in the list while mesh concurrency is full, one staged claim per lane", async () => {
    const mesh = new ConcurrencyLimiter(1);
    const queue = new UnifiedAdmissionQueue<string>();
    const a = laneFor("a");
    const b = laneFor("b");
    const releases: Array<() => void> = [];
    const started: string[] = [];
    const run = (id: string, lanes: ReturnType<typeof laneFor>[]) =>
      queue.enqueue(
        () => {
          started.push(id);
          return new Promise<string>((resolve) => releases.push(() => resolve(id)));
        },
        lanes,
        { threadId: id, enqueueNormal: (fn) => mesh.enqueue(fn) }
      );

    const first = run("first", [a]);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["first"]);

    const second = run("second", [a]);
    const third = run("third", [b]);
    const fourth = run("fourth", [a, b]);
    await vi.advanceTimersByTimeAsync(0);

    // Lane a claimed `second`, lane b claimed `third`; both wait on the one
    // mesh slot. `fourth` stays unclaimed rather than queueing behind a lane.
    expect(started).toEqual(["first"]);
    expect(a.pacer.waiting).toBe(1);
    expect(b.pacer.waiting).toBe(1);
    expect(queue.snapshot()).toEqual([
      expect.objectContaining({ threadId: "second", position: 0, estimatedStartAt: null }),
      expect.objectContaining({ threadId: "third", position: 1, estimatedStartAt: null }),
      expect.objectContaining({ threadId: "fourth", position: 2 }),
    ]);

    releases.shift()?.();
    await expect(first.result).resolves.toBe("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["first", "second"]);
    // Lane a is idle again, so it claims the waiting `fourth`.
    expect(queue.snapshot().map((entry) => entry.threadId)).toEqual(["third", "fourth"]);

    for (const expected of ["second", "third", "fourth"]) {
      releases.shift()?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(started).toContain(expected);
    }
    await expect(Promise.all([second.result, third.result, fourth.result])).resolves.toEqual([
      "second",
      "third",
      "fourth",
    ]);
  });

  it("cancels a claimed-but-unstarted actor and lets its lane claim the next one", async () => {
    const mesh = new ConcurrencyLimiter(1);
    const queue = new UnifiedAdmissionQueue<string>();
    const a = laneFor("a");
    let releaseBlocker!: () => void;
    const started: string[] = [];
    const blocker = queue.enqueue(
      () => {
        started.push("blocker");
        return new Promise<string>((resolve) => {
          releaseBlocker = () => resolve("blocker");
        });
      },
      [a],
      { threadId: "blocker", enqueueNormal: (fn) => mesh.enqueue(fn) }
    );
    await vi.advanceTimersByTimeAsync(0);
    const run = (id: string) =>
      queue.enqueue(
        async () => {
          started.push(id);
          return id;
        },
        [a],
        { threadId: id, enqueueNormal: (fn) => mesh.enqueue(fn) }
      );
    const claimed = run("claimed");
    const next = run("next");
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.snapshot().map((entry) => entry.threadId)).toEqual(["claimed", "next"]);
    expect(a.pacer.waiting).toBe(1);

    expect(claimed.cancel?.()).toBe(true);
    await expect(claimed.result).rejects.toThrow(/cancelled before start/);
    await vi.advanceTimersByTimeAsync(0);
    // The freed lane claimed `next`; it now waits on the mesh slot.
    expect(queue.snapshot()).toEqual([
      expect.objectContaining({ threadId: "next", position: 0, estimatedStartAt: null }),
    ]);

    releaseBlocker();
    await expect(blocker.result).resolves.toBe("blocker");
    await expect(next.result).resolves.toBe("next");
    expect(started).toEqual(["blocker", "next"]);
  });

  it("leaves a claimed actor on its lane when that lane is deferred before the start", async () => {
    // #672 consumes a claim: no release/transfer. At most one actor per lane
    // pays this, waiting out the deferral while another of its lanes is idle.
    const mesh = new ConcurrencyLimiter(1);
    const queue = new UnifiedAdmissionQueue<string>();
    const a = laneFor("a");
    const b = laneFor("b");
    let releaseBlocker!: () => void;
    const blocker = queue.enqueue(
      () => new Promise<string>((resolve) => (releaseBlocker = () => resolve("blocker"))),
      [a],
      { threadId: "blocker", enqueueNormal: (fn) => mesh.enqueue(fn) }
    );
    await vi.advanceTimersByTimeAsync(0);
    const started: string[] = [];
    const claimed = queue.enqueue(
      async (config) => {
        started.push(config);
        return config;
      },
      [a, b],
      { threadId: "claimed", enqueueNormal: (fn) => mesh.enqueue(fn) }
    );
    expect(a.pacer.waiting).toBe(1);

    a.pacer.deferUntil(Date.now() + 60_000);
    queue.refresh();
    releaseBlocker();
    await expect(blocker.result).resolves.toBe("blocker");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([]);
    expect(b.pacer.waiting).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(claimed.result).resolves.toBe("a");
  });

  it("starts a waiting actor on another compatible lane when that lane gains capacity first", async () => {
    const mesh = new ConcurrencyLimiter(2);
    const queue = new UnifiedAdmissionQueue<string>();
    const slow = laneFor("slow");
    slow.pacer.deferUntil(Date.now() + 60 * 60_000);
    const fast = laneFor("fast", 60_000);
    // A start on `fast` opens its 60s pacing gap.
    await expect(
      queue.enqueue(async (config) => config, [fast], {
        threadId: "earlier",
        enqueueNormal: (fn) => mesh.enqueue(fn),
      }).result
    ).resolves.toBe("fast");

    const started: string[] = [];
    const handle = queue.enqueue(
      async (config) => {
        started.push(config);
        return config;
      },
      [slow, fast],
      { threadId: "waiter", enqueueNormal: (fn) => mesh.enqueue(fn) }
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.snapshot().map((entry) => entry.threadId)).toEqual(["waiter"]);

    // A controller publication shortens `fast`'s interval and refreshes the
    // list, as start.ts does on every throttle tick. Nothing re-pins the
    // actor: the lane simply becomes a processor that can claim it.
    fast.pacer.setInterval(1_000);
    queue.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toEqual(["fast"]);
    await expect(handle.result).resolves.toBe("fast");
  });

  it("breaks an idle-lane tie on the weekly headroom read at claim time", async () => {
    const mesh = new ConcurrencyLimiter(2);
    const queue = new UnifiedAdmissionQueue<string>();
    const resetAtIso = new Date(Date.now() + 3.5 * 24 * 60 * 60 * 1000).toISOString();
    const percentLeft = new Map([
      ["first", 80],
      ["second", 10],
    ]);
    // start.ts supplies the reading through a getter over the latest
    // coordinator publication, as these candidates do.
    const withQuota = (config: string) => ({
      ...laneFor(config),
      get weeklyQuota() {
        const observedAt = new Date(Date.now()).toISOString();
        return { percentLeft: percentLeft.get(config) ?? 0, observedAt, resetAtIso };
      },
    });
    const first = withQuota("first");
    const second = withQuota("second");
    first.pacer.deferUntil(Date.now() + 60 * 60_000);
    second.pacer.deferUntil(Date.now() + 60 * 60_000);
    const handle = queue.enqueue(async (config) => config, [first, second], {
      threadId: "picker",
      enqueueNormal: (fn) => mesh.enqueue(fn),
    });

    // Headroom reverses while the actor waits past the enqueue-time reading.
    percentLeft.set("first", 10);
    percentLeft.set("second", 80);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await expect(handle.result).resolves.toBe("second");
  });
});
