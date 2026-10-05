import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { AvailabilityHoldRepository } from "./availability-hold-repository.js";

const CREATED = "2026-10-05T10:00:00.000Z";
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const LATER = "2026-10-05T18:52:00.000Z";

describe("AvailabilityHoldRepository", () => {
  let db: Database.Database;
  let holds: AvailabilityHoldRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    holds = new AvailabilityHoldRepository(db);
  });

  it("holds every model on a provider when no models are given", () => {
    holds.set({ provider: "kimi", expiry: LATER, createdBy: "root", createdAt: CREATED });

    expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(true);
    expect(holds.isHeld("kimi", "kimi-k3", NOW)).toBe(true);
    expect(holds.isHeld("kimi", undefined, NOW)).toBe(true);
    expect(holds.isHeld("codex", "gpt-5.5", NOW)).toBe(false);
  });

  it("holds only the listed models on a model-scoped hold", () => {
    holds.set({
      provider: "codex",
      models: ["GPT-5.5", "gpt-5.5-mini"],
      createdBy: "root",
      createdAt: CREATED,
    });

    expect(holds.isHeld("codex", "gpt-5.5", NOW)).toBe(true);
    expect(holds.isHeld("codex", "GPT-5.5-MINI", NOW)).toBe(true);
    expect(holds.isHeld("codex", "gpt-5.6", NOW)).toBe(false);
    // Same model name on another provider is a different lane.
    expect(holds.isHeld("openrouter", "gpt-5.5", NOW)).toBe(false);
    // A caller that cannot name its model must not run on a partly held lane.
    expect(holds.isHeld("codex", undefined, NOW)).toBe(true);
  });

  it("keeps an indefinite hold until it is cleared", () => {
    holds.set({ provider: "claude", createdBy: "root", createdAt: CREATED });

    expect(holds.isHeld("claude", "opus", Date.parse("2099-01-01T00:00:00Z"))).toBe(true);
    expect(holds.list()).toEqual([
      { provider: "claude", reason: "", createdBy: "root", createdAt: CREATED },
    ]);
  });

  it("stops holding at expiry without deleting the row", () => {
    holds.set({ provider: "kimi", expiry: LATER, createdBy: "root", createdAt: CREATED });
    const expiry = Date.parse(LATER);

    expect(holds.isHeld("kimi", "kimi-k2", expiry - 1)).toBe(true);
    expect(holds.isHeld("kimi", "kimi-k2", expiry)).toBe(false);
    expect(holds.list({ now: expiry })).toEqual([]);
    expect(holds.list()).toHaveLength(1);
  });

  it("normalizes provider aliases and canonicalizes timestamps", () => {
    const [stored] = holds.set({
      provider: " AGY ",
      expiry: "2026-10-05T20:52:00+02:00",
      reason: "capacity",
      createdBy: "root",
      createdAt: CREATED,
    });

    expect(stored).toEqual({
      provider: "antigravity",
      expiry: LATER,
      reason: "capacity",
      createdBy: "root",
      createdAt: CREATED,
    });
    expect(holds.isHeld("agy", "gemini-3-pro", NOW)).toBe(true);
  });

  it("replaces a hold with the same scope instead of stacking another", () => {
    holds.set({ provider: "kimi", expiry: LATER, createdBy: "root", createdAt: CREATED });
    holds.set({ provider: "kimi", reason: "outage", createdBy: "steward", createdAt: CREATED });

    expect(holds.list()).toEqual([
      { provider: "kimi", reason: "outage", createdBy: "steward", createdAt: CREATED },
    ]);
  });

  it("lets provider-wide and model-scoped holds coexist", () => {
    holds.set({ provider: "kimi", expiry: LATER, createdBy: "root", createdAt: CREATED });
    holds.set({ provider: "kimi", models: ["kimi-k2"], createdBy: "root", createdAt: CREATED });

    expect(holds.list().map((hold) => hold.model ?? "*")).toEqual(["*", "kimi-k2"]);
    // The model hold outlives the bounded provider-wide one.
    expect(holds.isHeld("kimi", "kimi-k2", Date.parse(LATER))).toBe(true);
    expect(holds.isHeld("kimi", "kimi-k3", Date.parse(LATER))).toBe(false);
  });

  it("clears listed models and leaves a provider-wide hold in place", () => {
    holds.set({ provider: "kimi", createdBy: "root", createdAt: CREATED });
    holds.set({ provider: "kimi", models: ["kimi-k2"], createdBy: "root", createdAt: CREATED });

    expect(holds.clear({ provider: "kimi", models: ["Kimi-K2"] })).toEqual([
      { provider: "kimi", model: "kimi-k2", reason: "", createdBy: "root", createdAt: CREATED },
    ]);
    expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(true);
  });

  it("clears every hold on a provider when no models are given", () => {
    holds.set({ provider: "kimi", createdBy: "root", createdAt: CREATED });
    holds.set({ provider: "kimi", models: ["kimi-k2"], createdBy: "root", createdAt: CREATED });
    holds.set({ provider: "codex", createdBy: "root", createdAt: CREATED });

    expect(holds.clear({ provider: "kimi" }).map((hold) => hold.model ?? "*")).toEqual([
      "*",
      "kimi-k2",
    ]);
    expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(false);
    expect(holds.isHeld("codex", "gpt-5.5", NOW)).toBe(true);
    expect(holds.clear({ provider: "kimi" })).toEqual([]);
  });

  it("clears every hold at once", () => {
    holds.set({ provider: "kimi", createdBy: "root", createdAt: CREATED });
    holds.set({ provider: "codex", models: ["gpt-5.5"], createdBy: "root", createdAt: CREATED });

    expect(holds.clearAll()).toHaveLength(2);
    expect(holds.list()).toEqual([]);
  });

  it("survives reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "availability-holds-"));
    const file = join(dir, "mesh.db");
    const first = new Database(file);
    runMigrations(first);
    new AvailabilityHoldRepository(first).set({
      provider: "kimi",
      expiry: LATER,
      createdBy: "root",
      createdAt: CREATED,
    });
    first.close();

    const second = new Database(file);
    try {
      runMigrations(second);
      expect(new AvailabilityHoldRepository(second).isHeld("kimi", "kimi-k2", NOW)).toBe(true);
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses blank scopes and unparseable timestamps", () => {
    expect(() => holds.set({ provider: " ", createdBy: "root", createdAt: CREATED })).toThrow(
      /requires a provider/
    );
    expect(() =>
      holds.set({ provider: "kimi", models: [" "], createdBy: "root", createdAt: CREATED })
    ).toThrow(/cannot be blank/);
    expect(() =>
      holds.set({ provider: "kimi", expiry: "soon", createdBy: "root", createdAt: CREATED })
    ).toThrow(/invalid availability hold expiry/);
    expect(holds.list()).toEqual([]);
  });
});
