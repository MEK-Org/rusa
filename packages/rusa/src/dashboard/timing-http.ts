import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DASHBOARD_TIMING_MAX_CLIENT_BODY_BYTES,
  type DashboardTimingRecorder,
  parseDashboardClientTiming,
} from "./timing.js";

/** Read the telemetry envelope without admitting an unbounded client body. */
function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        req.resume();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Own the bounded client-telemetry route. It is purposefully separate from
 * dashboard routing so the route can be tested without loading optional UI
 * and understanding integrations.
 */
export async function handleDashboardTimingTelemetry(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  timings: DashboardTimingRecorder | undefined
): Promise<boolean> {
  if (pathname !== "/api/dashboard/timing") return false;
  if (!timings) {
    sendJson(res, 503, { error: "dashboard timing unavailable (no live mesh bound)" });
    return true;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method not allowed" }, { Allow: "POST" });
    return true;
  }
  try {
    const raw = await readBoundedBody(req, DASHBOARD_TIMING_MAX_CLIENT_BODY_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { error: "invalid content-free dashboard timing envelope" });
      return true;
    }
    const input = parseDashboardClientTiming(value);
    if (!input) {
      sendJson(res, 400, { error: "invalid content-free dashboard timing envelope" });
      return true;
    }
    timings.recordClient(input);
    sendJson(res, 202, { accepted: true });
  } catch (err) {
    const status = err instanceof Error && err.message === "request body too large" ? 413 : 400;
    sendJson(res, status, {
      error: status === 413 ? "request body too large" : "invalid timing request",
    });
  }
  return true;
}
