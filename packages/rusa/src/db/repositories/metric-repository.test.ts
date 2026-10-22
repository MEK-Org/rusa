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

  it("distinguishes missing minutes, sampled nulls, and observed zeroes", () => {
    // minute 0: observed zero
    // minute 1: missing minute (not recorded)
    // minute 2: sampled with zero live actors (value is null)
    repo.recordMany([
      {
        metric: "inbox_size_median",
        minute: iso(t0),
        value: 0,
        observedAt: iso(t0),
      },
      {
        metric: "inbox_size_median",
        minute: iso(t0 + 2 * MINUTE),
        value: null,
        observedAt: iso(t0 + 2 * MINUTE),
      },
    ]);

    const results = repo.readMany(["inbox_size_median"], {
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

    // Checking hasSample per metric
    expect(repo.hasSample(iso(t0), "inbox_size_median")).toBe(true);
    expect(repo.hasSample(iso(t0 + MINUTE), "inbox_size_median")).toBe(false);
    expect(repo.hasSample(iso(t0 + 2 * MINUTE), "inbox_size_median")).toBe(true);
    expect(repo.hasSample(iso(t0), "actor_count")).toBe(false);
  });

  it("enforces primary key on (metric, minute)", () => {
    repo.recordMany([
      {
        metric: "actor_count",
        minute: iso(t0),
        value: 2,
        observedAt: iso(t0),
      },
    ]);

    expect(() => {
      repo.recordMany([
        {
          metric: "actor_count",
          minute: iso(t0),
          value: 3,
          observedAt: iso(t0 + 1000),
        },
      ]);
    }).toThrow();
  });

  it("rolls back batch insertions atomically if any sample in the batch fails", () => {
    repo.recordMany([{ metric: "actor_count", minute: iso(t0), value: 1, observedAt: iso(t0) }]);

    // Batch where second item collides with the pre-existing row
    const failingBatch: MetricSample[] = [
      { metric: "actor_count", minute: iso(t0 + MINUTE), value: 2, observedAt: iso(t0 + MINUTE) },
      { metric: "actor_count", minute: iso(t0), value: 3, observedAt: iso(t0) }, // Duplicate PK
    ];

    expect(() => repo.recordMany(failingBatch)).toThrow();

    // The first item in failingBatch must have been rolled back
    expect(repo.hasSample(iso(t0 + MINUTE), "actor_count")).toBe(false);
    const rows = repo.readMany(["actor_count"], {
      startMinute: iso(t0),
      endMinute: iso(t0 + MINUTE),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(1);
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

  it("prunes samples before a given minute threshold scoped to metric names", () => {
    const samples: MetricSample[] = [];
    for (let i = 0; i < 5; i++) {
      samples.push({
        metric: "actor_count",
        minute: iso(t0 + i * MINUTE),
        value: i,
        observedAt: iso(t0 + i * MINUTE),
      });
      samples.push({
        metric: "unrelated_metric",
        minute: iso(t0 + i * MINUTE),
        value: i * 10,
        observedAt: iso(t0 + i * MINUTE),
      });
    }
    repo.recordMany(samples);

    // Prune before minute 2 scoped only to actor_count
    const deleted = repo.prune(iso(t0 + 2 * MINUTE), ["actor_count"]);
    expect(deleted).toBe(2);

    const remainingActorCount = repo.readMany(["actor_count"], {
      startMinute: iso(t0),
      endMinute: iso(t0 + 10 * MINUTE),
    });
    expect(remainingActorCount.map((r: MetricSample) => r.minute)).toEqual([
      iso(t0 + 2 * MINUTE),
      iso(t0 + 3 * MINUTE),
      iso(t0 + 4 * MINUTE),
    ]);

    // unrelated_metric rows before minute 2 must be preserved
    const remainingUnrelated = repo.readMany(["unrelated_metric"], {
      startMinute: iso(t0),
      endMinute: iso(t0 + 10 * MINUTE),
    });
    expect(remainingUnrelated).toHaveLength(5);
  });

  it("does not delete any samples when given an empty metric list", () => {
    repo.recordMany([
      {
        metric: "unrelated_metric",
        minute: iso(t0),
        value: 9,
        observedAt: iso(t0),
      },
    ]);

    expect(repo.prune(iso(t0 + MINUTE), [])).toBe(0);
    expect(
      repo.readMany(["unrelated_metric"], {
        startMinute: iso(t0),
        endMinute: iso(t0),
      })
    ).toHaveLength(1);
  });
});
