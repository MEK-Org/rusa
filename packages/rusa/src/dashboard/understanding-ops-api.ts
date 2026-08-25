import type { IncomingMessage, ServerResponse } from "node:http";
import type { AnyOp } from "@thkp-eng/goals-types";
import { compressOp } from "@thkp-eng/goals-types";

/**
 * The IU tree view's server half (ISSUE_NUM phase 2b). A paginated op-getter that serves
 * the distiller's **LOCAL graph** ops (the `baseline.jsonl + ops.jsonl` read via
 * `LocalFilePersistenceService.load`).
 *
 * Read-only: it only ever calls `load`. `GET /api/understanding/ops?cursor=&limit=` →
 * `{ ops, nextCursor }`; the client pages until `ops` is empty.
 */
export interface UnderstandingOpsDeps {
  load: (opts: {
    cursor?: string | null;
    limit?: number;
  }) => Promise<{ ops: AnyOp[]; cursor: string | null }>;
  /**
   * The configured sandbox root node id (`resolveUnderstandingRootNodeId(config)`), surfaced so the
   * tree view can hide the sandbox root node itself while rendering all top-level concept nodes.
   */
  rootNodeId?: string | null;
  /**
   * Resolve externalized op string content by entry id (ISSUE_NUM — node-body rendering). glass_goals
   * externalizes a log entry's text into a separate `v001_strings` key-value store and stores the
   * op text-less, so a node's body must be loaded separately. The tree view's `SyncClient`
   * loads it via `loadString → GET /api/understanding/strings`, which calls this — read-only.
   * Absent → the endpoint serves `{}` (bodies render blank but nothing errors). Distiller-written
   * ops keep their text inline, so only baseline (externalized) entries actually resolve here.
   */
  loadStrings?: (ids: string[]) => Promise<Record<string, string>>;
}

const PATH = "/api/understanding/ops";
const STRINGS_PATH = "/api/understanding/strings";
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
/** Cap ids per strings request (the browser batches a page's missing entries into one call). */
const MAX_STRING_IDS = 2000;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/** Parse + clamp the `limit` query param to [1, MAX_LIMIT], defaulting to DEFAULT_LIMIT. */
function clampLimit(raw: string | null): number {
  const n = raw == null ? DEFAULT_LIMIT : Number(raw);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/**
 * Dispatch `GET /api/understanding/ops`. Returns true if it owned the request, false to
 * fall through (not this path).
 */
export async function handleUnderstandingOpsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: UnderstandingOpsDeps
): Promise<boolean> {
  if (url.pathname !== PATH) return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  const cursor = url.searchParams.get("cursor"); // string | null (null = from the start)
  const limit = clampLimit(url.searchParams.get("limit"));
  try {
    const { ops, cursor: nextCursor } = await deps.load({ cursor, limit });
    // Serve the canonical COMPACT wire form (`compressOp` → WireOp). The store holds
    // EXPANDED ops (`pullRemoteBaseline`/the SyncClient keep the verbose in-memory
    // `AnyOp` shape — full key names like `creationTime`/`type`), but the browser view's
    // glass_goals op model deserializes the compact wire keys (`cT`/`t`/…) — the same
    // shape Firestore stores. Without this, the very first op fails `GoalLogEntry.fromJsonMap`
    // (missing `t`) and the whole tree refuses to render. compressOp is the inverse of the
    // expandOp used when reading Firestore, so this is a lossless round-trip.
    sendJson(res, 200, {
      ops: ops.map((op) => compressOp(op)),
      nextCursor,
      rootNodeId: deps.rootNodeId ?? null,
    });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

/**
 * Dispatch `GET /api/understanding/strings?ids=a,b,c` — resolve externalized op string content
 * (node bodies) by entry id, the glass_goals "separately-loaded strings" pattern. Returns
 * `{ strings: { id: text } }`; ids with no resolvable string are simply omitted (the body for
 * those renders blank, not an error). Read-only. Returns true if it owned the request.
 */
export async function handleUnderstandingStringsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: UnderstandingOpsDeps
): Promise<boolean> {
  if (url.pathname !== STRINGS_PATH) return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  const raw = url.searchParams.get("ids");
  const ids = raw
    ? [
        ...new Set(
          raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        ),
      ].slice(0, MAX_STRING_IDS)
    : [];
  if (ids.length === 0 || !deps.loadStrings) {
    sendJson(res, 200, { strings: {} });
    return true;
  }
  try {
    const strings = await deps.loadStrings(ids);
    sendJson(res, 200, { strings });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
