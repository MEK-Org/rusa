// @vitest-environment node
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import type { MeshEvent, MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { DashboardTimingRecorder } from "./timing.js";
import { beginDashboardRequestTiming } from "./timing-server.js";

const BATCH_SIZE = 64;
const SAMPLES = 40;
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

const noOpStore = {
  record: (_opts: Parameters<MeshEventRepository["record"]>[0]) => "timing-row",
  listByKindSince: (_kind: string, _sinceISO: string, _limit: number): MeshEvent[] => [],
  pruneKind: (_kind: string, _olderThanISO: string, _maxRecords: number) => undefined,
};

function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function measureBatch(timings?: DashboardTimingRecorder): number {
  const started = performance.now();
  for (let index = 0; index < BATCH_SIZE; index += 1) {
    const response = new BenchResponse();
    if (timings) {
      beginDashboardRequestTiming(
        response as unknown as ServerResponse,
        "/api/mesh/threads",
        timings
      );
    }
    response.end(BODY);
  }
  const millisecondsPerResponse = (performance.now() - started) / BATCH_SIZE;
  // Persisting is deliberately out of the measured response path.
  timings?.flush();
  return millisecondsPerResponse;
}

describe.skipIf(process.env.RUSA_BENCH_DASHBOARD_TIMING !== "1")(
  "dashboard timing response-path overhead",
  () => {
    it("reports paired p95 per-response overhead without a database flush", () => {
      const baseline: number[] = [];
      const instrumented: number[] = [];
      const recorder = new DashboardTimingRecorder(noOpStore);

      // Warm both paths once, then alternate each batch to reduce warmup bias.
      measureBatch();
      measureBatch(recorder);
      for (let sample = 0; sample < SAMPLES; sample += 1) {
        if (sample % 2 === 0) {
          baseline.push(measureBatch());
          instrumented.push(measureBatch(recorder));
        } else {
          instrumented.push(measureBatch(recorder));
          baseline.push(measureBatch());
        }
      }

      const baselineP95Ms = p95(baseline);
      const instrumentedP95Ms = p95(instrumented);
      console.log(
        JSON.stringify({
          metric: "dashboard_timing_response_path",
          samples: SAMPLES,
          batchSize: BATCH_SIZE,
          baselineP95Ms,
          instrumentedP95Ms,
          p95DeltaMs: instrumentedP95Ms - baselineP95Ms,
          note: "Includes UUID/header/response wrapper/enqueue; excludes post-response SQLite flush.",
        })
      );
      expect(baseline).toHaveLength(SAMPLES);
      expect(instrumented).toHaveLength(SAMPLES);
    });
  }
);
