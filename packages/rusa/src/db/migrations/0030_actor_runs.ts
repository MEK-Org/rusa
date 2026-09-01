import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

interface LifecycleEventRow {
  id: string;
  rowid: number;
  ts: string;
  kind: string;
  actor_id: string | null;
  detail: string | null;
  body: string | null;
  payload: string | null;
  success: number | null;
}

interface OpenRun {
  start: LifecycleEventRow;
  yieldEvent?: LifecycleEventRow;
}

function hasColumns(db: Database, table: string, required: readonly string[]): boolean {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (column) => column.name
    )
  );
  return required.every((column) => present.has(column));
}

function jsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringField(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function exitCode(detail: string | null): number | null {
  const match = /^exit (-?\d+)$/.exec(detail ?? "");
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Give actor behaviour a durable run journal.
 *
 * `mesh_events` remains the append-only observability trail, but it is explicitly
 * disposable. Portable context therefore reads completed outputs and self-authored
 * yield notes from `actor_runs`, and inbound messages from `mesh_chat`.
 *
 * Existing rows are backfilled in lifecycle order. The legacy event ids retained
 * on chat/yield sources are upgrade cursors only: a v2 portable-context file may
 * still name one until its first post-upgrade fold advances onto a durable source id.
 */
export const actorRuns: Migration = {
  id: "0030_actor_runs",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE actor_runs (
        id                    TEXT PRIMARY KEY,
        actor_id              TEXT NOT NULL,
        started_at            TEXT NOT NULL,
        ended_at              TEXT,
        outcome               TEXT CHECK (outcome IN ('completed', 'abandoned')),
        success               INTEGER CHECK (success IN (0, 1)),
        exit_code             INTEGER,
        output                TEXT,
        yield_status          TEXT,
        yield_note            TEXT,
        yielded_at            TEXT,
        provider              TEXT,
        model                 TEXT,
        abandon_reason        TEXT,
        legacy_yield_event_id TEXT
      );
      CREATE INDEX idx_actor_runs_actor_ended
        ON actor_runs(actor_id, ended_at DESC, id DESC);
      CREATE INDEX idx_actor_runs_actor_yielded
        ON actor_runs(actor_id, yielded_at, id)
        WHERE yielded_at IS NOT NULL;
      CREATE UNIQUE INDEX idx_actor_runs_legacy_yield_event
        ON actor_runs(legacy_yield_event_id)
        WHERE legacy_yield_event_id IS NOT NULL;

      ALTER TABLE mesh_chat ADD COLUMN received_event_id TEXT;
      CREATE UNIQUE INDEX idx_mesh_chat_received_event
        ON mesh_chat(received_event_id)
        WHERE received_event_id IS NOT NULL;

      UPDATE mesh_chat
      SET received_event_id = (
        SELECT e.id
        FROM mesh_events e
        WHERE e.kind = 'message_received'
          AND json_extract(
            CASE WHEN json_valid(e.payload) THEN e.payload ELSE '{}' END,
            '$.messageId'
          ) = mesh_chat.id
        ORDER BY e.rowid DESC
        LIMIT 1
      );
    `);

    // Hand-built pre-migration databases may carry only the runner's minimum
    // legacy columns. They have no run bodies to preserve, but still need the
    // new empty subsystem to initialize cleanly.
    if (
      !hasColumns(db, "mesh_events", [
        "id",
        "ts",
        "kind",
        "actor_id",
        "detail",
        "body",
        "payload",
        "success",
      ])
    ) {
      return;
    }

    const events = db
      .prepare(
        `SELECT rowid, id, ts, kind, actor_id, detail, body, payload, success
         FROM mesh_events
         WHERE kind IN ('run_start', 'run_yielded', 'run_end', 'run_abandoned')
         ORDER BY rowid ASC`
      )
      .all() as LifecycleEventRow[];
    const open = new Map<string, OpenRun>();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO actor_runs
        (id, actor_id, started_at, ended_at, outcome, success, exit_code, output,
         yield_status, yield_note, yielded_at, provider, model, abandon_reason,
         legacy_yield_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const event of events) {
      const actorId = event.actor_id;
      if (!actorId) continue;
      if (event.kind === "run_start") {
        open.set(actorId, { start: event });
        continue;
      }
      if (event.kind === "run_yielded") {
        const run = open.get(actorId);
        if (run) run.yieldEvent = event;
        continue;
      }
      const run = open.get(actorId);
      const start = run?.start;
      const startPayload = jsonObject(start?.payload ?? null);
      const endPayload = jsonObject(event.payload);
      if (event.kind === "run_abandoned" && endPayload.started === false) continue;
      const yielded = run?.yieldEvent;
      const completed = event.kind === "run_end";
      insert.run(
        event.id,
        actorId,
        start?.ts ?? event.ts,
        event.ts,
        completed ? "completed" : "abandoned",
        completed && event.success !== null ? event.success : null,
        completed ? exitCode(event.detail) : null,
        completed ? event.body : null,
        completed ? (stringField(endPayload, "yieldStatus") ?? yielded?.detail ?? null) : null,
        completed ? (yielded?.body ?? null) : null,
        completed ? (yielded?.ts ?? null) : null,
        stringField(startPayload, "provider"),
        completed ? stringField(endPayload, "model") : null,
        completed ? null : event.detail,
        completed ? (yielded?.id ?? null) : null
      );
      open.delete(actorId);
    }
  },
};
