// @vitest-environment node
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import {
  DASHBOARD_TIMING_EVENT_KIND,
  DASHBOARD_TIMING_MAX_QUEUE,
  DASHBOARD_TIMING_PRUNE_INTERVAL_MS,
  DashboardTimingRecorder,
  parseDashboardClientTiming,
} from "./timing.js";

describe("dashboard timing recorder", () => {
  let db: Database.Database;
  let events: MeshEventRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    events = new MeshEventRepository(db);
  });

  afterEach(() => db.close());

  const timingRows = () =>
    events.listByKindSince(DASHBOARD_TIMING_EVENT_KIND, "2026-09-01T00:00:00.000Z", 30_000);

  it("accepts only the bounded content-free client envelope", () => {
    const id = randomUUID();
    expect(
      parseDashboardClientTiming({
        interaction: "initial_load",
        durationMs: 123,
        requestIds: [id],
        requestTimings: [{ requestId: id, requestMs: 45 }],
        outcome: "success",
      })
    ).toEqual({
      interaction: "initial_load",
      durationMs: 123,
      requestIds: [id],
      requestTimings: [{ requestId: id, requestMs: 45 }],
      outcome: "success",
    });
    expect(
      parseDashboardClientTiming({
        interaction: "initial_load",
        durationMs: 123,
        requestIds: [id],
        url: "/api/mesh/threads?private=value",
      })
    ).toBeNull();
    expect(
      parseDashboardClientTiming({ interaction: "free-text", durationMs: 1, requestIds: [] })
    ).toBeNull();
    expect(
      parseDashboardClientTiming({
        interaction: "initial_load",
        durationMs: 1,
        requestIds: [id],
        requestTimings: [{ requestId: randomUUID(), requestMs: 1 }],
      })
    ).toBeNull();
    expect(
      parseDashboardClientTiming({
        interaction: "initial_load",
        durationMs: 1,
        requestIds: [id],
        requestTimings: [
          { requestId: id, requestMs: 1 },
          { requestId: id, requestMs: 2 },
        ],
      })
    ).toBeNull();
    expect(
      parseDashboardClientTiming({
        interaction: "initial_load",
        durationMs: 1,
        requestIds: [id],
        requestTimings: [{ requestId: id, requestMs: 1.5 }],
      })
    ).toBeNull();
  });

  it("uses unfiltered server request IDs for a filtered client coverage result", () => {
    const recorder = new DashboardTimingRecorder(
      events,
      () => new Date("2026-10-05T12:00:00.000Z")
    );
    const requestId = randomUUID();
    for (let index = 0; index < 20; index += 1) {
      recorder.recordServer({
        label: "mesh_threads",
        requestId: index === 0 ? requestId : randomUUID(),
        durationMs: 600,
        status: 200,
        bytes: 42,
      });
    }
    recorder.recordClient({
      interaction: "initial_load",
      durationMs: 2200,
      requestIds: [requestId],
      requestTimings: [{ requestId, requestMs: 2100 }],
      outcome: "success",
    });
    while (timingRows().length < 21) recorder.flush();

    const summary = recorder.summary({
      since: new Date("2026-10-05T11:00:00.000Z"),
      label: "initial_load",
    });
    expect(summary.requestCoverage).toEqual({
      correlation: { numerator: 1, denominator: 1, state: "full" },
      measurement: { numerator: 1, denominator: 1, state: "full" },
    });
    expect(summary.pairedRequestDurations).toEqual([
      {
        interaction: "initial_load",
        serverLabel: "mesh_threads",
        sampleCount: 1,
        clientRequestMs: { p50Ms: 2100, p95Ms: 2100, p99Ms: 2100, maxMs: 2100 },
        serverDurationMs: { p50Ms: 600, p95Ms: 600, p99Ms: 600, maxMs: 600 },
      },
    ]);
    expect(summary.groups).toEqual([
      expect.objectContaining({
        source: "client",
        label: "initial_load",
        count: 1,
        p95Ms: 2200,
        statusBuckets: {},
        outcomeBuckets: { success: 1, failure: 0 },
      }),
    ]);
    expect(JSON.stringify(summary)).not.toContain(requestId);
  });

  it("keeps legacy, missing, duplicate and parallel request IDs honest in paired coverage", () => {
    const recorder = new DashboardTimingRecorder(
      events,
      () => new Date("2026-10-05T12:00:00.000Z")
    );
    const paired = randomUUID();
    const legacy = randomUUID();
    const missing = randomUUID();
    const duplicate = randomUUID();
    const parallel = randomUUID();
    for (const [requestId, durationMs] of [
      [paired, 40],
      [legacy, 50],
      [duplicate, 60],
      [duplicate, 61],
      [parallel, 70],
    ] as const) {
      recorder.recordServer({
        label: "mesh_threads",
        requestId,
        durationMs,
        status: 200,
        bytes: 1,
      });
    }
    recorder.recordClient({
      interaction: "initial_load",
      durationMs: 250,
      requestIds: [paired, legacy, missing, duplicate, parallel],
      requestTimings: [
        { requestId: paired, requestMs: 80 },
        { requestId: duplicate, requestMs: 90 },
        { requestId: parallel, requestMs: 100 },
      ],
      outcome: "success",
    });
    while (timingRows().length < 6) recorder.flush();

    const summary = recorder.summary({
      since: new Date("2026-10-05T11:00:00.000Z"),
      label: "initial_load",
    });
    expect(summary.requestCoverage).toEqual({
      correlation: { numerator: 3, denominator: 5, state: "partial" },
      measurement: { numerator: 2, denominator: 5, state: "partial" },
    });
    expect(summary.pairedRequestDurations).toEqual([
      {
        interaction: "initial_load",
        serverLabel: "mesh_threads",
        sampleCount: 2,
        clientRequestMs: { p50Ms: 80, p95Ms: 100, p99Ms: 100, maxMs: 100 },
        serverDurationMs: { p50Ms: 40, p95Ms: 70, p99Ms: 70, maxMs: 70 },
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain(paired);
    expect(JSON.stringify(summary)).not.toContain(legacy);
    expect(JSON.stringify(summary)).not.toContain(duplicate);
  });

  it("groups exact pairs by fixed interaction and server endpoint", () => {
    const recorder = new DashboardTimingRecorder(events);
    const threadId = randomUUID();
    const eventId = randomUUID();
    recorder.recordServer({
      label: "mesh_threads",
      requestId: threadId,
      durationMs: 40,
      status: 200,
      bytes: 1,
    });
    recorder.recordServer({
      label: "mesh_events",
      requestId: eventId,
      durationMs: 60,
      status: 200,
      bytes: 1,
    });
    recorder.recordClient({
      interaction: "initial_load",
      durationMs: 100,
      requestIds: [threadId],
      requestTimings: [{ requestId: threadId, requestMs: 80 }],
      outcome: "success",
    });
    recorder.recordClient({
      interaction: "actor_detail",
      durationMs: 120,
      requestIds: [eventId],
      requestTimings: [{ requestId: eventId, requestMs: 90 }],
      outcome: "success",
    });
    while (timingRows().length < 4) recorder.flush();

    expect(
      recorder.summary({ since: new Date("2026-10-05T11:00:00.000Z") }).pairedRequestDurations
    ).toEqual([
      expect.objectContaining({ interaction: "actor_detail", serverLabel: "mesh_events" }),
      expect.objectContaining({ interaction: "initial_load", serverLabel: "mesh_threads" }),
    ]);
  });

  it("reports missing and no-referenced-request coverage separately", () => {
    const recorder = new DashboardTimingRecorder(events);
    recorder.recordClient({
      interaction: "actor_detail",
      durationMs: 20,
      requestIds: [randomUUID()],
      outcome: "failure",
    });
    recorder.recordClient({
      interaction: "obligation_detail",
      durationMs: 20,
      requestIds: [],
      outcome: "failure",
    });
    while (timingRows().length < 2) recorder.flush();

    expect(
      recorder.summary({
        since: new Date(Date.now() - 60_000),
        label: "actor_detail",
      }).requestCoverage
    ).toEqual({
      correlation: { numerator: 0, denominator: 1, state: "missing" },
      measurement: { numerator: 0, denominator: 1, state: "missing" },
    });
    expect(
      recorder.summary({
        since: new Date(Date.now() - 60_000),
        label: "obligation_detail",
      }).requestCoverage
    ).toEqual({
      correlation: { numerator: 0, denominator: 0, state: "no-referenced-request" },
      measurement: { numerator: 0, denominator: 0, state: "no-referenced-request" },
    });
  });

  it("drops excess post-response observations instead of growing its queue", () => {
    const recorder = new DashboardTimingRecorder(events);
    for (let index = 0; index < DASHBOARD_TIMING_MAX_QUEUE + 1; index += 1) {
      recorder.recordServer({ label: "mesh_threads", durationMs: 1, status: 200, bytes: 1 });
    }
    while (timingRows().length < DASHBOARD_TIMING_MAX_QUEUE) recorder.flush();
    expect(timingRows()).toHaveLength(DASHBOARD_TIMING_MAX_QUEUE);
    expect(recorder.droppedCount).toBe(1);
  });

  it("prunes only timing rows at boot and does not prune every flush", () => {
    let now = new Date("2026-10-05T12:00:00.000Z");
    events.record({
      id: "old-timing",
      kind: DASHBOARD_TIMING_EVENT_KIND,
      ts: "2026-09-20T00:00:00.000Z",
      payload: "{}",
    });
    events.record({
      id: "old-run",
      kind: "run_end",
      ts: "2026-09-20T00:00:00.000Z",
      payload: "{}",
    });
    const pruneSpy = vi.spyOn(events, "pruneKind");
    const recorder = new DashboardTimingRecorder(events, () => now);
    recorder.start();
    expect(
      events.listByKindSince(DASHBOARD_TIMING_EVENT_KIND, "2026-09-01T00:00:00.000Z", 10)
    ).toEqual([]);
    expect(events.listByKindSince("run_end", "2026-09-01T00:00:00.000Z", 10)).toHaveLength(1);

    recorder.recordServer({ label: "mesh_threads", durationMs: 1, status: 200, bytes: 1 });
    recorder.flush();
    expect(pruneSpy).toHaveBeenCalledTimes(1);
    now = new Date(now.getTime() + DASHBOARD_TIMING_PRUNE_INTERVAL_MS);
    recorder.recordServer({ label: "mesh_threads", durationMs: 1, status: 200, bytes: 1 });
    recorder.flush();
    expect(pruneSpy).toHaveBeenCalledTimes(2);
  });

  it("drains queued observations before the repository is released", () => {
    const recorder = new DashboardTimingRecorder(events);
    recorder.recordServer({ label: "mesh_threads", durationMs: 1, status: 200, bytes: 1 });
    recorder.stop();
    expect(timingRows()).toHaveLength(1);
    recorder.recordServer({ label: "mesh_threads", durationMs: 1, status: 200, bytes: 1 });
    expect(recorder.droppedCount).toBe(1);
  });

  it("drops a failed post-response write rather than throwing outside the request", () => {
    const recorder = new DashboardTimingRecorder({
      record: () => {
        throw new Error("disk unavailable");
      },
      listByKindSince: events.listByKindSince.bind(events),
      pruneKind: events.pruneKind.bind(events),
    });
    recorder.recordServer({ label: "mesh_threads", durationMs: 1, status: 200, bytes: 1 });

    expect(() => recorder.flush()).not.toThrow();
    expect(recorder.droppedCount).toBe(1);
  });
});
