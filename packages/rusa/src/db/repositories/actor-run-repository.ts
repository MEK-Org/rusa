import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ActorRunOutcome = "completed" | "abandoned";

export interface ActorRun {
  id: string;
  actorId: string;
  startedAt: string;
  endedAt: string | null;
  outcome: ActorRunOutcome | null;
  success: boolean | null;
  exitCode: number | null;
  output: string | null;
  yieldStatus: string | null;
  yieldNote: string | null;
  yieldedAt: string | null;
  provider: string | null;
  model: string | null;
  abandonReason: string | null;
}

interface ActorRunRow {
  id: string;
  actor_id: string;
  started_at: string;
  ended_at: string | null;
  outcome: ActorRunOutcome | null;
  success: number | null;
  exit_code: number | null;
  output: string | null;
  yield_status: string | null;
  yield_note: string | null;
  yielded_at: string | null;
  provider: string | null;
  model: string | null;
  abandon_reason: string | null;
}

export type PortableLedgerSourceKind = "message_received" | "run_yielded";

/** A compactor input backed by a durable entity, not an observability event. */
export interface PortableLedgerSource {
  id: string;
  ts: string;
  kind: PortableLedgerSourceKind;
  actorId: string;
  detail: string | null;
  body: string | null;
  payload: string | null;
  success: null;
}

interface PortableLedgerSourceRow {
  id: string;
  ts: string;
  kind: PortableLedgerSourceKind;
  actor_id: string;
  detail: string | null;
  body: string | null;
  payload: string | null;
  source_order: number;
}

interface SourceCursor {
  id: string;
  ts: string;
  source_order: number;
}

/** Match the historical run_end capture bound while moving authority off the event log. */
export const ACTOR_RUN_OUTPUT_MAX_CHARS = 40_000;

export function captureRunOutput(output: string | null | undefined): string | null {
  if (output == null) return null;
  if (output.length <= ACTOR_RUN_OUTPUT_MAX_CHARS) return output;
  const dropped = output.length - ACTOR_RUN_OUTPUT_MAX_CHARS;
  return `… [${dropped.toLocaleString()} earlier chars truncated]\n${output.slice(-ACTOR_RUN_OUTPUT_MAX_CHARS)}`;
}

/** Durable lifecycle/output storage plus the portable ledger's cross-store read model. */
export class ActorRunRepository {
  constructor(private readonly db: Database.Database) {}

