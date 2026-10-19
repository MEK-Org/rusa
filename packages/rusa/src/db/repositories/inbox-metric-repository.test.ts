import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INBOX_METRIC_INTERVAL_MS,
  INBOX_METRIC_MAX_POINTS,
  INBOX_METRIC_WINDOW_MS,
} from "../../dashboard/inbox-metrics.js";
import { runMigrations } from "../migrations/runner.js";
import { InboxMetricRepository } from "./inbox-metric-repository.js";
import { SqliteInboxRepository } from "./sqlite-inbox-repository.js";

const MINUTE = INBOX_METRIC_INTERVAL_MS;
const t0 = Date.parse("2026-10-10T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("#1018 inbox metric snapshots", () => {
  let db: Database.Database;
  let inbox: SqliteInboxRepository;
  let metrics: InboxMetricRepository;

  function addActor(id: string, retiredAt: number | null = null): void {
    db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at, retired_at) VALUES (?, 'fixture', NULL, ?, ?)"
    ).run(id, iso(t0 - 60 * MINUTE), retiredAt === null ? null : iso(retiredAt));
  }

  function deliver(actorId: string, deliveredAtMs: number): string {
    const [entry] = inbox.append([
      {
        actorId,
        source: "mesh:fixture",
        deliveredAt: new Date(deliveredAtMs),
        payload: { type: "mesh.message", messageId: `m-${deliveredAtMs}`, fromId: "fixture" },
      },
    ]);
    if (!entry) throw new Error("fixture delivery was not appended");
    return entry.id;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    inbox = new SqliteInboxRepository(db);
    metrics = new InboxMetricRepository(db);
  });
  afterEach(() => db.close());

  it("summarizes live actors with known-empty inboxes as zero size and zero age", () => {
    // Only one actor may lack a parent, so the fixture root is the empty inbox.
    addActor("empty");
    db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('busy', 'fixture', 'empty', ?), ('older', 'fixture', 'empty', ?), ('one', 'fixture', 'empty', ?)"
    ).run(iso(t0), iso(t0), iso(t0));
    deliver("busy", t0 - 4 * MINUTE);
    deliver("busy", t0 - 1 * MINUTE);
    deliver("older", t0 - 10 * MINUTE);
    for (let i = 0; i < 5; i++) deliver("older", t0 - 2 * MINUTE);
    deliver("one", t0 - 2 * MINUTE);

    const point = metrics.sampleIfDue(t0 + 5_000);
    // Sizes 0, 2, 6, 1 → median 1.5; ages 0, 245, 605, 125 seconds → median 185.
    expect(point).toEqual({
      minute: iso(t0),
      observedAt: iso(t0 + 5_000),
      actorCount: 4,
      inboxSizeMedian: 1.5,
      inboxSizeMax: 6,
      oldestAgeSecondsMedian: 185,
      oldestAgeSecondsMax: 605,
    });
  });

  it("samples a minute once and keeps seen entries counted until handled", () => {
    addActor("a");
    const first = deliver("a", t0 - 3 * MINUTE);
    const second = deliver("a", t0 - 1 * MINUTE);
    inbox.markSeen("a", new Date(t0 - 30_000));

    expect(metrics.sampleIfDue(t0)).toMatchObject({ inboxSizeMax: 2, oldestAgeSecondsMax: 180 });
    // A second tick in the same minute keeps the first reading.
    inbox.markHandled("a", [first], new Date(t0 + 10_000));
    expect(metrics.sampleIfDue(t0 + 20_000)).toBeNull();

    // Handling the oldest entry moves age to the next-oldest delivery.
    expect(metrics.sampleIfDue(t0 + MINUTE)).toMatchObject({
      inboxSizeMax: 1,
      oldestAgeSecondsMax: 120,
    });
    inbox.markHandled("a", [second], new Date(t0 + MINUTE + 10_000));
    deliver("a", t0 + 2 * MINUTE - 15_000);
    expect(metrics.sampleIfDue(t0 + 2 * MINUTE)).toMatchObject({
      inboxSizeMax: 1,
      oldestAgeSecondsMax: 15,
    });
  });

  it("drops retired actors from the population from the minute they retire", () => {
    addActor("root");
    db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('worker', 'fixture', 'root', ?)"
    ).run(iso(t0));
    deliver("worker", t0 - 9 * MINUTE);

    expect(metrics.sampleIfDue(t0)).toMatchObject({ actorCount: 2, inboxSizeMax: 1 });
    db.prepare("UPDATE actors SET retired_at = ? WHERE id = 'worker'").run(iso(t0 + 30_000));
    expect(metrics.sampleIfDue(t0 + MINUTE)).toMatchObject({
      actorCount: 1,
      inboxSizeMedian: 0,
      inboxSizeMax: 0,
      oldestAgeSecondsMax: 0,
    });
  });

  it("records a zero-actor minute distinctly from a missing minute", () => {
    expect(metrics.sampleIfDue(t0)).toEqual({
      minute: iso(t0),
      observedAt: iso(t0),
      actorCount: 0,
      inboxSizeMedian: null,
      inboxSizeMax: null,
      oldestAgeSecondsMedian: null,
      oldestAgeSecondsMax: null,
    });
    // t0+1 minute is never sampled (an offline host): it stays absent.
    metrics.sampleIfDue(t0 + 2 * MINUTE);
    expect(metrics.window(t0 + 2 * MINUTE).points.map((p) => p.minute)).toEqual([
      iso(t0),
      iso(t0 + 2 * MINUTE),
    ]);
  });

  it("returns at most 4,321 exactly spaced minutes and prunes older samples", () => {
    addActor("a");
    const end = t0 + INBOX_METRIC_WINDOW_MS;
    // One extra minute before the window: it must be pruned and never served.
    for (let ms = t0 - MINUTE; ms <= end; ms += MINUTE) metrics.sampleIfDue(ms + 1_000);

    const window = metrics.window(end + 59_000);
    expect(window.windowStart).toBe(iso(t0));
    expect(window.windowEnd).toBe(iso(end));
    expect(window.intervalSeconds).toBe(60);
    expect(window.points).toHaveLength(INBOX_METRIC_MAX_POINTS);
    expect(INBOX_METRIC_MAX_POINTS).toBe(4_321);
    const minutes = window.points.map((point) => Date.parse(point.minute));
    expect(minutes[0]).toBe(t0);
    expect(minutes.at(-1)).toBe(end);
    expect(minutes.slice(1).every((ms, i) => ms - (minutes[i] ?? Number.NaN) === MINUTE)).toBe(
      true
    );
    expect(
      (db.prepare("SELECT count(*) AS n FROM inbox_metric_snapshots").get() as { n: number }).n
    ).toBe(INBOX_METRIC_MAX_POINTS);

    // A minute later the oldest position leaves the window and storage alike.
    metrics.sampleIfDue(end + MINUTE);
    expect(
      (db.prepare("SELECT min(minute) AS m FROM inbox_metric_snapshots").get() as { m: string }).m
    ).toBe(iso(t0 + MINUTE));
  });

  it("reads the window by primary-key range rather than scanning the table", () => {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM inbox_metric_snapshots WHERE minute >= ? AND minute <= ? ORDER BY minute"
      )
      .all(iso(t0), iso(t0 + INBOX_METRIC_WINDOW_MS)) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n")).toMatch(
      /SEARCH inbox_metric_snapshots USING INDEX sqlite_autoindex_inbox_metric_snapshots_1 \(minute>\? AND minute<\?\)/
    );
  });
});
