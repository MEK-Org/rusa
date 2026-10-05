// @vitest-environment node
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeshEvent, MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import {
  DASHBOARD_TIMING_EVENT_KIND,
  DASHBOARD_TIMING_MAX_QUEUE,
  DashboardTimingRecorder,
  parseDashboardClientTiming,
} from "./timing.js";

class FakeTimingStore {
  readonly events: MeshEvent[] = [];

  record(opts: Parameters<MeshEventRepository["record"]>[0]): string {
    const id = opts.id ?? randomUUID();
    this.events.push({
      id,
      ts: opts.ts ?? new Date().toISOString(),
      kind: opts.kind,
      actorId: opts.actorId ?? null,
      detail: opts.detail ?? null,
      body: opts.body ?? null,
      payload: opts.payload ?? null,
      success: opts.success ?? null,
    });
    return id;
  }

  listByKindSince(kind: string, sinceISO: string, limit: number): MeshEvent[] {
    return this.events
      .filter((event) => event.kind === kind && event.ts >= sinceISO)
      .slice(0, limit);
  }

  pruneKind(kind: string, olderThanISO: string, maxRecords: number): void {
    const retained = this.events
      .filter((event) => event.kind !== kind || event.ts >= olderThanISO)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    const timing = retained.filter((event) => event.kind === kind);
    const allowed = new Set(timing.slice(-maxRecords).map((event) => event.id));
    this.events.splice(
      0,
      this.events.length,
      ...retained.filter((event) => event.kind !== kind || allowed.has(event.id))
    );
  }
}

describe("dashboard timing recorder", () => {
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

  it("returns aggregates and correlation coverage without returning raw identifiers", () => {
    const store = new FakeTimingStore();
    const recorder = new DashboardTimingRecorder(store, () => new Date("2026-10-05T12:00:00.000Z"));
    const requestId = randomUUID();
    for (let index = 0; index < 20; index += 1) {
      recorder.recordServer({
        label: "mesh_threads",
        requestId: index === 0 ? requestId : randomUUID(),
        durationMs: 600,
        status: 200,
        bytes: 42,
        storeMs: 5,
      });
    }
    recorder.recordClient({
      interaction: "initial_load",
      durationMs: 2200,
      requestIds: [requestId],
    });
    while (store.events.length < 21) recorder.flush();

    const summary = recorder.summary({ since: new Date("2026-10-05T11:00:00.000Z") });
    expect(summary.clientServerCoverage).toEqual({
      clientRequestIds: 1,
      serverRequestIds: 20,
      matchedRequestIds: 1,
    });
    expect(summary.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "server",
          label: "mesh_threads",
          count: 20,
          p95Ms: 600,
          statusBuckets: { "2xx": 20 },
          store: { count: 20, totalMs: 100 },
          flagged: true,
        }),
      ])
    );
    expect(JSON.stringify(summary)).not.toContain(requestId);
  });

  it("drops excess post-response observations instead of growing its queue", () => {
    const store = new FakeTimingStore();
    const recorder = new DashboardTimingRecorder(store);
    for (let index = 0; index < DASHBOARD_TIMING_MAX_QUEUE + 1; index += 1) {
      recorder.recordServer({ label: "mesh_threads", durationMs: 1, status: 200, bytes: 1 });
    }
    while (store.events.length < DASHBOARD_TIMING_MAX_QUEUE) recorder.flush();
    expect(store.events).toHaveLength(DASHBOARD_TIMING_MAX_QUEUE);
    expect(recorder.droppedCount).toBe(1);
  });

  it("prunes only timing rows at boot", () => {
    const store = new FakeTimingStore();
    store.record({
      id: "old-timing",
      kind: DASHBOARD_TIMING_EVENT_KIND,
      ts: "2026-09-20T00:00:00.000Z",
      payload: "{}",
    });
    store.record({ id: "old-run", kind: "run_end", ts: "2026-09-20T00:00:00.000Z", payload: "{}" });
    new DashboardTimingRecorder(store, () => new Date("2026-10-05T12:00:00.000Z")).start();
    expect(store.events.map((event) => event.id)).toEqual(["old-run"]);
  });

  it("drains queued observations before the repository is released", () => {
    const store = new FakeTimingStore();
    const recorder = new DashboardTimingRecorder(store);
    recorder.recordServer({ label: "mesh_threads", durationMs: 1, status: 200, bytes: 1 });
    recorder.stop();
    expect(store.events).toHaveLength(1);
    recorder.recordServer({ label: "mesh_threads", durationMs: 1, status: 200, bytes: 1 });
    expect(recorder.droppedCount).toBe(1);
  });

  it("drops a failed post-response write rather than throwing outside the request", () => {
    const store = new FakeTimingStore();
    const recorder = new DashboardTimingRecorder({
      record: () => {
        throw new Error("disk unavailable");
      },
      listByKindSince: store.listByKindSince.bind(store),
      pruneKind: store.pruneKind.bind(store),
    });
    recorder.recordServer({ label: "mesh_threads", durationMs: 1, status: 200, bytes: 1 });

    expect(() => recorder.flush()).not.toThrow();
    expect(recorder.droppedCount).toBe(1);
  });
});
