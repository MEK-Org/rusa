import { randomUUID } from "node:crypto";
import type { MeshEvent, MeshEventRepository } from "../db/repositories/mesh-event-repository.js";

/** Stored in the existing append-only log; no migration or dashboard UI change. */
export const DASHBOARD_TIMING_EVENT_KIND = "dashboard_timing";
export const DASHBOARD_TIMING_MAX_RECORDS = 20_000;
export const DASHBOARD_TIMING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DASHBOARD_TIMING_MAX_QUEUE = 512;
export const DASHBOARD_TIMING_MAX_CLIENT_IDS = 32;
export const DASHBOARD_TIMING_MAX_CLIENT_BODY_BYTES = 8 * 1024;
/** Retention maintenance is intentionally not on every post-response batch. */
export const DASHBOARD_TIMING_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Bound a hot dashboard's count overshoot without a delete on every flush. */
export const DASHBOARD_TIMING_PRUNE_BATCH_RECORDS = 512;

type TimingSource = "server" | "client";

const SERVER_LABELS = [
  "dashboard_config",
  "mesh_threads",
  "mesh_actor_charter",
  "mesh_actor_detail",
  "mesh_actor_activity",
  "mesh_actor_chat",
  "mesh_actor_inbox",
  "mesh_actor_list",
  "mesh_actor_mutation",
  "mesh_obligations",
  "mesh_obligation_detail",
  "mesh_obligation_tree",
  "mesh_obligation_forest",
  "mesh_obligation_mutation",
  "mesh_events",
  "mesh_quota",
  "mesh_stream_open",
  "mesh_stream_close",
  "api_other",
] as const;

const CLIENT_LABELS = [
  "initial_load",
  "primary_navigation",
  "actor_detail",
  "obligation_detail",
  "obligation_status",
  "obligation_snooze",
  "actor_interrupt",
  "dashboard_mutation",
] as const;

export type DashboardTimingLabel = (typeof SERVER_LABELS)[number] | (typeof CLIENT_LABELS)[number];

export interface DashboardTimingPayload {
  v: 1;
  source: TimingSource;
  label: DashboardTimingLabel;
  /** A random UUID, never a user, actor, obligation, URL, or query identifier. */
  requestId?: string;
  /** The bounded set of server request UUIDs included in one client interaction. */
  requestIds?: string[];
  durationMs: number | null;
  status: number | null;
  bytes: number | null;
  /** Client-declared interaction result; server observations leave this null. */
  outcome: "success" | "failure" | null;
}

export interface DashboardClientTimingInput {
  interaction: (typeof CLIENT_LABELS)[number];
  durationMs: number;
  requestIds: string[];
  outcome?: "success" | "failure";
}

interface TimingEventStore {
  record(opts: Parameters<MeshEventRepository["record"]>[0]): string;
  listByKindSince(kind: string, sinceISO: string, limit: number): MeshEvent[];
  pruneKind(kind: string, olderThanISO: string, maxRecords: number): void;
}

function isFiniteMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 86_400_000;
}

function isHttpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599;
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function hasLabel(value: unknown, labels: readonly string[]): value is DashboardTimingLabel {
  return typeof value === "string" && labels.includes(value);
}

export function isDashboardTimingLabel(value: unknown): value is DashboardTimingLabel {
  return hasLabel(value, SERVER_LABELS) || hasLabel(value, CLIENT_LABELS);
}

