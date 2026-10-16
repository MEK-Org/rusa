import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  haltIndicator,
  importScopedHaltFile,
} from "./availability-holds.js";
import type { HaltState } from "./halt-switch.js";

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
    const stored = holds.set({
      provider: "kimi",
      origin: "mesh",
      reason: "capacity",
      createdBy: "root",
    });

    expect(stored).toEqual([
      {
        provider: "kimi",
        origin: "mesh",
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
      holds.set({
        provider: "kimi",
        origin: "mesh",
        expiry: new Date(START).toISOString(),
        createdBy: "root",
      })
    ).toThrow(/must be in the future/);
    expect(() =>
      holds.set({ provider: "kimi", origin: "mesh", expiry: "tomorrow", createdBy: "root" })
    ).toThrow(/invalid availability hold expiry/);
    expect(repo.list()).toEqual([]);
    expect(held).toEqual([]);
  });

  it("wakes at each distinct expiry, following a replaced one, and keeps the expired rows", () => {
    holds.set({
      provider: "codex",
      origin: "mesh",
      expiry: new Date(START + HOUR).toISOString(),
      createdBy: "root",
    });
    holds.set({
      provider: "kimi",
      origin: "mesh",
      expiry: new Date(START + HOUR / 2).toISOString(),
      createdBy: "root",
    });
    // Setting the same scope again replaces its expiry; the earlier wake must not fire.
    holds.set({
      provider: "kimi",
      origin: "mesh",
      expiry: new Date(START + 2 * HOUR).toISOString(),
      createdBy: "root",
    });
    holds.set({ provider: "claude", origin: "mesh", createdBy: "root" });
    const releasedProviders = () => released.map((batch) => batch.map((hold) => hold.provider));

    vi.advanceTimersByTime(HOUR - 1);
    expect(released).toEqual([]);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(releasedProviders()).toEqual([["codex"]]);
    expect(holds.isHeld("codex", "gpt-5.5")).toBe(false);
    vi.advanceTimersByTime(HOUR);
    expect(releasedProviders()).toEqual([["codex"], ["kimi"]]);
    vi.advanceTimersByTime(100 * HOUR);
    expect(released).toHaveLength(2);
    expect(holds.isHeld("claude", "opus")).toBe(true);
    expect(holds.list()).toHaveLength(1);
    expect(repo.list()).toHaveLength(3);
  });

  it("reports cleared holds to onReleased, skips it when nothing matched, and cancels their wake", () => {
    holds.set({
      provider: "kimi",
      origin: "mesh",
      models: ["kimi-k2"],
      expiry: new Date(START + HOUR).toISOString(),
      createdBy: "root",
    });

    expect(holds.clear({ provider: "codex" })).toEqual({ released: [], expired: [] });
    expect(released).toEqual([]);
    expect(holds.clear({ provider: "kimi", models: ["kimi-k2"] }).released).toHaveLength(1);
    expect(released).toHaveLength(1);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(false);
    vi.advanceTimersByTime(2 * HOUR);
    expect(released).toHaveLength(1);
  });

  it("removes expired records apart from released holds, and only a released hold fires onReleased", () => {
    holds.set({
      provider: "kimi",
      origin: "mesh",
      expiry: new Date(START + HOUR).toISOString(),
      createdBy: "root",
    });
    holds.set({ provider: "codex", origin: "mesh", models: ["gpt-5.5"], createdBy: "root" });
    vi.advanceTimersByTime(HOUR);
    released.length = 0;

    const expiredOnly = holds.clear({ provider: "kimi" });
    expect(expiredOnly.released).toEqual([]);
    expect(expiredOnly.expired.map((hold) => hold.provider)).toEqual(["kimi"]);
    expect(released).toEqual([]);
    expect(repo.list().map((hold) => hold.provider)).toEqual(["codex"]);

    const active = holds.clear({ provider: "codex" });
    expect(active.released.map((hold) => hold.model)).toEqual(["gpt-5.5"]);
    expect(active.expired).toEqual([]);
    expect(released).toEqual([active.released]);
  });

  it("reports every hold that expired by the time a late wake fires", () => {
    let lag = 0;
    const lagging = new AvailabilityHolds({
      repo,
      now: () => Date.now() + lag,
      onReleased: (cleared) => released.push(cleared),
    });
    lagging.set({
      provider: "codex",
      origin: "mesh",
      expiry: new Date(START + HOUR).toISOString(),
      createdBy: "root",
    });
    lagging.set({
      provider: "kimi",
      origin: "mesh",
      expiry: new Date(START + HOUR + 10).toISOString(),
      createdBy: "root",
    });
    // The wake armed for codex runs 25ms late, after kimi expired too.
    lag = 25;
    vi.advanceTimersByTime(HOUR);
    lagging.stop();

    expect(released.map((batch) => batch.map((hold) => hold.provider))).toEqual([
      ["codex", "kimi"],
    ]);
  });

  it("arms the expiry wake for holds stored before startup", () => {
    repo.set({
      provider: "kimi",
      origin: "mesh",
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
    holds.set({
      provider: "kimi",
      origin: "mesh",
      expiry: new Date(far).toISOString(),
      createdBy: "root",
    });

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
    holds.set({ provider: "kimi", origin: "mesh", createdBy: "root" }, { silent: true });
    expect(holds.clear({ provider: "kimi" }, { silent: true }).released).toHaveLength(1);
    expect(calls).toEqual([]);
    holds.stop();
  });
});

