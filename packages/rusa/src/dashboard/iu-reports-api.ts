import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { iuReportPaths } from "../understanding/persistence-utils.js";

export interface IuReportsApiDeps {
  mcHome: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Dispatch GET /api/understanding/reports
 * Returns true if it owned the request, false to fall through.
 */
export async function handleIuReportsApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: IuReportsApiDeps
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/understanding/reports")) return false;

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const paths = iuReportPaths(deps.mcHome);

  if (url.pathname === "/api/understanding/reports") {
    try {
      const indexStr = readFileSync(paths.indexPath, "utf-8");
      const index = JSON.parse(indexStr);
      if (index.v !== 1) {
        // Degrade gracefully for unsupported versions
        sendJson(res, 200, { v: index.v, runs: [], unsupportedVersion: true });
        return true;
      }
      sendJson(res, 200, index);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "ENOENT") {
        sendJson(res, 200, { v: 1, runs: [] }); // Normal empty state
      } else {
        sendJson(res, 500, { error: (err as Error).message });
      }
    }
    return true;
  }

  if (url.pathname === "/api/understanding/reports/content") {
    const runId = url.searchParams.get("run_id");
    if (!runId) {
      sendJson(res, 400, { error: "missing run_id" });
      return true;
    }
    let indexStr: string;
    try {
      indexStr = readFileSync(paths.indexPath, "utf-8");
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "ENOENT") {
        sendJson(res, 404, { error: "index not found" });
        return true;
      }
      sendJson(res, 500, { error: (err as Error).message });
      return true;
    }

    let index: { v?: number; runs?: { run_id: string; reportPath?: string }[] };
    try {
      index = JSON.parse(indexStr);
    } catch {
      sendJson(res, 500, { error: "malformed index.json" });
      return true;
    }

    if (index.v !== 1) {
      sendJson(res, 400, { error: "unsupported version" });
      return true;
    }

    const run = index.runs?.find((r) => r.run_id === runId);
    if (!run) {
      sendJson(res, 404, { error: "run not found" });
      return true;
    }

    if (!run.reportPath || typeof run.reportPath !== "string") {
      sendJson(res, 404, { error: "run has no valid reportPath" });
      return true;
    }

    if (isAbsolute(run.reportPath)) {
      sendJson(res, 403, { error: "invalid report path" });
      return true;
    }

    const rootDir = resolve(paths.reportsDir);
    const resolvedPath = resolve(rootDir, run.reportPath);
    const rel = relative(rootDir, resolvedPath);

    if (rel.startsWith("..") || rel === "") {
      sendJson(res, 403, { error: "path traversal detected" });
      return true;
    }

    try {
      const markdown = readFileSync(resolvedPath, "utf-8");
      sendJson(res, 200, { markdown });
    } catch (err: unknown) {
      if ((err as { code?: string }).code === "ENOENT") {
        sendJson(res, 404, { error: "report file not found" });
      } else {
        sendJson(res, 500, { error: (err as Error).message });
      }
    }
    return true;
  }

  return false;
}
