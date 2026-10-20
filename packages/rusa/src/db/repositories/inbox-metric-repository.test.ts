import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INBOX_METRIC_INTERVAL_MS,
  INBOX_METRIC_MAX_POINTS,
  INBOX_METRIC_WINDOW_MS,
} from "../../dashboard/inbox-metrics.js";
import type { InboxPayload } from "../../repositories/inbox-repository.js";
import { runMigrations } from "../migrations/runner.js";
import type { InboxMetricRepository } from "./inbox-metric-repository.js";
import { Repositories } from "./index.js";
import type { MeshChatRepository } from "./mesh-chat-repository.js";
import type { PrincipalRepository } from "./principal-repository.js";
import { SqliteInboxRepository } from "./sqlite-inbox-repository.js";

const MINUTE = INBOX_METRIC_INTERVAL_MS;
const t0 = Date.parse("2026-10-10T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("#1018 inbox metric snapshots", () => {
  let db: Database.Database;
  let inbox: SqliteInboxRepository;
  let metrics: InboxMetricRepository;
  let meshChat: MeshChatRepository;
  let principals: PrincipalRepository;

  /** Only one actor may lack a parent; every actor also has its principal. */
  function addActor(id: string, parentId: string | null = null): void {
    db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'fixture', ?, ?)"
    ).run(id, parentId, iso(t0 - 60 * MINUTE));
    principals.ensureActorPrincipal(id, iso(t0 - 60 * MINUTE));
  }

  function append(
    actorId: string,
    deliveredAtMs: number,
    source: string,
    payload: InboxPayload
  ): string {
    const [entry] = inbox.append([
      { actorId, source, deliveredAt: new Date(deliveredAtMs), payload },
    ]);
    if (!entry) throw new Error("fixture delivery was not appended");
    return entry.id;
  }

  /** A message from another actor: shared mesh traffic every viewer may see. */
  function deliver(actorId: string, deliveredAtMs: number): string {
    const messageId = meshChat.record({
      ts: iso(deliveredAtMs),
      senderId: "peer",
      recipientId: actorId,
      body: "fixture",
    });
    return append(actorId, deliveredAtMs, "mesh:peer", {
      type: "mesh.message",
      messageId,
      fromId: "peer",
    });
  }

  /** A human's chat message: private to that human's conversation (#590). */
  function deliverFromHuman(actorId: string, deliveredAtMs: number, userId: string): string {
    const messageId = meshChat.record({
      ts: iso(deliveredAtMs),
      senderId: userId,
      recipientId: actorId,
      body: "private",
    });
    return append(actorId, deliveredAtMs, `mesh:${userId}`, {
      type: "mesh.message",
      messageId,
      fromId: userId,
    });
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const repos = new Repositories(db);
    inbox = new SqliteInboxRepository(db);
    metrics = repos.inboxMetrics;
    meshChat = repos.meshChat;
    principals = repos.principals;
    principals.ensureActorPrincipal("peer", iso(t0 - 60 * MINUTE));
  });
  afterEach(() => db.close());

  it("summarizes live actors with known-empty inboxes as zero size and zero age", () => {
    addActor("empty");
    for (const id of ["busy", "older", "one"]) addActor(id, "empty");
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

  it("leaves human-chat messages out of every size and age, before the sample is stored", () => {
    const user = principals.createUser({ email: "a@example.test", createdAt: iso(t0) });
    addActor("root");
    for (const id of ["mixed", "only-human", "legacy"]) addActor(id, "root");
    deliver("mixed", t0 - 4 * MINUTE);
    deliver("legacy", t0 - 2 * MINUTE);
    const at = (minutes: number) => t0 + minutes * MINUTE;
    // The shared entries alone, `minutes` after t0: sizes 0, 1, 0, 1 and ages
    // 0, 240 + 60m, 0, 120 + 60m seconds.
    const sharedOnly = (minutes: number) => ({
      actorCount: 4,
      inboxSizeMedian: 0.5,
      inboxSizeMax: 1,
      oldestAgeSecondsMedian: (120 + 60 * minutes) / 2,
      oldestAgeSecondsMax: 240 + 60 * minutes,
    });
    expect(metrics.sampleIfDue(at(0))).toMatchObject(sharedOnly(0));

    // Adding: each hidden message is older than anything shared in its inbox.
    const hidden = [
      deliverFromHuman("mixed", t0 - 50 * MINUTE, user.id),
      deliverFromHuman("only-human", t0 - 40 * MINUTE, user.id),
      // A legacy pointer whose canonical message is gone: its sender hint decides.
      append("legacy", t0 - 30 * MINUTE, `mesh:${user.id}`, {
        type: "mesh.message",
        messageId: "missing",
      }),
    ];
    expect(metrics.sampleIfDue(at(1))).toMatchObject(sharedOnly(1));

    // Changing: seeing them moves nothing.
    for (const id of ["mixed", "only-human", "legacy"])
      inbox.markSeen(id, new Date(at(1) + 10_000));
    expect(metrics.sampleIfDue(at(2))).toMatchObject(sharedOnly(2));

    // Removing: neither does handling them.
    const [mixed, onlyHuman, legacy] = hidden as [string, string, string];
    inbox.markHandled("mixed", [mixed], new Date(at(2) + 10_000));
    inbox.markHandled("only-human", [onlyHuman], new Date(at(2) + 10_000));
    inbox.markHandled("legacy", [legacy], new Date(at(2) + 10_000));
    expect(metrics.sampleIfDue(at(3))).toMatchObject(sharedOnly(3));

    // An older actor-to-actor message does count: sizes 0, 1, 1, 1 and ages
    // 0, 480, 1440, 360.
    deliver("only-human", t0 - 20 * MINUTE);
    expect(metrics.sampleIfDue(at(4))).toMatchObject({
      inboxSizeMedian: 1,
      inboxSizeMax: 1,
      oldestAgeSecondsMedian: 420,
      oldestAgeSecondsMax: 1440,
    });
    const stored = db
      .prepare(
        "SELECT inbox_size_median, oldest_age_seconds_max FROM inbox_metric_snapshots ORDER BY minute"
      )
      .all() as Array<{ inbox_size_median: number; oldest_age_seconds_max: number }>;
    expect(stored.map((row) => row.inbox_size_median)).toEqual([0.5, 0.5, 0.5, 0.5, 1]);
    expect(stored.map((row) => row.oldest_age_seconds_max)).toEqual([240, 300, 360, 420, 1440]);
  });

  it("counts an actor holding only human-chat messages as zero size and zero age", () => {
    const user = principals.createUser({ email: "a@example.test", createdAt: iso(t0) });
    addActor("root");
    addActor("worker", "root");
    deliverFromHuman("root", t0 - 5 * MINUTE, user.id);
    deliverFromHuman("worker", t0 - 9 * MINUTE, user.id);

    // Live actors with no shared entry are observed zeros, not a missing population.
    expect(metrics.sampleIfDue(t0)).toEqual({
      minute: iso(t0),
      observedAt: iso(t0),
      actorCount: 2,
      inboxSizeMedian: 0,
      inboxSizeMax: 0,
      oldestAgeSecondsMedian: 0,
      oldestAgeSecondsMax: 0,
    });
  });

  it("drops retired actors from the population from the minute they retire", () => {
    addActor("root");
    addActor("worker", "root");
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
