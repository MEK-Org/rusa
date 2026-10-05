import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { AvailabilityHoldRepository } from "../db/repositories/availability-hold-repository.js";
import { AvailabilityHolds } from "./availability-holds.js";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import { ProviderPacer, UnifiedAdmissionQueue } from "./provider-pacer.js";

type Entry = { provider: string; model: string };

const HOUR = 60 * 60 * 1000;

/**
 * #539 acceptance at the selection boundary: holds filter the configured pool
 * before pacing quotes it, never rewrite the pool, and a released hold makes
 * its entry eligible again on the next scan.
 */
describe("availability holds in admission", () => {
  let holds: AvailabilityHolds;
  let queue: UnifiedAdmissionQueue<Entry>;
  let mesh: ConcurrencyLimiter;

  const lane = (entry: Entry) => ({
    config: entry,
    lane: entry.provider,
    pacer: new ProviderPacer(0, () => Date.now()),
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse("2026-10-05T12:00:00.000Z") });
    const db = new Database(":memory:");
    runMigrations(db);
    queue = new UnifiedAdmissionQueue<Entry>();
    mesh = new ConcurrencyLimiter(1);
    holds = new AvailabilityHolds({
      repo: new AvailabilityHoldRepository(db),
      onReleased: () => queue.refresh(),
    });
  });

  afterEach(() => {
    holds.stop();
    vi.useRealTimers();
  });

  const admit = (pool: ReturnType<typeof lane>[]) => {
    const started: Entry[] = [];
    const handle = queue.enqueue(
      async (entry) => {
        started.push(entry);
        return entry;
      },
      pool,
      {
        threadId: "actor",
        enqueueNormal: (fn) => mesh.enqueue(fn),
        isHalted: (entry) => holds.isHeld(entry.provider, entry.model),
      }
    );
    return { handle, started };
  };

  it("waits for a fallback paced ten hours instead of falling back to a held primary", async () => {
    const primary = lane({ provider: "kimi", model: "kimi-k2" });
    const fallback = lane({ provider: "codex", model: "gpt-5.5" });
    fallback.pacer.deferUntil(Date.now() + 10 * HOUR);
    const pool = [primary, fallback];
    const before = JSON.stringify(pool.map((entry) => entry.config));
    holds.set({ provider: "kimi", createdBy: "root" });

    const { handle, started } = admit(pool);
    await vi.advanceTimersByTimeAsync(10 * HOUR - 1);
    expect(started).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(handle.result).resolves.toEqual({ provider: "codex", model: "gpt-5.5" });
    expect(started).toEqual([{ provider: "codex", model: "gpt-5.5" }]);
    expect(JSON.stringify(pool.map((entry) => entry.config))).toBe(before);
  });

  it("holds only the named model, leaving the provider's other models eligible", async () => {
    const held = lane({ provider: "codex", model: "gpt-5.5" });
    const sibling = lane({ provider: "codex-mini", model: "gpt-5.5-mini" });
    holds.set({ provider: "codex", models: ["gpt-5.5"], createdBy: "root" });

    const { handle } = admit([held, sibling]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(handle.result).resolves.toEqual({ provider: "codex-mini", model: "gpt-5.5-mini" });
  });

  it("restores the held primary at expiry without a pool edit", async () => {
    const primary = lane({ provider: "kimi", model: "kimi-k2" });
    const fallback = lane({ provider: "codex", model: "gpt-5.5" });
    fallback.pacer.deferUntil(Date.now() + 10 * HOUR);
    const pool = [primary, fallback];
    const before = JSON.stringify(pool.map((entry) => entry.config));
    holds.set({
      provider: "kimi",
      expiry: new Date(Date.now() + HOUR).toISOString(),
      createdBy: "root",
    });

    const { handle, started } = admit(pool);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(started).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(handle.result).resolves.toEqual({ provider: "kimi", model: "kimi-k2" });
    expect(JSON.stringify(pool.map((entry) => entry.config))).toBe(before);
  });

  it("restores the held primary when the hold is cleared", async () => {
    const primary = lane({ provider: "kimi", model: "kimi-k2" });
    const fallback = lane({ provider: "codex", model: "gpt-5.5" });
    fallback.pacer.deferUntil(Date.now() + 10 * HOUR);
    holds.set({ provider: "kimi", createdBy: "root" });

    const { handle, started } = admit([primary, fallback]);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(started).toEqual([]);

    holds.clear({ provider: "kimi" });
    await vi.advanceTimersByTimeAsync(0);
    await expect(handle.result).resolves.toEqual({ provider: "kimi", model: "kimi-k2" });
  });
});