/** Fixed path templates only: request URLs and query strings never become telemetry. */
export function dashboardTimingLabelForRoute(
  pathname: string,
  method: string
): DashboardTimingLabel | null {
  const isRead = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (pathname === "/api/dashboard/timing") return null;
  if (pathname === "/api/health") return null;
  if (pathname === "/api/dashboard/config") return "dashboard_config";
  if (pathname === "/api/mesh/threads") return "mesh_threads";
  if (pathname === "/api/mesh/threads/charter") return "mesh_actor_charter";
  if (pathname === "/api/mesh/recent-activity") return "mesh_actor_activity";
  if (pathname === "/api/mesh/chat") return "mesh_actor_chat";
  if (pathname === "/api/mesh/inbox") return "mesh_actor_inbox";
  if (pathname === "/api/mesh/events") return "mesh_events";
  if (pathname === "/api/quota" || pathname === "/api/quota/history") return "mesh_quota";
  if (pathname === "/api/mesh/stream") return "mesh_stream_open";
  if (pathname === "/api/mesh/obligations")
    return isRead ? "mesh_obligations" : "mesh_obligation_mutation";
  if (pathname === "/api/mesh/obligations/forest") return "mesh_obligation_forest";
  if (/^\/api\/mesh\/obligations\/[^/]+\/tree$/.test(pathname)) return "mesh_obligation_tree";
  if (/^\/api\/mesh\/obligations\/[^/]+$/.test(pathname)) return "mesh_obligation_detail";
  if (
    /^\/api\/mesh\/obligations\/[^/]+\/(status|snooze|external-ref|reorder|reparent|reassign)$/.test(
      pathname
    )
  ) {
    return "mesh_obligation_mutation";
  }
  if (/^\/api\/mesh\/actors\/[^/]+\/chat$/.test(pathname)) return "mesh_actor_chat";
  if (/^\/api\/mesh\/actors\/[^/]+\/inbox$/.test(pathname)) return "mesh_actor_inbox";
  if (/^\/api\/mesh\/actors\/[^/]+$/.test(pathname)) return "mesh_actor_detail";
  if (pathname === "/api/mesh/actors") return isRead ? "mesh_actor_list" : "mesh_actor_mutation";
  if (/^\/api\/mesh\/actors\b/.test(pathname)) return "mesh_actor_mutation";
  return pathname.startsWith("/api/") ? "api_other" : null;
}

export function parseDashboardClientTiming(input: unknown): DashboardClientTimingInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (
    !Object.keys(value).every((key) =>
      ["interaction", "durationMs", "requestIds", "outcome"].includes(key)
    )
  ) {
    return null;
  }
  if (!hasLabel(value.interaction, CLIENT_LABELS) || !isFiniteMilliseconds(value.durationMs))
    return null;
  if (!Array.isArray(value.requestIds) || value.requestIds.length > DASHBOARD_TIMING_MAX_CLIENT_IDS)
    return null;
  if (!value.requestIds.every(isUuid)) return null;
  if (value.outcome !== undefined && value.outcome !== "success" && value.outcome !== "failure")
    return null;
  return {
    interaction: value.interaction as DashboardClientTimingInput["interaction"],
    durationMs: Math.round(value.durationMs),
    requestIds: [...new Set(value.requestIds)],
    ...(value.outcome ? { outcome: value.outcome } : {}),
  };
}

function parsePayload(event: MeshEvent): DashboardTimingPayload | null {
  if (event.kind !== DASHBOARD_TIMING_EVENT_KIND || typeof event.payload !== "string") return null;
  try {
    const value = JSON.parse(event.payload) as Record<string, unknown>;
    const durationMs = value.durationMs;
    const status = value.status;
    const bytes = value.bytes;
    const outcome = value.outcome;
    const requestId = value.requestId;
    const requestIds = value.requestIds;
    if (
      value.v !== 1 ||
      (value.source !== "server" && value.source !== "client") ||
      !isDashboardTimingLabel(value.label) ||
      (requestId !== undefined && !isUuid(requestId)) ||
      (requestIds !== undefined &&
        (!Array.isArray(requestIds) ||
          requestIds.length > DASHBOARD_TIMING_MAX_CLIENT_IDS ||
          !requestIds.every(isUuid))) ||
      (durationMs !== null && !isFiniteMilliseconds(durationMs)) ||
      (status !== null && !isHttpStatus(status)) ||
      (bytes !== null && !isByteCount(bytes)) ||
      (outcome !== null && outcome !== "success" && outcome !== "failure") ||
      (value.source === "server" && outcome !== null) ||
      (value.source === "client" && status !== null)
    ) {
      return null;
    }
    return {
      v: 1,
      source: value.source,
      label: value.label,
      ...(requestId ? { requestId } : {}),
      ...(requestIds ? { requestIds } : {}),
      durationMs,
      status,
      bytes,
      outcome,
    };
  } catch {
    return null;
  }
}

interface QueuedTiming {
  ts: string;
  payload: DashboardTimingPayload;
}

/**
 * A post-response, bounded writer. The caller only queues fixed metadata; the
 * SQLite write happens on the next event-loop turn after the response has
 * finished.
 */
export class DashboardTimingRecorder {
  private readonly queue: QueuedTiming[] = [];
  private flushScheduled = false;
  private flushHandle: ReturnType<typeof setImmediate> | undefined;
  private stopped = false;
  private dropped = 0;
  private lastPrunedAt: number | undefined;
  private recordedSincePrune = 0;

