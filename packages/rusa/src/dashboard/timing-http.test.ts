// @vitest-environment node

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { DashboardTimingRecorder } from "./timing.js";
import { handleDashboardTimingTelemetry } from "./timing-http.js";

describe("dashboard timing telemetry route", () => {
  let db: Database.Database;
  let events: MeshEventRepository;
  let timings: DashboardTimingRecorder;
  let server: ReturnType<typeof createServer>;
  let origin: string;

  beforeEach(async () => {
    db = new Database(":memory:");
    runMigrations(db);
    events = new MeshEventRepository(db);
    timings = new DashboardTimingRecorder(events);
    server = createServer(async (req, res) => {
      const owned = await handleDashboardTimingTelemetry(
        req,
        res,
        new URL(req.url ?? "/", "http://localhost").pathname,
        timings
      );
      if (!owned) res.end("not found");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it("accepts a bounded fixed-label envelope and refuses raw fields", async () => {
    const requestId = randomUUID();
    const accepted = await fetch(`${origin}/api/dashboard/timing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        interaction: "initial_load",
        durationMs: 25,
        requestIds: [requestId],
        requestTimings: [{ requestId, requestMs: 20 }],
      }),
    });
    expect(accepted.status).toBe(202);
    const rejected = await fetch(`${origin}/api/dashboard/timing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        interaction: "initial_load",
        durationMs: 25,
        requestIds: [requestId],
        requestTimings: [{ requestId, requestMs: 20.5 }],
      }),
    });
    expect(rejected.status).toBe(400);
    const rawField = await fetch(`${origin}/api/dashboard/timing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        interaction: "initial_load",
        durationMs: 25,
        requestIds: [requestId],
        rawUrl: "/api/mesh/threads?should-not-be-accepted",
      }),
    });
    expect(rawField.status).toBe(400);

    timings.flush();
    const rows = events.listByKindSince(
      "dashboard_timing",
      new Date(Date.now() - 60_000).toISOString(),
      10
    );
    expect(rows).toHaveLength(1);
    expect(`${rows[0].detail}${rows[0].payload}`).not.toContain("should-not-be-accepted");
  });

  it("enforces the 8 KiB envelope bound", async () => {
    const response = await fetch(`${origin}/api/dashboard/timing`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(8 * 1024 + 1),
    });
    expect(response.status).toBe(413);
  });
});
