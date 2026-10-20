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
    holds.set({
      provider: "kimi",
      origin: "mesh",
      expiry: LATER,
      createdBy: "root",
      createdAt: CREATED,
    });

    expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(true);
    expect(holds.isHeld("kimi", "kimi-k3", NOW)).toBe(true);
    expect(holds.isHeld("kimi", undefined, NOW)).toBe(true);
    expect(holds.isHeld("codex", "gpt-5.5", NOW)).toBe(false);
  });

  it("holds only the listed models on a model-scoped hold", () => {
    holds.set({
      provider: "codex",
      origin: "mesh",
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
    holds.set({ provider: "claude", origin: "mesh", createdBy: "root", createdAt: CREATED });

    expect(holds.isHeld("claude", "opus", Date.parse("2099-01-01T00:00:00Z"))).toBe(true);
    expect(holds.list()).toEqual([
      {
        provider: "claude",
        origin: "mesh",
        reason: "",
        createdBy: "root",
        createdAt: CREATED,
      },
    ]);
  });

  it("stops holding at expiry without deleting the row", () => {
    holds.set({
      provider: "kimi",
      origin: "mesh",
      expiry: LATER,
      createdBy: "root",
      createdAt: CREATED,
    });
    const expiry = Date.parse(LATER);

    expect(holds.isHeld("kimi", "kimi-k2", expiry - 1)).toBe(true);
    expect(holds.isHeld("kimi", "kimi-k2", expiry)).toBe(false);
    expect(holds.list({ now: expiry })).toEqual([]);
    expect(holds.list()).toHaveLength(1);
  });

  it.each([
    {
      name: "normalizes a provider alias and canonicalizes timestamps",
      sets: [{ provider: " AGY ", expiry: "2026-10-05T20:52:00+02:00", reason: "capacity" }],
      heldAs: ["agy", "gemini-3-pro"],
      rows: [
        {
          scope: '{"schemaVersion":1,"provider":"antigravity"}',
          origin: "mesh",
          expiry: LATER,
          reason: "capacity",
          created_by: "root",
        },
      ],
    },
    {
      name: "stores a model scope as normalized names",
      sets: [{ provider: "codex", models: ["GPT-5.5"] }],
      heldAs: ["codex", "gpt-5.5"],
      rows: [
        {
          scope: '{"schemaVersion":1,"provider":"codex","model":"gpt-5.5"}',
          origin: "mesh",
          expiry: null,
          reason: "",
          created_by: "root",
        },
      ],
    },
    {
      name: "replaces a provider-wide hold set again instead of stacking another",
      sets: [
        { provider: "kimi", expiry: LATER },
        { provider: "Kimi", reason: "outage", createdBy: "steward" },
      ],
      heldAs: ["kimi", "kimi-k2"],
      rows: [
        {
          scope: '{"schemaVersion":1,"provider":"kimi"}',
          origin: "mesh",
          expiry: null,
          reason: "outage",
          created_by: "steward",
        },
      ],
    },
    {
      name: "replaces a model hold set again under another spelling",
      sets: [
        { provider: " KIMI ", models: ["Kimi-K2"] },
        { provider: "kimi", models: [" kimi-k2 "], reason: "again", createdBy: "steward" },
      ],
      heldAs: ["kimi", "kimi-k2"],
      rows: [
        {
          scope: '{"schemaVersion":1,"provider":"kimi","model":"kimi-k2"}',
          origin: "mesh",
          expiry: null,
          reason: "again",
          created_by: "steward",
        },
      ],
    },
  ])("set() $name, storing one canonical versioned scope", ({ sets, heldAs, rows }) => {
    let stored: ReturnType<typeof holds.set> = [];
    for (const hold of sets)
      stored = holds.set({ origin: "mesh", createdBy: "root", createdAt: CREATED, ...hold });

    expect(
      db.prepare("SELECT scope, origin, expiry, reason, created_by FROM availability_holds").all()
    ).toEqual(rows);
    expect(stored).toEqual(holds.list());
    const [provider, model] = heldAs;
    expect(holds.isHeld(provider ?? "", model, NOW)).toBe(true);
  });

  it("lets provider-wide and model-scoped holds coexist", () => {
    holds.set({
      provider: "kimi",
      origin: "mesh",
      expiry: LATER,
      createdBy: "root",
      createdAt: CREATED,
    });
    holds.set({
      provider: "kimi",
      origin: "mesh",
      models: ["kimi-k2"],
      createdBy: "root",
      createdAt: CREATED,
    });

    expect(holds.list().map((hold) => hold.model ?? "*")).toEqual(["*", "kimi-k2"]);
    // The model hold outlives the bounded provider-wide one.
    expect(holds.isHeld("kimi", "kimi-k2", Date.parse(LATER))).toBe(true);
    expect(holds.isHeld("kimi", "kimi-k3", Date.parse(LATER))).toBe(false);
  });

  it("clears listed models and leaves a provider-wide hold in place", () => {
    holds.set({ provider: "kimi", origin: "mesh", createdBy: "root", createdAt: CREATED });
    holds.set({
      provider: "kimi",
      origin: "mesh",
      models: ["kimi-k2"],
      createdBy: "root",
      createdAt: CREATED,
    });

    expect(holds.clear({ provider: "kimi", models: ["Kimi-K2"] })).toEqual([
      {
        provider: "kimi",
        model: "kimi-k2",
        origin: "mesh",
        reason: "",
        createdBy: "root",
        createdAt: CREATED,
      },
    ]);
    expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(true);
  });

  it("clears every hold on a provider when no models are given", () => {
    holds.set({ provider: "kimi", origin: "mesh", createdBy: "root", createdAt: CREATED });
    holds.set({
      provider: "kimi",
      origin: "mesh",
      models: ["kimi-k2"],
      createdBy: "root",
      createdAt: CREATED,
    });
    holds.set({ provider: "codex", origin: "mesh", createdBy: "root", createdAt: CREATED });

    expect(holds.clear({ provider: "kimi" }).map((hold) => hold.model ?? "*")).toEqual([
      "*",
      "kimi-k2",
    ]);
    expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(false);
    expect(holds.isHeld("codex", "gpt-5.5", NOW)).toBe(true);
    expect(holds.clear({ provider: "kimi" })).toEqual([]);
  });

  it("survives reopening the database", () => {
    const dir = mkdtempSync(join(tmpdir(), "availability-holds-"));
    const file = join(dir, "mesh.db");
    const first = new Database(file);
    runMigrations(first);
    new AvailabilityHoldRepository(first).set({
      provider: "kimi",
      origin: "mesh",
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

  it("refuses to read a stored scope it does not understand", () => {
    const insert = db.prepare(
      `INSERT INTO availability_holds (scope, origin, created_by, created_at)
       VALUES (?, 'mesh', 'root', '${CREATED}')`
    );
    for (const scope of [
      "kimi",
      '{"provider":"kimi"}',
      '{"schemaVersion":2,"provider":"kimi"}',
      '{"schemaVersion":1,"provider":""}',
      '{"schemaVersion":1,"provider":"kimi","model":""}',
      '{"schemaVersion":1,"provider":"kimi","models":["kimi-k2"]}',
      // Valid documents in a form set() never writes: reordered keys, added
      // whitespace and unnormalized names would each slip past the unique
      // index and a byte-matched clear.
      '{"provider":"kimi","model":"kimi-k2","schemaVersion":1}',
      '{ "schemaVersion": 1, "provider": "kimi" }',
      '{"schemaVersion":1,"provider":"Kimi","model":"Kimi-K2"}',
    ]) {
      db.prepare("DELETE FROM availability_holds").run();
      insert.run(scope);
      expect(() => holds.list(), scope).toThrow(/invalid availability hold scope/);
      expect(() => holds.isHeld("kimi", "kimi-k2", NOW), scope).toThrow(
        /invalid availability hold scope/
      );
    }
  });

  it("skips an expired row before reading its scope when checking a lane", () => {
    db.prepare(
      `INSERT INTO availability_holds (scope, origin, expiry, created_by, created_at)
       VALUES ('kimi', 'mesh', ?, 'root', ?)`
    ).run(new Date(NOW - 1).toISOString(), CREATED);
    holds.set({ provider: "codex", origin: "mesh", createdBy: "root", createdAt: CREATED });

    expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(false);
    expect(holds.isHeld("codex", "gpt-5.5", NOW)).toBe(true);
    // An active-only listing skips it the same way; the full listing still
    // reads every row, so the bad one is reported, not hidden.
    expect(holds.list({ now: NOW }).map((hold) => hold.provider)).toEqual(["codex"]);
    expect(() => holds.list()).toThrow(/invalid availability hold scope/);
  });

  it("refuses blank scopes and unparseable timestamps", () => {
    expect(() =>
      holds.set({ provider: " ", origin: "mesh", createdBy: "root", createdAt: CREATED })
    ).toThrow(/requires a provider/);
    expect(() =>
      holds.set({
        provider: "kimi",
        origin: "mesh",
        models: [" "],
        createdBy: "root",
        createdAt: CREATED,
      })
    ).toThrow(/cannot be blank/);
    expect(() =>
      holds.set({
        provider: "kimi",
        origin: "mesh",
        expiry: "soon",
        createdBy: "root",
        createdAt: CREATED,
      })
    ).toThrow(/invalid availability hold expiry/);
    expect(holds.list()).toEqual([]);
  });

  it("refuses an empty model list instead of widening it to the provider", () => {
    expect(() =>
      holds.set({
        provider: "kimi",
        origin: "mesh",
        models: [],
        createdBy: "root",
        createdAt: CREATED,
      })
    ).toThrow(/cannot be blank/);
    expect(holds.list()).toEqual([]);

    holds.set({ provider: "kimi", origin: "mesh", createdBy: "root", createdAt: CREATED });
    holds.set({
      provider: "kimi",
      origin: "mesh",
      models: ["kimi-k2"],
      createdBy: "root",
      createdAt: CREATED,
    });
    expect(() => holds.clear({ provider: "kimi", models: [] })).toThrow(/cannot be blank/);
    expect(holds.list()).toHaveLength(2);
  });

  describe("hold origins (#918 chat vs mesh)", () => {
    const set = (origin: "chat" | "mesh", extra: Record<string, unknown> = {}) =>
      holds.set({
        provider: "kimi",
        origin,
        createdBy: origin === "chat" ? "chat:users/operator" : "root",
        createdAt: CREATED,
        ...extra,
      });

    it.each([
      { name: "mesh hold first, chat hold on the same scope second", first: "mesh" as const },
      { name: "chat hold first, mesh hold on the same scope second", first: "chat" as const },
    ])("keeps both rows of one scope in either write order: $name", ({ first }) => {
      const second = first === "mesh" ? ("chat" as const) : ("mesh" as const);
      set(first);
      set(second);

      // One row per origin: the second write must not relabel the first.
      expect(db.prepare("SELECT origin FROM availability_holds ORDER BY origin").all()).toEqual([
        { origin: "chat" },
        { origin: "mesh" },
      ]);
      // Rows sharing a scope order chat before mesh, whatever the write order.
      expect(holds.list().map((hold) => hold.origin)).toEqual(["chat", "mesh"]);
      expect(holds.clear({ provider: "kimi" }).map((hold) => hold.origin)).toEqual([
        "chat",
        "mesh",
      ]);
    });

    it("replaces only the same origin's row on the same scope", () => {
      set("mesh", { reason: "outage" });
      set("mesh", { reason: "still out" });

      expect(holds.list()).toEqual([
        {
          provider: "kimi",
          origin: "mesh",
          reason: "still out",
          createdBy: "root",
          createdAt: CREATED,
        },
      ]);
    });

    it("refuses an origin outside chat|mesh", () => {
      expect(() =>
        holds.set({
          provider: "kimi",
          origin: "sketchy" as never,
          createdBy: "x",
          createdAt: CREATED,
        })
      ).toThrow(/invalid availability hold origin/);
    });

    it("clear({origin}) deletes one origin's rows and leaves the other in force", () => {
      set("mesh");
      set("chat");

      expect(holds.clear({ provider: "kimi" }, { origin: "chat" })).toEqual([
        {
          provider: "kimi",
          origin: "chat",
          reason: "",
          createdBy: "chat:users/operator",
          createdAt: CREATED,
        },
      ]);
      // The mesh hold is untouched and still governs selection.
      expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(true);
      expect(holds.list().map((hold) => hold.origin)).toEqual(["mesh"]);
    });

    it("clear without an origin removes every origin on the scope (the admin path)", () => {
      set("mesh");
      set("chat");

      expect(holds.clear({ provider: "kimi" })).toHaveLength(2);
      expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(false);
    });

    it("clearAll({ origin }) removes only that origin across every scope", () => {
      set("chat");
      set("chat", { models: ["kimi-k2"] });
      holds.set({
        provider: "codex",
        origin: "chat",
        createdBy: "chat:users/operator",
        createdAt: CREATED,
      });
      holds.set({ provider: "kimi", origin: "mesh", createdBy: "root", createdAt: CREATED });

      const cleared = holds.clearAll({ origin: "chat" });
      expect(cleared.map((hold) => hold.provider).sort()).toEqual(["codex", "kimi", "kimi"]);
      expect(holds.list().map((hold) => `${hold.provider}:${hold.origin}`)).toEqual(["kimi:mesh"]);
      expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(true);
      expect(holds.isHeld("codex", "gpt-5.5", NOW)).toBe(false);
    });

    it("clearAll() without an origin removes every origin across every scope", () => {
      set("chat");
      set("mesh");
      set("mesh", { models: ["kimi-k2"], expiry: LATER });
      holds.set({ provider: "codex", origin: "mesh", createdBy: "root", createdAt: CREATED });

      const cleared = holds.clearAll();
      expect(cleared.map((hold) => `${hold.provider}:${hold.model ?? "*"}:${hold.origin}`)).toEqual(
        ["codex:*:mesh", "kimi:*:chat", "kimi:*:mesh", "kimi:kimi-k2:mesh"]
      );
      expect(holds.list()).toEqual([]);
      expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(false);
    });

    it("keeps expiries independent between the two origins on one scope", () => {
      set("chat", { expiry: LATER });
      set("mesh");

      const chatLapse = Date.parse(LATER) + 1;
      expect(holds.isHeld("kimi", "kimi-k2", chatLapse)).toBe(true);
      expect(holds.list({ now: chatLapse })).toEqual([
        {
          provider: "kimi",
          origin: "mesh",
          reason: "",
          createdBy: "root",
          createdAt: CREATED,
        },
      ]);
    });

    it("holds a model scope through either origin and clears them independently", () => {
      holds.set({
        provider: "kimi",
        origin: "mesh",
        models: ["kimi-k2"],
        createdBy: "root",
        createdAt: CREATED,
      });
      holds.set({
        provider: "kimi",
        origin: "chat",
        models: ["kimi-k2"],
        createdBy: "chat:users/operator",
        createdAt: CREATED,
      });

      expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(true);
      expect(holds.clear({ provider: "kimi", models: ["kimi-k2"] }, { origin: "chat" })).toEqual([
        {
          provider: "kimi",
          model: "kimi-k2",
          origin: "chat",
          reason: "",
          createdBy: "chat:users/operator",
          createdAt: CREATED,
        },
      ]);
      // The mesh model hold survives: provider/model overlap stays held.
      expect(holds.isHeld("kimi", "kimi-k2", NOW)).toBe(true);
    });
  });
});