describe("AvailabilityHolds origins (#918)", () => {
  let repo: AvailabilityHoldRepository;
  let released: AvailabilityHold[][];
  let holds: AvailabilityHolds;

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    const db = new Database(":memory:");
    runMigrations(db);
    repo = new AvailabilityHoldRepository(db);
    released = [];
    holds = new AvailabilityHolds({
      repo,
      onReleased: (cleared) => released.push(cleared),
    });
  });

  afterEach(() => {
    holds.stop();
    vi.useRealTimers();
  });

  it("clears one origin on a scope and leaves the other held", () => {
    holds.set({ provider: "kimi", origin: "mesh", createdBy: "root" });
    holds.set({ provider: "kimi", origin: "chat", createdBy: "chat:users/operator" });

    const cleared = holds.clear({ provider: "kimi" }, { origin: "chat" });

    expect(cleared.released.map((hold) => hold.origin)).toEqual(["chat"]);
    expect(cleared.expired).toEqual([]);
    expect(released).toEqual([cleared.released]);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(true);
    expect(holds.list().map((hold) => hold.origin)).toEqual(["mesh"]);
  });

  it("fires onReleased only when the cleared origin had an active hold", () => {
    holds.set({ provider: "kimi", origin: "mesh", createdBy: "root" });

    expect(holds.clear({ provider: "kimi" }, { origin: "chat" })).toEqual({
      released: [],
      expired: [],
    });
    expect(released).toEqual([]);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(true);
  });

  it("clear without an origin still removes every origin (the authorized admin path)", () => {
    holds.set({ provider: "kimi", origin: "mesh", createdBy: "root" });
    holds.set({ provider: "kimi", origin: "chat", createdBy: "chat:users/operator" });

    expect(holds.clear({ provider: "kimi" }).released).toHaveLength(2);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(false);
    expect(released).toHaveLength(1);
  });

  it("clearAll releases every scope one origin holds, across providers and models", () => {
    holds.set({ provider: "kimi", origin: "chat", createdBy: "chat:users/operator" });
    holds.set({
      provider: "kimi",
      origin: "chat",
      models: ["kimi-k2"],
      createdBy: "chat:users/operator",
    });
    holds.set({ provider: "codex", origin: "chat", createdBy: "chat:users/operator" });
    holds.set({ provider: "kimi", origin: "mesh", createdBy: "root" });

    const cleared = holds.clearAll("chat");

    expect(cleared.released.map((hold) => `${hold.provider}:${hold.model ?? "*"}`).sort()).toEqual([
      "codex:*",
      "kimi:*",
      "kimi:kimi-k2",
    ]);
    expect(holds.list().map((hold) => hold.origin)).toEqual(["mesh"]);
    expect(holds.isHeld("kimi", "kimi-k2")).toBe(true);
    expect(holds.isHeld("codex", "gpt-5.5")).toBe(false);
  });

  it("cancels the expiry wake of a cleared origin and re-arms on the rows that remain", () => {
    holds.set({
      provider: "kimi",
      origin: "chat",
      expiry: new Date(START + HOUR).toISOString(),
      createdBy: "chat:users/operator",
    });
    holds.set({
      provider: "kimi",
      origin: "mesh",
      expiry: new Date(START + 2 * HOUR).toISOString(),
      createdBy: "root",
    });

    holds.clear({ provider: "kimi" }, { origin: "chat" });
    released.length = 0;

    vi.advanceTimersByTime(HOUR);
    expect(released).toEqual([]);
    vi.advanceTimersByTime(HOUR);
    expect(released.map((batch) => batch.map((hold) => hold.origin))).toEqual([["mesh"]]);
  });
});

