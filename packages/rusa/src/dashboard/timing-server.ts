import type { ServerResponse } from "node:http";
import { type EventLoopUtilization, performance } from "node:perf_hooks";
import {
  createDashboardRequestId,
  type DashboardTimingRecorder,
  type DashboardTimingTerminal,
  dashboardTimingLabelForRoute,
  dashboardTimingMethod,
  dashboardTimingOperationForRoute,
} from "./timing.js";
import { attachDashboardPhaseClock, DashboardPhaseClock } from "./timing-phases.js";

/**
 * Count only response-body bytes; headers and socket framing are intentionally
 * excluded. The first header write or body write also ends the route phase,
 * and the last body handoff (`end`) is when `finishMs` starts.
 */
function trackResponse(
  res: ServerResponse,
  phases: DashboardPhaseClock
): { bytes: () => number; endedAt: () => number | undefined } {
  let bytes = 0;
  let endedAt: number | undefined;
  // ServerResponse has overloaded write/end signatures. This tiny structural
  // view preserves each runtime call unchanged while allowing one wrapper to
  // observe the first argument from every overload.
  const response = res as unknown as {
    writeHead: (...args: unknown[]) => unknown;
    write: (...args: unknown[]) => unknown;
    end: (...args: unknown[]) => unknown;
  };
  const originalWriteHead = response.writeHead.bind(res);
  const originalWrite = response.write.bind(res);
  const originalEnd = response.end.bind(res);
  response.writeHead = (...args: unknown[]) => {
    phases.finishRoute();
    return originalWriteHead(...args);
  };
  const add = (chunk: unknown, encoding: BufferEncoding | undefined) => {
    if (typeof chunk === "string") bytes += Buffer.byteLength(chunk, encoding);
    else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) bytes += chunk.byteLength;
  };
  response.write = (...args: unknown[]) => {
    phases.finishRoute();
    add(args[0], typeof args[1] === "string" && Buffer.isEncoding(args[1]) ? args[1] : undefined);
    return originalWrite(...args);
  };
  response.end = (...args: unknown[]) => {
    phases.finishRoute();
    add(args[0], typeof args[1] === "string" && Buffer.isEncoding(args[1]) ? args[1] : undefined);
    // First wins: a repeated end on an ended response hands off nothing.
    endedAt ??= performance.now();
    return originalEnd(...args);
  };
  return { bytes: () => bytes, endedAt: () => endedAt };
}

/** Whole percent of loop time spent running JavaScript since `start`. */
function loopBusyPct(start: EventLoopUtilization): number | undefined {
  const { utilization } = performance.eventLoopUtilization(start);
  if (!Number.isFinite(utilization)) return undefined;
  return Math.min(100, Math.max(0, Math.round(utilization * 100)));
}

/**
 * Attach the request-wide, post-response server timing observation. All dynamic
 * API replies get a correlation UUID; the telemetry receiver itself gets the
 * header but is intentionally not measured to avoid recursive events.
 *
 * Exactly one record per request (#990): `finished` on `finish`, or
 * `closed_before_finish` when the connection closes first. A finished response
 * also emits `close`; the guard keeps that from becoming a second record.
 * `loopBusyPct` covers the same start-to-terminal window as `durationMs`.
 */
export function beginDashboardRequestTiming(
  res: ServerResponse,
  pathname: string,
  method: string | undefined,
  timings: DashboardTimingRecorder | undefined
): void {
  const requestId = pathname.startsWith("/api/") ? createDashboardRequestId() : undefined;
  if (requestId) res.setHeader("X-Rusa-Request-Id", requestId);
  const label = timings ? dashboardTimingLabelForRoute(pathname, method ?? "GET") : null;
  if (!timings || !label) return;
  // SSE has separate open/close observations in the mesh handler; its lifetime
  // must not masquerade as one giant request-latency sample.
  if (label === "mesh_stream_open") return;
  const started = performance.now();
  const loopAtStart = performance.eventLoopUtilization();
  const phases = new DashboardPhaseClock();
  attachDashboardPhaseClock(phases);
  const response = trackResponse(res, phases);
  const operation = dashboardTimingOperationForRoute(pathname);
  const requestMethod = dashboardTimingMethod(method ?? "GET");
  let recorded = false;
  const record = (terminal: DashboardTimingTerminal) => {
    if (recorded) return;
    recorded = true;
    const endedAt = performance.now();
    const handoffAt = response.endedAt();
    const busy = loopBusyPct(loopAtStart);
    timings.recordServer({
      label,
      ...(operation ? { operation } : {}),
      requestId,
      durationMs: Math.round(endedAt - started),
      // Before headers are sent, statusCode is only the default, not a reply.
      status: terminal === "finished" || res.headersSent ? res.statusCode : null,
      bytes: response.bytes(),
      phases: phases.durations(endedAt),
      substages: {
        ...phases.substages(endedAt),
        // A close before finish never completed the handoff, so it has none.
        ...(terminal === "finished" && handoffAt !== undefined
          ? { finishMs: Math.round(Math.max(0, endedAt - handoffAt)) }
          : {}),
        ...(busy === undefined ? {} : { loopBusyPct: busy }),
      },
      request: { method: requestMethod, terminal },
    });
  };
  res.once("finish", () => record("finished"));
  res.once("close", () => record(res.writableFinished ? "finished" : "closed_before_finish"));
}
