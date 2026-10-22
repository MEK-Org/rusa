import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { MetricRepository, type MetricSample } from "./metric-repository.js";

const t0 = Date.parse("2026-10-10T12:00:00.000Z");
const MINUTE = 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("MetricRepository", () => {
  let db: Database.Database;
  let repo: MetricRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    repo = new MetricRepository(db);
  });

  afterEach(() => db.close());

  it("records and reads single metric samples within an inclusive UTC minute range", () => {
    const sample1: MetricSample = {
      metric: "inbox_size_median",
      minute: iso(t0),
      value: 3.5,
      observedAt: iso(t0 + 2000),
    };
    const sample2: MetricSample = {
      metric: "inbox_size_median",
      minute: iso(t0 + MINUTE),
      value: 4.0,
      observedAt: iso(t0 + MINUTE + 1500),
    };

    repo.record(sample1);
    repo.record(sample2);

    const results = repo.read("inbox_size_median", {
      startMinute: iso(t0),
      endMinute: iso(t0 + MINUTE),
    });

    expect(results).toEqual([sample1, sample2]);
  });

  it("distinguishes missing minutes, sampled nulls, and observed zeroes", () => {
    // minute 0: observed zero
    repo.record({
      metric: "inbox_size_median",
      minute: iso(t0),
      value: 0,
      observedAt: iso(t0),
    });
    // minute 1: missing minute (not recorded)
    // minute 2: sampled with zero live actors (value is null)
    repo.record({
      metric: "inbox_size_median",
      minute: iso(t0 + 2 * MINUTE),
      value: null,
      observedAt: iso(t0 + 2 * MINUTE),
    });

    const results = repo.read("inbox_size_median", {
      startMinute: iso(t0),
      endMinute: iso(t0 + 2 * MINUTE),
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      metric: "inbox_size_median",
      minute: iso(t0),
      value: 0,
      observedAt: iso(t0),
    });
    expect(results[1]).toEqual({
      metric: "inbox_size_median",
      minute: iso(t0 + 2 * MINUTE),
      value: null,
      observedAt: iso(t0 + 2 * MINUTE),
    });

    // Checking hasSample
    expect(repo.hasSample(iso(t0))).toBe(true);
    expect(repo.hasSample(iso(t0 + MINUTE))).toBe(false);
    expect(repo.hasSample(iso(t0 + 2 * MINUTE))).toBe(true);
  });

  it("enforces primary key on (metric, minute)", () => {
    repo.record({
      metric: "actor_count",
      minute: iso(t0),
      value: 2,
      observedAt: iso(t0),
    });

    expect(() => {
      repo.record({
        metric: "actor_count",
        minute: iso(t0),
        value: 3,
        observedAt: iso(t0 + 1000),
      });
    }).toThrow();
  });

  it("records batches atomically and reads multiple metrics ordered by minute", () => {
    const batch: MetricSample[] = [
      { metric: "actor_count", minute: iso(t0), value: 5, observedAt: iso(t0) },
      { metric: "inbox_size_median", minute: iso(t0), value: 2.5, observedAt: iso(t0) },
      { metric: "inbox_size_max", minute: iso(t0), value: 10, observedAt: iso(t0) },
      { metric: "actor_count", minute: iso(t0 + MINUTE), value: 5, observedAt: iso(t0 + MINUTE) },
      {
        metric: "inbox_size_median",
        minute: iso(t0 + MINUTE),
        value: 3.0,
        observedAt: iso(t0 + MINUTE),
      },
      {
        metric: "inbox_size_max",
        minute: iso(t0 + MINUTE),
        value: 12,
        observedAt: iso(t0 + MINUTE),
      },
    ];

    repo.recordMany(batch);

    const rows = repo.readMany(["actor_count", "inbox_size_median"], {
      startMinute: iso(t0),
      endMinute: iso(t0 + MINUTE),
    });

    expect(rows).toEqual([
      { metric: "actor_count", minute: iso(t0), value: 5, observedAt: iso(t0) },
      { metric: "inbox_size_median", minute: iso(t0), value: 2.5, observedAt: iso(t0) },
      { metric: "actor_count", minute: iso(t0 + MINUTE), value: 5, observedAt: iso(t0 + MINUTE) },
      {
        metric: "inbox_size_median",
        minute: iso(t0 + MINUTE),
        value: 3.0,
        observedAt: iso(t0 + MINUTE),
      },
    ]);
  });

  it("prunes samples before a given minute threshold", () => {
    for (let i = 0; i < 5; i++) {
      repo.record({
        metric: "actor_count",
        minute: iso(t0 + i * MINUTE),
        value: i,
        observedAt: iso(t0 + i * MINUTE),
      });
    }

    // Prune before minute 2
    const deleted = repo.prune(iso(t0 + 2 * MINUTE));
    expect(deleted).toBe(2);

    const remaining = repo.read("actor_count", {
      startMinute: iso(t0),
      endMinute: iso(t0 + 10 * MINUTE),
    });
    expect(remaining.map((r: MetricSample) => r.minute)).toEqual([
      iso(t0 + 2 * MINUTE),
      iso(t0 + 3 * MINUTE),
      iso(t0 + 4 * MINUTE),
    ]);
  });
});