  start(opts: {
    id?: string;
    actorId: string;
    startedAt?: string;
    provider?: string | null;
  }): string {
    const id = opts.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO actor_runs (id, actor_id, started_at, provider)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, opts.actorId, opts.startedAt ?? new Date().toISOString(), opts.provider ?? null);
    return id;
  }

  recordYield(id: string, status: string, note?: string, yieldedAt?: string): void {
    const result = this.db
      .prepare(
        `UPDATE actor_runs
         SET yield_status = ?, yield_note = ?, yielded_at = ?
         WHERE id = ? AND outcome IS NULL`
      )
      .run(status, note?.trim() ? note : null, yieldedAt ?? new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error(`active actor run not found: ${id}`);
  }

  complete(
    id: string,
    opts: {
      endedAt?: string;
      success: boolean;
      exitCode: number;
      output: string;
      yieldStatus?: string;
      yieldNote?: string;
      model?: string | null;
    }
  ): void {
    const endedAt = opts.endedAt ?? new Date().toISOString();
    const yieldNote = opts.yieldNote?.trim() ? opts.yieldNote : null;
    const result = this.db
      .prepare(
        `UPDATE actor_runs
         SET ended_at = ?, outcome = 'completed', success = ?, exit_code = ?, output = ?,
             yield_status = COALESCE(?, yield_status),
             yield_note = COALESCE(?, yield_note),
             yielded_at = CASE
               WHEN COALESCE(?, yield_status) IS NOT NULL THEN COALESCE(yielded_at, ?)
               ELSE yielded_at
             END,
             model = ?
         WHERE id = ? AND outcome IS NULL`
      )
      .run(
        endedAt,
        opts.success ? 1 : 0,
        opts.exitCode,
        captureRunOutput(opts.output),
        opts.yieldStatus ?? null,
        yieldNote,
        opts.yieldStatus ?? null,
        endedAt,
        opts.model ?? null,
        id
      );
    if (result.changes !== 1) throw new Error(`active actor run not found: ${id}`);
  }

  abandon(id: string, reason: string, endedAt?: string): void {
    const result = this.db
      .prepare(
        `UPDATE actor_runs
         SET ended_at = ?, outcome = 'abandoned', abandon_reason = ?
         WHERE id = ? AND outcome IS NULL`
      )
      .run(endedAt ?? new Date().toISOString(), reason, id);
    if (result.changes !== 1) throw new Error(`active actor run not found: ${id}`);
  }

  /** Close runs left open by a prior process before admitting new work. */
  abandonOpen(reason: string, endedAt = new Date().toISOString()): number {
    return this.db
      .prepare(
        `UPDATE actor_runs
         SET ended_at = ?, outcome = 'abandoned', abandon_reason = ?
         WHERE outcome IS NULL`
      )
      .run(endedAt, reason).changes;
  }

  getById(id: string): ActorRun | null {
    const row = this.db.prepare(`SELECT * FROM actor_runs WHERE id = ?`).get(id) as
      | ActorRunRow
      | undefined;
    return row ? toActorRun(row) : null;
  }

  /** Completed run outputs, newest first, for the bounded portable tail. */
  listRecentCompleted(actorId: string, limit: number): ActorRun[] {
    assertLimit(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM actor_runs
         WHERE actor_id = ? AND outcome = 'completed'
         ORDER BY ended_at DESC, id DESC
         LIMIT ?`
      )
      .all(actorId, limit) as ActorRunRow[];
    return rows.map(toActorRun);
  }

  /**
   * Interleave received chat and self-authored yield notes oldest first.
   *
   * `afterSourceId` normally names a mesh_chat row or actor_run row. During the
   * v2→v3 file migration it may briefly name the old message_received/run_yielded
   * event; the migration-retained ids resolve that cursor without reading event
   * prose or making the event table authoritative again.
   */
  listLedgerSourcesAfter(
    actorId: string,
    afterSourceId: string | null,
    limit = 50
  ): { sources: PortableLedgerSource[]; hasMore: boolean } {
    if (limit <= 0) return { sources: [], hasMore: false };
    assertLimit(limit);
    const cursor = afterSourceId ? this.resolveSourceCursor(actorId, afterSourceId) : null;
    if (afterSourceId && !cursor) {
      throw new Error(`portable-context durable source not found: ${afterSourceId}`);
    }

    const params: Array<string | number> = [actorId, actorId];
    let after = "";
    if (cursor) {
      after = `WHERE (
        ts > ? OR
        (ts = ? AND source_order > ?) OR
        (ts = ? AND source_order = ? AND id > ?)
      )`;
      params.push(
        cursor.ts,
        cursor.ts,
        cursor.source_order,
        cursor.ts,
        cursor.source_order,
        cursor.id
      );
    }
    params.push(limit + 1);
    const rows = this.db
      .prepare(
        `WITH durable_sources AS (
           SELECT id, ts, 'message_received' AS kind, recipient_id AS actor_id,
                  session_id AS detail, body,
                  json_object('messageId', id, 'from', sender_id) AS payload,
                  0 AS source_order
           FROM mesh_chat
           WHERE recipient_id = ?
           UNION ALL
           SELECT id, yielded_at AS ts, 'run_yielded' AS kind, actor_id,
                  yield_status AS detail, yield_note AS body, NULL AS payload,
                  1 AS source_order
           FROM actor_runs
           WHERE actor_id = ? AND yielded_at IS NOT NULL AND yield_note IS NOT NULL
         )
         SELECT * FROM durable_sources
         ${after}
         ORDER BY ts ASC, source_order ASC, id ASC
         LIMIT ?`
      )
      .all(...params) as PortableLedgerSourceRow[];
    return {
      sources: rows.slice(0, limit).map(toPortableLedgerSource),
      hasMore: rows.length > limit,
    };
  }

  private resolveSourceCursor(actorId: string, sourceId: string): SourceCursor | null {
    const row = this.db
      .prepare(
        `SELECT id, ts, source_order
         FROM (
           SELECT id, ts, 0 AS source_order
           FROM mesh_chat
           WHERE recipient_id = ? AND (id = ? OR received_event_id = ?)
           UNION ALL
           SELECT id, yielded_at AS ts, 1 AS source_order
           FROM actor_runs
           WHERE actor_id = ? AND yielded_at IS NOT NULL
             AND (id = ? OR legacy_yield_event_id = ?)
         )
         ORDER BY source_order ASC
         LIMIT 1`
      )
      .get(actorId, sourceId, sourceId, actorId, sourceId, sourceId) as SourceCursor | undefined;
    return row ?? null;
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("actor run limit must be between 1 and 100");
  }
}

function toActorRun(row: ActorRunRow): ActorRun {
  return {
    id: row.id,
    actorId: row.actor_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    success: row.success === null ? null : row.success === 1,
    exitCode: row.exit_code,
    output: row.output,
    yieldStatus: row.yield_status,
    yieldNote: row.yield_note,
    yieldedAt: row.yielded_at,
    provider: row.provider,
    model: row.model,
    abandonReason: row.abandon_reason,
  };
}

function toPortableLedgerSource(row: PortableLedgerSourceRow): PortableLedgerSource {
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    actorId: row.actor_id,
    detail: row.detail,
    body: row.body,
    payload: row.payload,
    success: null,
  };
}
