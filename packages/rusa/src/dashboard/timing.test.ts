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
        outcome: "success",
      })
    ).toEqual({
      interaction: "initial_load",
      durationMs: 123,
      requestIds: [id],
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
      outcome: "success",
    });
    while (timingRows().length < 21) recorder.flush();

    const summary = recorder.summary({
      since: new Date("2026-10-05T11:00:00.000Z"),
      label: "initial_load",
    });
    expect(summary.clientServerCoverage).toEqual({
      clientRequestIds: 1,
      serverRequestIds: 20,
      matchedRequestIds: 1,
    });
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