  constructor(
    private readonly events: TimingEventStore,
    private readonly now = () => new Date()
  ) {}

  start(): void {
    if (this.stopped) return;
    this.prune();
  }

  /** Drain the bounded queue while the repository is still live at shutdown. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushHandle) clearImmediate(this.flushHandle);
    this.flushHandle = undefined;
    this.flushScheduled = false;
    while (this.queue.length > 0) this.flush();
  }

  get droppedCount(): number {
    return this.dropped;
  }

  recordServer(input: {
    label: DashboardTimingLabel;
    requestId?: string;
    durationMs: number | null;
    status: number | null;
    bytes: number | null;
  }): void {
    this.enqueue({
      v: 1,
      source: "server",
      label: input.label,
      ...(input.requestId ? { requestId: input.requestId } : {}),
      durationMs: input.durationMs == null ? null : Math.round(input.durationMs),
      status: input.status,
      bytes: input.bytes,
      outcome: null,
    });
  }

  recordClient(input: DashboardClientTimingInput): void {
    this.enqueue({
      v: 1,
      source: "client",
      label: input.interaction,
      requestIds: input.requestIds,
      durationMs: input.durationMs,
      status: null,
      bytes: null,
      outcome: input.outcome ?? null,
    });
  }

  /** Exposed for deterministic shutdown/tests; normal callers flush next turn. */
  flush(): void {
    if (this.flushHandle) clearImmediate(this.flushHandle);
    this.flushHandle = undefined;
    this.flushScheduled = false;
    const batch = this.queue.splice(0, 64);
    try {
      for (const entry of batch) {
        this.events.record({
          kind: DASHBOARD_TIMING_EVENT_KIND,
          actorId: null,
          detail: `${entry.payload.source}:${entry.payload.label}`,
          payload: JSON.stringify(entry.payload),
          ts: entry.ts,
        });
      }
      // Retention does not belong on every post-response batch. The periodic
      // maintenance still preserves the age/count bound without making a
      // busy dashboard pay a delete query after each flush.
      if (batch.length > 0) {
        this.recordedSincePrune += batch.length;
        this.maybePrune();
      }
    } catch {
      // Telemetry cannot take down the service after its response has already
      // completed. The aggregate exposes this conservative loss count.
      this.dropped += batch.length;
    }
    if (this.queue.length > 0) this.scheduleFlush();
  }

  summary(opts: { since: Date; label?: DashboardTimingLabel }): DashboardTimingSummary {
    const since = opts.since.toISOString();
    const allRows = this.events
      .listByKindSince(DASHBOARD_TIMING_EVENT_KIND, since, DASHBOARD_TIMING_MAX_RECORDS)
      .flatMap((event) => {
        const payload = parsePayload(event);
        return payload ? [{ event, payload }] : [];
      });
    const rows =
      opts.label === undefined
        ? allRows
        : allRows.filter(({ payload }) => payload.label === opts.label);
    // A filtered client interaction is compared against the whole server
    // population; otherwise filtering `initial_load` erases every server ID
    // and turns coverage into a meaningless zero. This is coverage only, not
    // a joined latency or client-phase analysis.
    const correlationRows =
      opts.label !== undefined &&
      CLIENT_LABELS.includes(opts.label as (typeof CLIENT_LABELS)[number])
        ? allRows.filter(
            ({ payload }) => payload.source === "server" || payload.label === opts.label
          )
        : rows;
    return summarize(rows, correlationRows, since, this.dropped);
  }

  private enqueue(payload: DashboardTimingPayload): void {
    if (this.stopped) {
      this.dropped += 1;
      return;
    }
    if (this.queue.length >= DASHBOARD_TIMING_MAX_QUEUE) {
      this.dropped += 1;
      return;
    }
    this.queue.push({ ts: this.now().toISOString(), payload });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.stopped || this.flushScheduled) return;
    this.flushScheduled = true;
    // Do not let a SQLite write run in the response's microtask checkpoint:
    // `setImmediate` runs after the current poll turn has returned the reply.
    this.flushHandle = setImmediate(() => {
      this.flushHandle = undefined;
      this.flush();
    });
  }

  private prune(): void {
    this.events.pruneKind(
      DASHBOARD_TIMING_EVENT_KIND,
      new Date(this.now().getTime() - DASHBOARD_TIMING_RETENTION_MS).toISOString(),
      DASHBOARD_TIMING_MAX_RECORDS
    );
    this.lastPrunedAt = this.now().getTime();
    this.recordedSincePrune = 0;
  }

  private maybePrune(): void {
    const now = this.now().getTime();
    if (
      this.lastPrunedAt === undefined ||
      now - this.lastPrunedAt >= DASHBOARD_TIMING_PRUNE_INTERVAL_MS ||
      this.recordedSincePrune >= DASHBOARD_TIMING_PRUNE_BATCH_RECORDS
    ) {
      this.prune();
    }
  }
}

