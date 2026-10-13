// @vitest-environment node
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import {
  DASHBOARD_TIMING_EVENT_KIND,
  DASHBOARD_TIMING_MAX_QUEUE,
  DASHBOARD_TIMING_MAX_RECORDS,
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
    expect(summary.clientServerCoverage).toEqual({
      clientRequestIds: 1,
      serverRequestIds: 20,
      matchedRequestIds: 1,
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
    // #923's legacy block counts any server row; exact pairs live only in requestCoverage.
    expect(summary.clientServerCoverage).toEqual({
      clientRequestIds: 5,
      serverRequestIds: 4,
      matchedRequestIds: 4,
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

  it("takes paired phases only from the exact unambiguous cohort, with phase coverage", () => {
    const recorder = new DashboardTimingRecorder(
      events,
      () => new Date("2026-10-05T12:00:00.000Z")
    );
    const first = randomUUID();
    const second = randomUUID();
    const duplicate = randomUUID();
    const unpaired = randomUUID();
    for (const [requestId, durationMs, phases] of [
      [first, 60, { auth: 10, route: 30, enrichment: 20 }],
      [second, 70, { route: 50 }],
      [duplicate, 900, { auth: 500 }],
      [duplicate, 901, { auth: 500 }],
      [unpaired, 950, { auth: 900 }],
    ] as const) {
      recorder.recordServer({
        label: "mesh_threads",
        requestId,
        durationMs,
        status: 200,
        bytes: 1,
        phases,
      });
    }
    recorder.recordClient({
      interaction: "initial_load",
      durationMs: 300,
      requestIds: [first, second, duplicate],
      requestTimings: [
        { requestId: first, requestMs: 90 },
        { requestId: second, requestMs: 100 },
        { requestId: duplicate, requestMs: 110 },
      ],
      outcome: "success",
    });
    while (timingRows().length < 6) recorder.flush();

    const summary = recorder.summary({ since: new Date("2026-10-05T11:00:00.000Z") });
    // The duplicate and unpaired servers' slow auth never reaches the paired cohort.
    expect(summary.pairedRequestDurations).toEqual([
      expect.objectContaining({
        sampleCount: 2,
        serverPhaseMs: {
          auth: {
            p50Ms: 10,
            p95Ms: 10,
            p99Ms: 10,
            maxMs: 10,
            coverage: { numerator: 1, denominator: 2, state: "partial" },
          },
          route: {
            p50Ms: 30,
            p95Ms: 50,
            p99Ms: 50,
            maxMs: 50,
            coverage: { numerator: 2, denominator: 2, state: "full" },
          },
          enrichment: {
            p50Ms: 20,
            p95Ms: 20,
            p99Ms: 20,
            maxMs: 20,
            coverage: { numerator: 1, denominator: 2, state: "partial" },
          },
        },
      }),
    ]);
    // The server view counts every record of the label, measured or not.
    expect(summary.serverPhases).toEqual([
      expect.objectContaining({
        label: "mesh_threads",
        sampleCount: 5,
        durationMs: { p50Ms: 900, p95Ms: 950, p99Ms: 950, maxMs: 950 },
        phases: expect.objectContaining({
          auth: expect.objectContaining({
            maxMs: 900,
            coverage: { numerator: 4, denominator: 5, state: "partial" },
          }),
        }),
      }),
    ]);
    expect(summary.serverPhases[0].phases.serialization).toBeUndefined();
    expect(summary.serverPhases[0].phases.compression).toBeUndefined();
  });

  it("splits quota snapshot and history pairs and keeps pre-phase records unchanged", () => {
    const recorder = new DashboardTimingRecorder(
      events,
      () => new Date("2026-10-05T12:00:00.000Z")
    );
    const snapshot = randomUUID();
    const history = randomUUID();
    const legacy = randomUUID();
    recorder.recordServer({
      label: "mesh_quota",
      operation: "quota_snapshot",
      requestId: snapshot,
      durationMs: 5,
      status: 200,
      bytes: 1,
      phases: { route: 3 },
    });
    recorder.recordServer({
      label: "mesh_quota",
      operation: "quota_history",
      requestId: history,
      durationMs: 400,
      status: 200,
      bytes: 1,
      phases: { auth: 2, route: 390 },
    });
    recorder.recordServer({
      label: "mesh_threads",
      requestId: legacy,
      durationMs: 40,
      status: 200,
      bytes: 1,
      phases: {},
    });
    recorder.recordClient({
      interaction: "initial_load",
      durationMs: 500,
      requestIds: [snapshot, history, legacy],
      requestTimings: [
        { requestId: snapshot, requestMs: 20 },
        { requestId: history, requestMs: 450 },
        { requestId: legacy, requestMs: 60 },
      ],
      outcome: "success",
    });
    while (timingRows().length < 4) recorder.flush();

    const summary = recorder.summary({ since: new Date("2026-10-05T11:00:00.000Z") });
    expect(
      summary.pairedRequestDurations.map(({ serverLabel, serverOperation, serverPhaseMs }) => ({
        serverLabel,
        serverOperation,
        route: serverPhaseMs?.route?.p50Ms,
      }))
    ).toEqual([
      { serverLabel: "mesh_quota", serverOperation: "quota_history", route: 390 },
      { serverLabel: "mesh_quota", serverOperation: "quota_snapshot", route: 3 },
      { serverLabel: "mesh_threads", serverOperation: undefined, route: undefined },
    ]);
    // A pair with no measured phase keeps the pre-phase shape exactly.
    expect(Object.keys(summary.pairedRequestDurations[2]).sort()).toEqual([
      "clientRequestMs",
      "interaction",
      "sampleCount",
      "serverDurationMs",
      "serverLabel",
    ]);
    expect(
      summary.serverPhases.map(({ label, operation, phases }) => ({
        label,
        operation,
        phases: Object.keys(phases),
      }))
    ).toEqual([
      { label: "mesh_quota", operation: "quota_history", phases: ["auth", "route"] },
      { label: "mesh_quota", operation: "quota_snapshot", phases: ["route"] },
      { label: "mesh_threads", operation: undefined, phases: [] },
    ]);
    // The legacy endpoint groups are still one per source and label.
    expect(summary.groups.filter((group) => group.label === "mesh_quota")).toHaveLength(1);
    const stored = timingRows().map((row) => JSON.parse(row.payload ?? "{}"));
    expect(stored.every((payload) => payload.v === 1)).toBe(true);
    expect(stored.find((payload) => payload.label === "mesh_threads")).not.toHaveProperty("phases");
  });

  it("ignores rows that carry phases or operations outside their fixed server shape", () => {
    const recorder = new DashboardTimingRecorder(events);
    const base = {
      v: 1,
      source: "server",
      requestId: randomUUID(),
      durationMs: 10,
      status: 200,
      bytes: 1,
      outcome: null,
    };
    const invalid = [
      { ...base, label: "mesh_threads", phases: { network: 5 } },
      { ...base, label: "mesh_threads", phases: { auth: 1.5 } },
      { ...base, label: "mesh_threads", operation: "quota_history" },
      { ...base, label: "mesh_quota", operation: "/api/quota?provider=x" },
      {
        ...base,
        source: "client",
        label: "initial_load",
        requestId: undefined,
        status: null,
        bytes: null,
        outcome: "success",
        requestIds: [],
        phases: { auth: 1 },
      },
    ];
    for (const payload of invalid) {
      events.record({
        kind: DASHBOARD_TIMING_EVENT_KIND,
        actorId: null,
        detail: "synthetic",
        payload: JSON.stringify(payload),
      });
    }
    events.record({
      kind: DASHBOARD_TIMING_EVENT_KIND,
      actorId: null,
      detail: "synthetic",
      payload: JSON.stringify({ ...base, label: "mesh_quota", operation: "quota_history" }),
    });

    const summary = recorder.summary({ since: new Date(Date.now() - 60_000) });
    expect(summary.sampleCount).toBe(1);
    expect(summary.serverPhases).toEqual([
      expect.objectContaining({ label: "mesh_quota", operation: "quota_history", phases: {} }),
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

  it("keeps success, non-2xx and closed-before-finish populations apart per method (#990)", () => {
    const recorder = new DashboardTimingRecorder(events);
    const request = (
      method: "GET" | "HEAD" | "OPTIONS",
      terminal: "finished" | "closed_before_finish" = "finished"
    ) => ({ method, terminal });
    const server = (durationMs: number, status: number | null, req: ReturnType<typeof request>) =>
      recorder.recordServer({
        label: "mesh_obligations",
        durationMs,
        status,
        bytes: 1,
        request: req,
      });
    server(10, 200, request("GET"));
    server(30, 304, request("GET"));
    server(900, 500, request("GET"));
    server(4000, null, request("GET", "closed_before_finish"));
    server(3, 200, request("HEAD"));
    server(1, 204, request("OPTIONS"));
    while (timingRows().length < 6) recorder.flush();

    const summary = recorder.summary({ since: new Date(Date.now() - 60_000) });
    const empty = { count: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
    expect(summary.serverPopulations).toEqual([
      {
        label: "mesh_obligations",
        method: "GET",
        finishedSuccess: { count: 2, p50Ms: 10, p95Ms: 30, p99Ms: 30, maxMs: 30 },
        finishedFailure: { count: 1, p50Ms: 900, p95Ms: 900, p99Ms: 900, maxMs: 900 },
        closedBeforeFinish: { count: 1, p50Ms: 4000, p95Ms: 4000, p99Ms: 4000, maxMs: 4000 },
      },
      {
        label: "mesh_obligations",
        method: "HEAD",
        finishedSuccess: { count: 1, p50Ms: 3, p95Ms: 3, p99Ms: 3, maxMs: 3 },
        finishedFailure: empty,
        closedBeforeFinish: empty,
      },
      {
        label: "mesh_obligations",
        method: "OPTIONS",
        finishedSuccess: { count: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, maxMs: 1 },
        finishedFailure: empty,
        closedBeforeFinish: empty,
      },
    ]);
    // The pre-#990 aggregates keep their finished-only population: every
    // method and status together, but never the premature close.
    expect(summary.groups).toEqual([
      expect.objectContaining({
        source: "server",
        label: "mesh_obligations",
        count: 5,
        maxMs: 900,
        statusBuckets: { "2xx": 3, "3xx": 1, "5xx": 1 },
      }),
    ]);
    expect(summary.serverPhases).toEqual([
      expect.objectContaining({ label: "mesh_obligations", sampleCount: 5 }),
    ]);
  });

  it("keeps a premature close out of client/server pairing and coverage (#990)", () => {
    const recorder = new DashboardTimingRecorder(events);
    const closedId = randomUUID();
    recorder.recordServer({
      label: "mesh_threads",
      requestId: closedId,
      durationMs: 5000,
      status: null,
      bytes: 0,
      request: { method: "GET", terminal: "closed_before_finish" },
    });
    recorder.recordClient({
      interaction: "initial_load",
      durationMs: 5100,
      requestIds: [closedId],
      requestTimings: [{ requestId: closedId, requestMs: 5050 }],
      outcome: "failure",
    });
    while (timingRows().length < 2) recorder.flush();

    const summary = recorder.summary({ since: new Date(Date.now() - 60_000) });
    expect(summary.clientServerCoverage).toEqual({
      clientRequestIds: 1,
      serverRequestIds: 0,
      matchedRequestIds: 0,
    });
    expect(summary.pairedRequestDurations).toEqual([]);
    expect(summary.serverPopulations).toEqual([
      expect.objectContaining({
        label: "mesh_threads",
        method: "GET",
        closedBeforeFinish: expect.objectContaining({ count: 1, maxMs: 5000 }),
      }),
    ]);
  });

  it("reports pre-#990 rows as an unknown method with unknown closes (#990)", () => {
    const recorder = new DashboardTimingRecorder(events);
    const legacy = {
      v: 1,
      source: "server",
      label: "mesh_threads",
      requestId: randomUUID(),
      durationMs: 12,
      status: 200,
      bytes: 1,
      outcome: null,
    };
    events.record({
      kind: DASHBOARD_TIMING_EVENT_KIND,
      actorId: null,
      detail: "synthetic",
      payload: JSON.stringify(legacy),
    });
    events.record({
      kind: DASHBOARD_TIMING_EVENT_KIND,
      actorId: null,
      detail: "synthetic",
      payload: JSON.stringify({ ...legacy, status: 503, durationMs: 40 }),
    });
    recorder.recordServer({
      label: "mesh_threads",
      durationMs: 8,
      status: 200,
      bytes: 1,
      request: { method: "GET", terminal: "finished" },
    });
    while (timingRows().length < 3) recorder.flush();

    const summary = recorder.summary({ since: new Date(Date.now() - 60_000) });
    expect(summary.serverPopulations).toEqual([
      expect.objectContaining({
        method: "GET",
        finishedSuccess: expect.objectContaining({ count: 1, maxMs: 8 }),
        closedBeforeFinish: expect.objectContaining({ count: 0 }),
      }),
      expect.objectContaining({
        method: "unknown",
        finishedSuccess: expect.objectContaining({ count: 1, maxMs: 12 }),
        finishedFailure: expect.objectContaining({ count: 1, maxMs: 40 }),
        closedBeforeFinish: null,
      }),
    ]);
  });

  it("accepts method and terminal only on v2 server request rows (#990)", () => {
    const recorder = new DashboardTimingRecorder(events);
    const v2 = {
      v: 2,
      source: "server",
      label: "mesh_threads",
      method: "GET",
      terminal: "finished",
      requestId: randomUUID(),
      durationMs: 10,
      status: 200,
      bytes: 1,
      outcome: null,
    };
    const { method: _method, terminal: _terminal, ...withoutRequest } = v2;
    const invalid = [
      { ...withoutRequest },
      { ...v2, method: undefined },
      { ...v2, terminal: undefined },
      { ...v2, method: "PROPFIND" },
      { ...v2, terminal: "timeout" },
      { ...v2, v: 1 },
      { ...withoutRequest, v: 1, method: "GET" },
      { ...v2, label: "mesh_stream_open" },
      { ...v2, v: 3 },
      {
        ...withoutRequest,
        source: "client",
        label: "initial_load",
        requestId: undefined,
        requestIds: [],
        status: null,
        bytes: null,
        outcome: "success",
        method: "GET",
        terminal: "finished",
      },
    ];
    for (const payload of [...invalid, v2]) {
      events.record({
        kind: DASHBOARD_TIMING_EVENT_KIND,
        actorId: null,
        detail: "synthetic",
        payload: JSON.stringify(payload),
      });
    }

    const summary = recorder.summary({ since: new Date(Date.now() - 60_000) });
    expect(summary.sampleCount).toBe(1);
    expect(summary.window).toMatchObject({
      recordsRead: invalid.length + 1,
      unreadableRecords: invalid.length,
    });
    expect(summary.serverPopulations).toEqual([
      expect.objectContaining({
        label: "mesh_threads",
        method: "GET",
        finishedSuccess: expect.objectContaining({ count: 1 }),
      }),
    ]);
  });

  it("says when the read cap or retention, not the request, bounded the window (#990)", () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const recorder = new DashboardTimingRecorder(events, () => now);
    const insert = db.prepare(
      "INSERT INTO mesh_events (id, ts, kind, payload) VALUES (?, ?, ?, ?)"
    );
    const payload = JSON.stringify({
      v: 2,
      source: "server",
      label: "mesh_threads",
      method: "GET",
      terminal: "finished",
      durationMs: 1,
      status: 200,
      bytes: 1,
      outcome: null,
    });
    const tsAt = (index: number) => new Date(now.getTime() - (index + 1) * 1000).toISOString();
    db.transaction(() => {
      for (let index = 0; index < DASHBOARD_TIMING_MAX_RECORDS - 1; index += 1) {
        insert.run(randomUUID(), tsAt(index), DASHBOARD_TIMING_EVENT_KIND, payload);
      }
    })();
    const day = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(recorder.summary({ since: day }).window).toEqual({
      requestedSince: day.toISOString(),
      oldestRecordAt: tsAt(DASHBOARD_TIMING_MAX_RECORDS - 2),
      newestRecordAt: tsAt(0),
      recordsRead: DASHBOARD_TIMING_MAX_RECORDS - 1,
      readCap: DASHBOARD_TIMING_MAX_RECORDS,
      capReached: false,
      retentionMs: 7 * 24 * 60 * 60 * 1000,
      retentionLimited: false,
      unreadableRecords: 0,
    });

    // Two older in-window rows: the newest-first read stops at the cap.
    insert.run(
      randomUUID(),
      tsAt(DASHBOARD_TIMING_MAX_RECORDS - 1),
      DASHBOARD_TIMING_EVENT_KIND,
      payload
    );
    insert.run(
      randomUUID(),
      tsAt(DASHBOARD_TIMING_MAX_RECORDS),
      DASHBOARD_TIMING_EVENT_KIND,
      payload
    );
    const capped = recorder.summary({ since: day });
    expect(capped.window).toMatchObject({
      oldestRecordAt: tsAt(DASHBOARD_TIMING_MAX_RECORDS - 1),
      recordsRead: DASHBOARD_TIMING_MAX_RECORDS,
      capReached: true,
    });
    expect(capped.sampleCount).toBe(DASHBOARD_TIMING_MAX_RECORDS);

    const eightDays = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    expect(recorder.summary({ since: eightDays }).window.retentionLimited).toBe(true);
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
