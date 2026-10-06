// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import {
  DASHBOARD_TIMING_EVENT_KIND,
  DASHBOARD_TIMING_MAX_RECORDS,
  DashboardTimingRecorder,
} from "./timing.js";
import { beginDashboardRequestTiming } from "./timing-server.js";

const BATCH_SIZE = 32;
const SAMPLES = 20;
const BODY = JSON.stringify({ actors: 1000, status: "ok" });

class BenchResponse extends EventEmitter {
  statusCode = 200;
  readonly headers: Record<string, string> = {};

  setHeader(name: string, value: string): this {
    this.headers[name] = value;
    return this;
  }

  write(_chunk?: string | Buffer): boolean {
    return true;
  }

  end(_chunk?: string | Buffer): this {
    this.emit("finish");
    return this;
  }
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe.skipIf(process.env.RUSA_BENCH_DASHBOARD_TIMING !== "1")(
  "dashboard timing response-path overhead",
  () => {
    let db: Database.Database;
    let events: MeshEventRepository;
    let recorder: DashboardTimingRecorder;

    beforeEach(() => {
      db = new Database(":memory:");
      runMigrations(db);
      events = new MeshEventRepository(db);
      // Exercise the existing store at its durable count boundary rather than
      // an empty or mocked writer. The timestamp is current so boot pruning
      // retains this representative timing population.
      const timestamp = new Date().toISOString();
      for (let index = 0; index < DASHBOARD_TIMING_MAX_RECORDS; index += 1) {
        events.record({
          kind: DASHBOARD_TIMING_EVENT_KIND,
          detail: "server:mesh_threads",
          payload: JSON.stringify({
            v: 1,
            source: "server",
            label: "mesh_threads",
            durationMs: 1,
            status: 200,
            bytes: 2,
            outcome: null,
          }),
          ts: timestamp,
        });
      }
      recorder = new DashboardTimingRecorder(events);
      recorder.start();
    });

    afterEach(() => db.close());

    async function measureBatch(timings?: DashboardTimingRecorder): Promise<number[]> {
      const intervals: number[] = [];
      for (let index = 0; index < BATCH_SIZE; index += 1) {
        const started = performance.now();
        const response = new BenchResponse();
        if (timings) {
          beginDashboardRequestTiming(
            response as unknown as ServerResponse,
            "/api/mesh/threads",
            "GET",
            timings
          );
        }
        response.end(BODY);
        // The recorder's setImmediate flush is queued by `finish`; awaiting a
        // following turn includes that real SQLite overlap in each interval.
        await nextTurn();
        intervals.push(performance.now() - started);
      }
      return intervals;
    }

    it("reports p95 of individual response intervals with real SQLite flush overlap", async () => {
      const baseline: number[] = [];
      const instrumented: number[] = [];

      await measureBatch();
      await measureBatch(recorder);
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        if (sample % 2 === 0) {
          baseline.push(...(await measureBatch()));
          instrumented.push(...(await measureBatch(recorder)));
        } else {
          instrumented.push(...(await measureBatch(recorder)));
          baseline.push(...(await measureBatch()));
        }
      }

      const baselineP95Ms = percentile(baseline, 0.95);
      const instrumentedP95Ms = percentile(instrumented, 0.95);
      console.log(
        JSON.stringify({
          metric: "dashboard_timing_post_response_sqlite_overlap",
          responsesPerArm: SAMPLES * BATCH_SIZE,
          retainedTimingRows: DASHBOARD_TIMING_MAX_RECORDS,
          baselineP95Ms,
          instrumentedP95Ms,
          p95DeltaMs: instrumentedP95Ms - baselineP95Ms,
          baselineMaxMs: percentile(baseline, 1),
          instrumentedMaxMs: percentile(instrumented, 1),
          note: "Includes UUID/header/response wrapper/enqueue and next-turn SQLite flush against retained timing rows; it is not an end-to-end dashboard-load latency claim.",
        })
      );
      expect(baseline).toHaveLength(SAMPLES * BATCH_SIZE);
      expect(instrumented).toHaveLength(SAMPLES * BATCH_SIZE);
    });
  }
);