export interface DashboardTimingGroup {
  source: TimingSource;
  label: DashboardTimingLabel;
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  statusBuckets: Record<string, number>;
  outcomeBuckets: Record<"success" | "failure", number>;
  flagged: boolean;
}

export interface DashboardTimingSummary {
  since: string;
  sampleCount: number;
  droppedSinceStart: number;
  clientServerCoverage: {
    clientRequestIds: number;
    serverRequestIds: number;
    matchedRequestIds: number;
  };
  groups: DashboardTimingGroup[];
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1] ?? null;
}

function thresholdFor(source: TimingSource, label: DashboardTimingLabel): number {
  if (source === "server") return 500;
  if (label === "initial_load") return 2_000;
  if (
    label === "obligation_status" ||
    label === "obligation_snooze" ||
    label === "actor_interrupt" ||
    label === "dashboard_mutation"
  ) {
    return 1_000;
  }
  return 500;
}

function summarize(
  rows: Array<{ event: MeshEvent; payload: DashboardTimingPayload }>,
  correlationRows: Array<{ event: MeshEvent; payload: DashboardTimingPayload }>,
  since: string,
  droppedSinceStart: number
): DashboardTimingSummary {
  const groups = new Map<
    string,
    {
      payload: DashboardTimingPayload;
      durations: number[];
      statuses: Map<string, number>;
      outcomes: Map<"success" | "failure", number>;
      count: number;
    }
  >();
  const serverRequestIds = new Set<string>();
  const clientRequestIds = new Set<string>();
  for (const { payload } of rows) {
    const key = `${payload.source}:${payload.label}`;
    const group = groups.get(key) ?? {
      payload,
      durations: [] as number[],
      statuses: new Map<string, number>(),
      outcomes: new Map<"success" | "failure", number>(),
      count: 0,
    };
    group.count += 1;
    if (payload.durationMs !== null) group.durations.push(payload.durationMs);
    if (payload.status !== null)
      group.statuses.set(
        `${Math.floor(payload.status / 100)}xx`,
        (group.statuses.get(`${Math.floor(payload.status / 100)}xx`) ?? 0) + 1
      );
    if (payload.outcome !== null)
      group.outcomes.set(payload.outcome, (group.outcomes.get(payload.outcome) ?? 0) + 1);
    groups.set(key, group);
  }
  for (const { payload } of correlationRows) {
    if (payload.source === "server" && payload.requestId) serverRequestIds.add(payload.requestId);
    if (payload.source === "client")
      for (const id of payload.requestIds ?? []) clientRequestIds.add(id);
  }
  const matchedRequestIds = [...clientRequestIds].filter((id) => serverRequestIds.has(id)).length;
  return {
    since,
    sampleCount: rows.length,
    droppedSinceStart,
    clientServerCoverage: {
      clientRequestIds: clientRequestIds.size,
      serverRequestIds: serverRequestIds.size,
      matchedRequestIds,
    },
    groups: [...groups.values()]
      .map((group) => {
        const p95Ms = percentile(group.durations, 95);
        return {
          source: group.payload.source,
          label: group.payload.label,
          count: group.count,
          p50Ms: percentile(group.durations, 50),
          p95Ms,
          p99Ms: percentile(group.durations, 99),
          maxMs: group.durations.length ? Math.max(...group.durations) : null,
          statusBuckets: Object.fromEntries(group.statuses),
          outcomeBuckets: {
            success: group.outcomes.get("success") ?? 0,
            failure: group.outcomes.get("failure") ?? 0,
          },
          flagged:
            group.count >= 20 &&
            p95Ms !== null &&
            p95Ms >= thresholdFor(group.payload.source, group.payload.label),
        };
      })
      .sort((a, b) => a.source.localeCompare(b.source) || a.label.localeCompare(b.label)),
  };
}

/** Generate the only server correlation identifier we accept. */
export function createDashboardRequestId(): string {
  return randomUUID();
}