describe("haltIndicator origin handling (#918)", () => {
  const hold = (provider: string, model: string | undefined, origin: "chat" | "mesh") => ({
    provider,
    ...(model ? { model } : {}),
    origin,
    expiry: "2026-10-05T13:00:00.000Z",
    reason: "",
    createdBy: origin === "chat" ? "chat:users/operator" : "root",
    createdAt: "2026-10-05T12:00:00.000Z",
  });

  it("counts a scope held through both origins once when synthesizing the snapshot", () => {
    const indicator = haltIndicator({ state: () => null }, () => [
      hold("codex", "gpt-5.5", "chat"),
      hold("codex", "gpt-5.5", "mesh"),
    ]);

    // The lane is held either way, and the synthesized scope names it once.
    expect(indicator.isHalted()).toBe(true);
    expect(indicator.haltSnapshot()).toEqual({
      providers: ["codex"],
      models: ["gpt-5.5"],
      until: "2026-10-05T13:00:00.000Z",
    });
  });

  it("reflects the rows remaining after a chat release: the mesh hold keeps the lane halted", () => {
    const remaining = [hold("codex", "gpt-5.5", "mesh")];
    const indicator = haltIndicator({ state: () => null }, () => remaining);

    expect(indicator.isHalted()).toBe(true);
    expect(indicator.haltSnapshot()).toEqual({
      providers: ["codex"],
      models: ["gpt-5.5"],
      until: "2026-10-05T13:00:00.000Z",
    });
  });

  it("binds a scope two origins hold to the later expiry", () => {
    const indicator = haltIndicator({ state: () => null }, () => [
      hold("codex", "gpt-5.5", "chat"),
      { ...hold("codex", "gpt-5.5", "mesh"), expiry: "2026-10-05T14:00:00.000Z" },
    ]);

    expect(indicator.isHalted()).toBe(true);
    // The lane frees only when the last origin's hold lapses.
    expect(indicator.haltSnapshot()).toEqual({
      providers: ["codex"],
      models: ["gpt-5.5"],
      until: "2026-10-05T14:00:00.000Z",
    });
  });
});

