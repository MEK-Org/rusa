import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import {
  type AvailabilityHold,
  AvailabilityHoldRepository,
} from "../db/repositories/availability-hold-repository.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import {
  AvailabilityHolds,
  describeHold,
  HALT_FILE_IMPORT_CREATOR,
  importScopedHaltFile,
} from "./availability-holds.js";

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

describe("AvailabilityHolds silent changes", () => {
  it("skips the callbacks for a caller that cancels and replays runs itself", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const calls: string[] = [];
    const holds = new AvailabilityHolds({
      repo: new AvailabilityHoldRepository(db),
      onHeld: () => calls.push("held"),
      onReleased: () => calls.push("released"),
    });
    holds.set({ provider: "kimi", createdBy: "root" }, { silent: true });
    holds.set({ provider: "codex", createdBy: "root" }, { silent: true });
    expect(holds.clear({ provider: "kimi" }, { silent: true })).toHaveLength(1);
    expect(holds.clearAll({ silent: true })).toHaveLength(1);
    expect(calls).toEqual([]);
    holds.stop();
  });
});

describe("describeHold", () => {
  it("names provider, model scope, expiry and reason", () => {
    const base = { reason: "", createdBy: "root", createdAt: "2026-10-05T12:00:00.000Z" };
    expect(describeHold({ ...base, provider: "kimi" })).toBe("kimi (all models), until cleared");
    expect(
      describeHold({
        ...base,
        provider: "codex",
        model: "gpt-5.5",
        expiry: "2026-10-05T13:00:00.000Z",
        reason: "capacity",
      })
    ).toBe("codex model gpt-5.5, until 2026-10-05T13:00:00.000Z — capacity");
  });
});

describe("importScopedHaltFile", () => {
  let dir: string;
  let file: string;
  let db: Database.Database;
  let repo: AvailabilityHoldRepository;
  let events: MeshEventRepository;
  const now = () => START;
  const mtime = new Date("2026-10-05T11:00:00.000Z");
  const importFile = () =>
    importScopedHaltFile({ file, repo, recordEvent: (event) => events.record(event), now });
  const writeHalt = (state: unknown) => {
    writeFileSync(file, typeof state === "string" ? state : `${JSON.stringify(state)}\n`);
    utimesSync(file, mtime, mtime);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "halt-import-"));
    file = join(dir, "HALT");
    db = new Database(":memory:");
    runMigrations(db);
    repo = new AvailabilityHoldRepository(db);
    events = new MeshEventRepository(db);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("moves a provider-scoped sentinel into holds, records one event and removes the file", () => {
    const until = new Date(START + HOUR).toISOString();
    writeHalt({
      reason: "chat /halt from Operator",
      providers: ["claude", "codex"],
      models: ["m1"],
      until,
    });

    const imported = importFile();

    const expected = (provider: string) => ({
      provider,
      model: "m1",
      expiry: until,
      reason: "chat /halt from Operator",
      createdBy: HALT_FILE_IMPORT_CREATOR,
      createdAt: mtime.toISOString(),
    });
    expect(imported).toEqual([expected("claude"), expected("codex")]);
    expect(repo.list()).toEqual([expected("claude"), expected("codex")]);
    expect(existsSync(file)).toBe(false);
    const recorded = events.list().filter((event) => event.kind === "availability_hold_imported");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.detail).toBe(
      `HALT file imported as hold on claude/m1, codex/m1 until ${until}`
    );
    expect(JSON.parse(recorded[0]?.payload ?? "{}")).toEqual({
      reason: "chat /halt from Operator",
      until,
      holds: [
        { provider: "claude", model: "m1", expiry: until },
        { provider: "codex", model: "m1", expiry: until },
      ],
    });
  });

  it("replays to the same holds and a single event after a crash before the file was removed", () => {
    writeHalt({ providers: ["kimi"] });
    // The crash: holds and event are stored, the file is still there.
    importScopedHaltFile({ file, repo, recordEvent: (event) => events.record(event), now });
    writeHalt({ providers: ["kimi"] });
    const first = repo.list();

    importFile();

    expect(repo.list()).toEqual(first);
    expect(first).toEqual([
      expect.objectContaining({ provider: "kimi", createdAt: mtime.toISOString() }),
    ]);
    expect(
      events.list().filter((event) => event.kind === "availability_hold_imported")
    ).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  });

  it("leaves the global brake, an expired sentinel and a models-only sentinel alone", () => {
    for (const state of [
      "",
      "plain reason",
      { reason: "global" },
      { providers: ["kimi"], until: new Date(START - HOUR).toISOString() },
      { models: ["m1"] },
    ]) {
      writeHalt(state);
      expect(importFile()).toEqual([]);
      expect(existsSync(file)).toBe(true);
    }
    expect(repo.list()).toEqual([]);
    expect(events.list()).toEqual([]);
  });

  it("does nothing without a sentinel", () => {
    expect(importFile()).toEqual([]);
    expect(repo.list()).toEqual([]);
  });
});
