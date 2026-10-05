import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import {
  type AvailabilityHold,
  AvailabilityHoldRepository,
} from "../db/repositories/availability-hold-repository.js";
import { AvailabilityHolds } from "./availability-holds.js";

const START = Date.parse("2026-10-05T12:00:00.000Z");
const HOUR = 60 * 60 * 1000;

describe("AvailabilityHolds", () => {
  let repo: AvailabilityHoldRepository;
  let held: AvailabilityHold[][];
  let released: AvailabilityHold[][];
  let holds: AvailabilityHolds;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    const db = new Database(":memory:");
    runMigrations(db);
    repo = new AvailabilityHoldRepository(db);
    held = [];
    released = [];
    holds = new AvailabilityHolds({
      repo,
      onHeld: (stored) => held.push(stored),
      onReleased: (cleared) => released.push(cleared),
    });
  });

  afterEach(() => {
    holds.stop();
    vi.useRealTimers();
  });

  it("stamps the creation time and reports the stored hold to onHeld", () => {
    const stored = holds.set({ provider: "kimi", reason: "capacity", createdBy: "root" });

    expect(stored).toEqual([
      {
        provider: "kimi",
        reason: "capacity",
        createdBy: "root",
        createdAt: new Date(START).toISOString(),
      },
    ]);
    expect(held).toEqual([stored]);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(true);
  });

  it("refuses an expiry that is not in the future", () => {
    expect(() =>
      holds.set({ provider: "kimi", expiry: new Date(START).toISOString(), createdBy: "root" })
    ).toThrow(/must be in the future/);
    expect(() => holds.set({ provider: "kimi", expiry: "tomorrow", createdBy: "root" })).toThrow(
      /invalid availability hold expiry/
    );
    expect(repo.list()).toEqual([]);
    expect(held).toEqual([]);
  });

  it("releases an expiring hold at its expiry without deleting it", () => {
    const expiry = new Date(START + HOUR).toISOString();
    holds.set({ provider: "kimi", expiry, createdBy: "root" });

    vi.advanceTimersByTime(HOUR - 1);
    expect(released).toEqual([]);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(true);

    vi.advanceTimersByTime(1);
    expect(released.map((batch) => batch.map((hold) => hold.provider))).toEqual([["kimi"]]);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(false);
    expect(holds.list()).toEqual([]);
    expect(repo.list()).toHaveLength(1);
  });

  it("wakes once per distinct expiry, earliest first", () => {
    holds.set({
      provider: "kimi",
      expiry: new Date(START + 2 * HOUR).toISOString(),
      createdBy: "root",
    });
    holds.set({
      provider: "codex",
      expiry: new Date(START + HOUR).toISOString(),
      createdBy: "root",
    });
    holds.set({ provider: "claude", createdBy: "root" });

    vi.advanceTimersByTime(HOUR);
    expect(released.map((batch) => batch.map((hold) => hold.provider))).toEqual([["codex"]]);
    vi.advanceTimersByTime(HOUR);
    expect(released.map((batch) => batch.map((hold) => hold.provider))).toEqual([
      ["codex"],
      ["kimi"],
    ]);
    vi.advanceTimersByTime(100 * HOUR);
    expect(released).toHaveLength(2);
    expect(holds.isHeld("claude", "opus")).toBe(true);
  });

  it("follows a replaced expiry instead of the original one", () => {
    holds.set({
      provider: "kimi",
      expiry: new Date(START + HOUR).toISOString(),
      createdBy: "root",
    });
    holds.set({
      provider: "kimi",
      expiry: new Date(START + 3 * HOUR).toISOString(),
      createdBy: "root",
    });

    vi.advanceTimersByTime(HOUR);
    expect(released).toEqual([]);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(true);
    vi.advanceTimersByTime(2 * HOUR);
    expect(released).toHaveLength(1);
  });

  it("reports cleared holds to onReleased and skips the callback when nothing matched", () => {
    holds.set({ provider: "kimi", models: ["kimi-k2"], createdBy: "root" });

    expect(holds.clear({ provider: "codex" })).toEqual([]);
    expect(released).toEqual([]);
    expect(holds.clear({ provider: "kimi", models: ["kimi-k2"] })).toHaveLength(1);
    expect(released).toHaveLength(1);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(false);
  });

  it("cancels a pending expiry wake when the hold is cleared first", () => {
    holds.set({
      provider: "kimi",
      expiry: new Date(START + HOUR).toISOString(),
      createdBy: "root",
    });
    holds.clearAll();

    vi.advanceTimersByTime(2 * HOUR);
    expect(released).toHaveLength(1);
  });

  it("arms the expiry wake for holds stored before startup", () => {
    repo.set({
      provider: "kimi",
      expiry: new Date(START + HOUR).toISOString(),
      createdBy: "root",
      createdAt: new Date(START - HOUR).toISOString(),
    });
    holds.start();

    vi.advanceTimersByTime(HOUR);
    expect(released.map((batch) => batch.map((hold) => hold.provider))).toEqual([["kimi"]]);
  });

  it("re-arms instead of releasing when an expiry is beyond the longest timer", () => {
    const far = START + 30 * 24 * HOUR;
    holds.set({ provider: "kimi", expiry: new Date(far).toISOString(), createdBy: "root" });

    vi.advanceTimersByTime(2_147_483_647);
    expect(released).toEqual([]);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(true);
    vi.advanceTimersByTime(far - Date.now());
    expect(released).toHaveLength(1);
  });
});
