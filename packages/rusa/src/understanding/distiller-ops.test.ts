import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { DistillerCursorStore } from "./distiller-cursor.js";
import {
  distillAdvance,
  distillGate,
  distillSeed,
  distillWindow,
  SUBSTANTIVE_EVENT_KINDS,
} from "./distiller-ops.js";

const SEED = "2026-06-10T00:00:00.000Z";

describe("distill CLI core", () => {
  let store: DistillerCursorStore;
  beforeEach(() => {
    const db = new Database(":memory:");
    runMigrations(db);
    store = new DistillerCursorStore(db);
  });

  it("seed: sets the cursor once from the given ISO, then is a no-op", () => {
    expect(distillSeed(store, SEED)).toEqual({ seeded: true, cursor: SEED });
    expect(distillSeed(store, "2026-06-20T00:00:00.000Z")).toEqual({ seeded: false, cursor: SEED });
  });

  it("window: throws until seeded, then caps the walk-forward window + flags mesh", () => {
    expect(() => distillWindow(store, "2026-07-01T00:00:00.000Z", 3)).toThrow(/not seeded/);
    distillSeed(store, SEED);
    expect(distillWindow(store, "2026-07-01T00:00:00.000Z", 3)).toEqual({
      from: SEED,
      to: "2026-06-13T00:00:00.000Z",
      includesMesh: false, // pre-mesh window → git/gh only
    });
  });

  it("advance --ok: moves the cursor to the window end and persists", () => {
    distillSeed(store, SEED);
    const out = distillAdvance(store, "2026-06-13T00:00:00.000Z", true);
    expect(out).toEqual({
      lastDistilled: "2026-06-13T00:00:00.000Z",
      consecutiveFailures: 0,
      gap: null,
    });
    expect(store.getState().lastDistilled).toBe("2026-06-13T00:00:00.000Z");
  });

  it("advance on failure: holds the cursor and counts up (no gap below K)", () => {
    distillSeed(store, SEED);
    const out = distillAdvance(store, "2026-06-13T00:00:00.000Z", false);
    expect(out.lastDistilled).toBe(SEED); // held
    expect(out.consecutiveFailures).toBe(1);
    expect(out.gap).toBeNull();
  });

  it("advance: throws until seeded, and refuses to move backward", () => {
    expect(() => distillAdvance(store, SEED, true)).toThrow(/not seeded/);
    distillSeed(store, "2026-06-25T00:00:00.000Z");
    expect(() => distillAdvance(store, "2026-06-20T00:00:00.000Z", true)).toThrow(/backward/);
  });
});

describe("distill gate (day-activity)", () => {
  const NOW = "2026-06-30T00:00:00.000Z";
  let store: DistillerCursorStore;

  beforeEach(() => {
    const db = new Database(":memory:");
    runMigrations(db);
    store = new DistillerCursorStore(db);
  });

  it("throws until the cursor is seeded", () => {
    expect(() => distillGate(store, NOW, () => 0)).toThrow(/not seeded/);
  });

  it("active:false when there is no substantive activity since lastDistilled", () => {
    distillSeed(store, SEED);
    expect(distillGate(store, NOW, () => 0)).toEqual({
      active: false,
      since: SEED,
      until: NOW,
      count: 0,
    });
  });

  it("active:true when the window has substantive activity", () => {
    distillSeed(store, SEED);
    expect(distillGate(store, NOW, () => 3)).toEqual({
      active: true,
      since: SEED,
      until: NOW,
      count: 3,
    });
  });

  it("counts over the FULL [lastDistilled, now) window (not the capped scan window)", () => {
    distillSeed(store, SEED);
    const seen: Array<[string, string]> = [];
    distillGate(store, NOW, (since, until) => {
      seen.push([since, until]);
      return 0;
    });
    expect(seen).toEqual([[SEED, NOW]]); // since = lastDistilled, until = now (uncapped)
  });

  // Integration: the real repo + SUBSTANTIVE_EVENT_KINDS, proving the predicate.
  describe("with the real mesh-event repository", () => {
    let db: Database.Database;
    let events: MeshEventRepository;

    beforeEach(() => {
      db = new Database(":memory:");
      runMigrations(db);
      store = new DistillerCursorStore(db);
      events = new MeshEventRepository(db);
      distillSeed(store, SEED);
    });

    const gate = () =>
      distillGate(store, NOW, (since, until) =>
        events.countEventsSince(since, SUBSTANTIVE_EVENT_KINDS, until)
      );

    it("a single message_sent in-window flips the gate active", () => {
      events.record({
        kind: "message_sent",
        actorId: "a",
        ts: "2026-06-20T00:00:00.000Z",
      });
      expect(gate().active).toBe(true);
    });

    it("heartbeat/lifecycle events alone do NOT activate the gate (self-bootstrap dodge)", () => {
      // Exactly what the distiller's own nightly wake writes — must not self-trigger.
      events.record({
        kind: "scheduled_wake",
        actorId: "23497ada",
        ts: "2026-06-20T00:00:01.000Z",
      });
      events.record({ kind: "run_start", actorId: "23497ada", ts: "2026-06-20T00:00:02.000Z" });
      events.record({
        kind: "run_end",
        actorId: "23497ada",
        success: true,
        ts: "2026-06-20T00:00:03.000Z",
      });
      events.record({ kind: "run_continued", actorId: "23497ada", ts: "2026-06-20T00:00:04.000Z" });
      events.record({ kind: "run_yielded", actorId: "23497ada", ts: "2026-06-20T00:00:05.000Z" });
      const out = gate();
      expect(out.active).toBe(false);
      expect(out.count).toBe(0);
    });

    it("ignores activity outside the window (before lastDistilled / at-or-after now)", () => {
      events.record({ kind: "message_sent", actorId: "a", ts: "2026-06-01T00:00:00.000Z" }); // before SEED
      events.record({ kind: "message_sent", actorId: "a", ts: NOW }); // until is exclusive
      expect(gate().active).toBe(false);
    });

    it("counts structural events (actor_spawned, capability_granted) as substantive", () => {
      events.record({ kind: "actor_spawned", actorId: "child", ts: "2026-06-18T00:00:00.000Z" });
      events.record({
        kind: "capability_granted",
        actorId: "child",
        ts: "2026-06-19T00:00:00.000Z",
      });
      expect(gate().count).toBe(2);
    });
  });
});