describe("haltIndicator", () => {
  const UNTIL = "2026-10-05T13:00:00.000Z";
  const hold = (provider: string, model?: string, expiry: string | null = UNTIL) => ({
    provider,
    ...(model ? { model } : {}),
    origin: "chat" as const,
    ...(expiry ? { expiry } : {}),
    reason: "chat /halt from Operator",
    createdBy: "chat:users/operator",
    createdAt: "2026-10-05T12:00:00.000Z",
  });
  const reason = "chat /halt from Operator";

  it.each<{
    name: string;
    brake: HaltState | null;
    holds: AvailabilityHold[];
    snapshot: HaltState | null;
  }>([
    { name: "nothing halted", brake: null, holds: [], snapshot: null },
    {
      name: "the brake file alone",
      brake: { providers: ["codex"], until: UNTIL },
      holds: [],
      snapshot: { providers: ["codex"], until: UNTIL },
    },
    {
      name: "the global brake, which covers every hold",
      brake: { reason: "stop" },
      holds: [hold("codex")],
      snapshot: { reason: "stop" },
    },
    {
      name: "a scoped brake file beside holds",
      brake: { providers: ["claude"] },
      holds: [hold("codex")],
      snapshot: null,
    },
    {
      name: "provider-wide holds sharing an expiry",
      brake: null,
      holds: [hold("claude"), hold("codex")],
      snapshot: { reason, providers: ["claude", "codex"], until: UNTIL },
    },
    {
      name: "a full providers × models product with no expiry",
      brake: null,
      holds: [
        hold("codex", "gpt-5.5", null),
        hold("codex", "gpt-5.5-mini", null),
        hold("openrouter", "gpt-5.5", null),
        hold("openrouter", "gpt-5.5-mini", null),
      ],
      snapshot: {
        reason,
        providers: ["codex", "openrouter"],
        models: ["gpt-5.5", "gpt-5.5-mini"],
      },
    },
    {
      name: "holds with different expiries",
      brake: null,
      holds: [hold("claude"), hold("codex", undefined, null)],
      snapshot: null,
    },
    {
      name: "a provider-wide hold beside a model hold",
      brake: null,
      holds: [hold("claude"), hold("codex", "gpt-5.5")],
      snapshot: null,
    },
    {
      name: "model holds that are not a full product",
      brake: null,
      holds: [hold("codex", "gpt-5.5"), hold("openrouter", "gpt-5.5-mini")],
      snapshot: null,
    },
    {
      name: "distinct lanes whose provider and model names join alike",
      brake: null,
      holds: [hold("kimi", "xm"), hold("kimix", "m"), hold("kimixm")],
      snapshot: null,
    },
  ])("reports $name exactly or not at all", ({ brake, holds, snapshot }) => {
    const indicator = haltIndicator({ state: () => brake }, () => holds);

    expect(indicator.isHalted()).toBe(brake !== null || holds.length > 0);
    expect(indicator.haltSnapshot()).toEqual(snapshot);
  });

  it("omits a reason the holds do not share", () => {
    const indicator = haltIndicator({ state: () => null }, () => [
      hold("claude"),
      { ...hold("codex"), reason: "capacity" },
    ]);

    expect(indicator.haltSnapshot()).toEqual({ providers: ["claude", "codex"], until: UNTIL });
  });
});

describe("describeHold", () => {
  it("names provider, model scope, expiry and reason", () => {
    const base = {
      origin: "mesh" as const,
      reason: "",
      createdBy: "root",
      createdAt: "2026-10-05T12:00:00.000Z",
    };
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
  const archives = () => readdirSync(dir).filter((name) => name.startsWith("HALT.imported-"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "halt-import-"));
    file = join(dir, "HALT");
    db = new Database(":memory:");
    runMigrations(db);
    repo = new AvailabilityHoldRepository(db);
    events = new MeshEventRepository(db);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("moves a provider-scoped sentinel into holds, records one event and archives the file", () => {
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
      origin: "chat",
      expiry: until,
      reason: "chat /halt from Operator",
      createdBy: HALT_FILE_IMPORT_CREATOR,
      createdAt: mtime.toISOString(),
    });
    expect(imported).toEqual([expected("claude"), expected("codex")]);
    expect(repo.list()).toEqual([expected("claude"), expected("codex")]);
    expect(existsSync(file)).toBe(false);
    expect(archives()).toHaveLength(1);
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

  it("replays to the same holds and a single event after a crash before the file was archived", () => {
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
    expect(archives()).toHaveLength(1);
  });

  it("keeps an earlier archive when a later hand-written sentinel is imported", () => {
    writeHalt({ reason: "first", providers: ["kimi"] });
    importFile();
    writeHalt({ reason: "second", providers: ["codex"] });
    importFile();

    const kept = archives().map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")).reason);
    expect(kept.sort()).toEqual(["first", "second"]);
  });

  it("leaves a missing sentinel, the global brake, an expired one and a models-only one alone", () => {
    expect(importFile()).toEqual([]);
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
});
