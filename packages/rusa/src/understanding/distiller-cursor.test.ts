import type { Goal, SyncClient } from "@thkp-eng/goals-core";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import {
  computeAdvance,
  computeWindow,
  DistillerCursorStore,
  latestOpCreatedAt,
  MESH_EVENTS_AVAILABLE_FROM,
  resolveSeed,
  type SeededState,
  windowIncludesMesh,
} from "./distiller-cursor.js";

const seeded = (over: Partial<SeededState> = {}): SeededState => ({
  lastDistilled: "2026-06-10T00:00:00.000Z",
  consecutiveFailures: 0,
  ...over,
});

describe("computeWindow", () => {
  it("caps the window at lastDistilled + capDays when now is far ahead", () => {
    expect(computeWindow("2026-06-10T00:00:00.000Z", "2026-07-01T00:00:00.000Z", 3)).toMatchObject({
      from: "2026-06-10T00:00:00.000Z",
      to: "2026-06-13T00:00:00.000Z", // from + 3d, not now
    });
  });
  it("uses now when it's within the cap", () => {
    expect(computeWindow("2026-06-10T00:00:00.000Z", "2026-06-11T00:00:00.000Z", 3).to).toBe(
      "2026-06-11T00:00:00.000Z"
    );
  });
  it("flags includesMesh only when the window end is past the mesh-events floor", () => {
    // A purely pre-mesh window (git/gh only).
    expect(
      computeWindow("2026-06-10T00:00:00.000Z", "2026-06-13T00:00:00.000Z", 3).includesMesh
    ).toBe(false);
    // A window reaching into the mesh era.
    expect(
      computeWindow("2026-06-17T00:00:00.000Z", "2026-06-20T00:00:00.000Z", 3).includesMesh
    ).toBe(true);
  });
});

describe("windowIncludesMesh", () => {
  it("is false at/below the floor and true above it", () => {
    expect(windowIncludesMesh(MESH_EVENTS_AVAILABLE_FROM)).toBe(false); // [.., floor) has no mesh
    expect(windowIncludesMesh("2026-06-17T00:00:00.001Z")).toBe(true);
  });
});

describe("latestOpCreatedAt", () => {
  const goal = (logTimes: number[]): Goal =>
    ({
      id: "g",
      text: "g",
      superGoalIds: new Set(),
      subGoalIds: new Set(),
      log: logTimes.map((t) => ({ creationTime: t })),
    }) as unknown as Goal;
  const fake = (goals: Goal[]): SyncClient =>
    ({ getGoals: () => new Map(goals.map((g, i) => [String(i), g])) }) as unknown as SyncClient;

  it("returns the max op creationTime as ISO", () => {
    const ts = Date.parse("2026-05-01T12:00:00.000Z");
    expect(latestOpCreatedAt(fake([goal([1000, ts]), goal([2000])]))).toBe(
      new Date(ts).toISOString()
    );
  });
  it("returns null for an empty graph", () => {
    expect(latestOpCreatedAt(fake([]))).toBeNull();
    expect(latestOpCreatedAt(fake([goal([])]))).toBeNull();
  });
});

describe("resolveSeed (unreachable vs empty — seed-fallback)", () => {
  it("does NOT seed when glass-goals is unreachable (retry next run)", () => {
    expect(resolveSeed(false, null)).toEqual({ seed: null, reason: "glass-goals-unreachable" });
    // Even if a latest somehow came through, not-reachable wins (defensive).
    expect(resolveSeed(false, "2026-05-01T00:00:00.000Z").seed).toBeNull();
  });
  it("seeds at the latest op when reachable with history", () => {
    expect(resolveSeed(true, "2026-05-01T00:00:00.000Z")).toEqual({
      seed: "2026-05-01T00:00:00.000Z",
      reason: "glass-goals-latest-op",
    });
  });
  it("seeds at the mesh floor ONLY when reachable AND genuinely empty", () => {
    expect(resolveSeed(true, null)).toEqual({
      seed: MESH_EVENTS_AVAILABLE_FROM,
      reason: "empty-graph-mesh-floor",
    });
  });
});

describe("computeAdvance", () => {
  it("advances to the window end and resets failures when all sources ok", () => {
    const { state: next, gap } = computeAdvance(
      seeded({ consecutiveFailures: 2 }),
      "2026-06-13T00:00:00.000Z",
      true
    );
    expect(next).toEqual({
      lastDistilled: "2026-06-13T00:00:00.000Z",
      consecutiveFailures: 0,
    });
    expect(gap).toBeUndefined();
  });
  it("holds the cursor and increments on failure (below threshold)", () => {
    const { state: next, gap } = computeAdvance(seeded(), "2026-06-13T00:00:00.000Z", false, 3);
    expect(next.lastDistilled).toBe("2026-06-10T00:00:00.000Z"); // held
    expect(next.consecutiveFailures).toBe(1);
    expect(gap).toBeUndefined();
  });
  it("force-advances past the window with a logged gap at K consecutive failures", () => {
    const { state: next, gap } = computeAdvance(
      seeded({ consecutiveFailures: 2 }),
      "2026-06-13T00:00:00.000Z",
      false,
      3
    );
    expect(next.lastDistilled).toBe("2026-06-13T00:00:00.000Z"); // un-stuck
    expect(next.consecutiveFailures).toBe(0);
    expect(gap).toMatchObject({ from: "2026-06-10T00:00:00.000Z", to: "2026-06-13T00:00:00.000Z" });
  });
});

describe("DistillerCursorStore (understanding_sync_metadata KV)", () => {
  let db: Database.Database;
  let store: DistillerCursorStore;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    store = new DistillerCursorStore(db);
  });

  it("is UNSEEDED by default (lastDistilled null — no hardcoded epoch start)", () => {
    expect(store.getState()).toEqual({ lastDistilled: null, consecutiveFailures: 0 });
  });

  it("seedIfUnset seeds once, then is a no-op", () => {
    expect(store.seedIfUnset("2026-05-01T00:00:00.000Z")).toBe(true);
    expect(store.getState().lastDistilled).toBe("2026-05-01T00:00:00.000Z");
    expect(store.seedIfUnset("2026-06-01T00:00:00.000Z")).toBe(false); // already set
    expect(store.getState().lastDistilled).toBe("2026-05-01T00:00:00.000Z"); // unchanged
  });

  it("persists and reloads state across instances", () => {
    store.setState({
      lastDistilled: "2026-06-22T00:00:00.000Z",
      consecutiveFailures: 2,
    });
    expect(new DistillerCursorStore(db).getState()).toEqual({
      lastDistilled: "2026-06-22T00:00:00.000Z",
      consecutiveFailures: 2,
    });
  });

  it("shares the table with glass-goals sync metadata without collision", () => {
    db.prepare(
      "INSERT OR REPLACE INTO understanding_sync_metadata (key, value) VALUES ('cursor', ?)"
    ).run("hlc-xyz");
    store.seedIfUnset("2026-06-22T00:00:00.000Z");
    const gg = db
      .prepare("SELECT value FROM understanding_sync_metadata WHERE key='cursor'")
      .get() as { value: string };
    expect(gg.value).toBe("hlc-xyz"); // glass-goals' own 'cursor' row untouched
    expect(store.getState().lastDistilled).toBe("2026-06-22T00:00:00.000Z");
  });
});
