import type { ServerResponse } from "node:http";
import {
  createDashboardRequestId,
  type DashboardTimingRecorder,
  dashboardTimingLabelForRoute,
} from "./timing.js";

/** Count only response-body bytes; headers and socket framing are intentionally excluded. */
function trackResponseBytes(res: ServerResponse): () => number {
  let bytes = 0;
  // ServerResponse has overloaded write/end signatures. This tiny structural
  // view preserves each runtime call unchanged while allowing one wrapper to
  // observe the first argument from every overload.
  const response = res as unknown as {
    write: (...args: unknown[]) => unknown;
    end: (...args: unknown[]) => unknown;
  };
  const originalWrite = response.write.bind(res);
  const originalEnd = response.end.bind(res);
  const add = (chunk: unknown, encoding: BufferEncoding | undefined) => {
    if (typeof chunk === "string") bytes += Buffer.byteLength(chunk, encoding);
    else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) bytes += chunk.byteLength;
  };
  response.write = (...args: unknown[]) => {
    add(args[0], typeof args[1] === "string" && Buffer.isEncoding(args[1]) ? args[1] : undefined);
    return originalWrite(...args);
  };
  response.end = (...args: unknown[]) => {
    add(args[0], typeof args[1] === "string" && Buffer.isEncoding(args[1]) ? args[1] : undefined);
    return originalEnd(...args);
  };
  return () => bytes;
}

/**
 * Attach the request-wide, post-response server timing observation. All dynamic
 * API replies get a correlation UUID; the telemetry receiver itself gets the
 * header but is intentionally not measured to avoid recursive events.
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
  const started = performance.now();
  const responseBytes = trackResponseBytes(res);
  // SSE has separate open/close observations in the mesh handler; its lifetime
  // must not masquerade as one giant request-latency sample.
  if (label === "mesh_stream_open") return;
  res.once("finish", () =>
    timings.recordServer({
      label,
      requestId,
      durationMs: Math.round(performance.now() - started),
      status: res.statusCode,
      bytes: responseBytes(),
    })
  );
}
