import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

// The set of event kinds is authored once, in the actor layer (which owns the
// observability seam and has no db dependency); the repository re-exports it so
// producers and this reader can't drift. A failed run is a `run_end` with
// `success: false` — there is no separate failure kind here (failure
// *forwarding* is the failure-sink's job). This is a type-only import: no
// runtime coupling from db → actor.
import type { MeshEventKind } from "../../actor/mesh-events.js";
export type { MeshEventKind };

/** An appended mesh event (camelCase domain object). */
export interface MeshEvent<TPayload = string | null> {
  id: string;
  /** Wall-clock stamp for display (ISO-8601). */
  ts: string;
  kind: MeshEventKind | string;
  /** The subject actor: the one running, the message *recipient*, the spawned/retired thread. */
  actorId: string | null;
  /** Short human-readable summary (a reason, a charter excerpt, a role). */
  detail: string | null;
  /** Heavy payload: a run's output (may be a tail). */
  body: string | null;
  /** JSON payload (e.g. {messageId, to} for message_sent). */
  payload: TPayload;
  /** Run outcome for `run_end`; null for non-run events. */
  success: boolean | null;
}

interface MeshEventRow {
  id: string;
  ts: string;
  kind: string;
  actor_id: string | null;
  detail: string | null;
  body: string | null;
  payload: string | null;
  success: number | null;
}

/**
 * A page of events ordered newest-first. `nextCursor` is an opaque rowid to pass
 * back as `before` to fetch the next (older) page; `null` means no more rows.
 */
export interface EventPage {
  events: MeshEvent[];
  nextCursor: number | null;
}

export interface RunStartPayload {
  provider: string;
  responsive: boolean;
}

export interface RunStartEvent extends MeshEvent<RunStartPayload> {
  kind: "run_start";
}

/**
 * The event kinds portable context  folds into an actor's durable ledger,
 * each tagged with who authored it. One table, so the SQL filter and the
 * provenance rule can never drift apart.
 *
 * `run_yielded` is the actor's own end-of-run self-summary — the "structured
 * end-of-run self-summary carried in the yield/report contract" the design note
 * prescribes, already durable in the log. It is deliberately NOT `run_end`:
 * a run_end body is the whole narration stream (measured across the live log:
 * 9,546 events, ~11.9KB average, clamped at {@link MAX_BODY_CHARS}), i.e. the
 * provider-transcript-shaped input v1 is supposed to stay away from, whereas a
 * yield note is the distilled outcome (8,491 events, ~536B average) and carries
 * a complete/blocked `detail` the compactor can discriminate on. The ~11% of
 * runs that end without yielding contribute nothing, which is correct: a run
 * that died mid-flight has no trustworthy self-summary.
 */
const PORTABLE_CONTEXT_SOURCE_KINDS: Record<string, "inbound" | "self"> = {
  message_received: "inbound",
  run_yielded: "self",
};

/**
 * True when the actor itself authored events of this kind, so evidence drawn
 * from one must be attributed to the actor rather than left as "unknown" —
 * see the sender rule in `portable-context-compactor.ts`.
 */
export function isSelfAuthoredLedgerSource(kind: string): boolean {
  return PORTABLE_CONTEXT_SOURCE_KINDS[kind] === "self";
}

/** Largest body we persist per event; longer text is tail-truncated. */
const MAX_BODY_CHARS = 40_000;

function clampBody(body: string | null | undefined): string | null {
  if (body == null) return null;
  if (body.length <= MAX_BODY_CHARS) return body;
  const dropped = body.length - MAX_BODY_CHARS;
  // Keep the tail — for a run that's the result/summary, the most useful part.
  return `… [${dropped.toLocaleString()} earlier chars truncated]\n${body.slice(-MAX_BODY_CHARS)}`;
}

/** Append-only data access for the `mesh_events` table. */
export class MeshEventRepository {
  constructor(private readonly db: Database.Database) {}

  /** Append a single event to the log and return its generated id. */
  record(opts: {
    id?: string;
    kind: MeshEventKind | string;
    actorId?: string | null;
    detail?: string | null;
    body?: string | null;
    payload?: string | null;
    success?: boolean | null;
    /** Override the stamp (tests); defaults to now. */
    ts?: string;
  }): string {
    const id = opts.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO mesh_events (id, ts, kind, actor_id, detail, body, payload, success)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        opts.ts ?? new Date().toISOString(),
        opts.kind,
        opts.actorId ?? null,
        opts.detail ?? null,
        clampBody(opts.body),
        opts.payload ?? null,
        opts.success == null ? null : opts.success ? 1 : 0
      );
    return id;
  }

  /** Get the maximum rowid currently in the table, for O(1) cache invalidation. */
  getMaxRowid(): number {
    const row = this.db.prepare("SELECT MAX(rowid) as m FROM mesh_events").get() as {
      m: number | null;
    };
    return row.m ?? 0;
  }

  list(): MeshEvent[] {
    const rows = this.db
      .prepare(`
        SELECT e.*, c.body as chat_body 
        FROM mesh_events e
        LEFT JOIN mesh_chat c ON json_extract(e.payload, '$.messageId') = c.id
        ORDER BY e.rowid ASC
      `)
      .all() as (MeshEventRow & { chat_body?: string | null })[];
    return rows.map(toMeshEvent);
  }

  /**
   * Events of the given `kinds`, oldest-first, with `body` populated only for
   * `bodyKinds`. Every other event's body comes back `null` — not because it is
   * missing, but because the caller said it does not read it.
   *
   * For a reader that folds over the whole history, that second half is the
   * expensive one. `mesh_events` on the live mesh is 70 MB of leaf pages plus
   * 120 MB of overflow pages, and the overflow is almost entirely run
   * transcripts on `run_end` — 138 MB that {@link list} materialises into JS
   * strings on every call and that the commitment ledger, its only whole-history
   * reader, never looks at. Measured on that database through the actor list's
   * cache miss, which is the ledger's one hot caller: 1748 ms and +511 MB RSS
   * with {@link list}, 763 ms and +77 MB with this read, for a byte-identical
   * response.
   *
   * Body resolution is unchanged — `body` and the `mesh_chat` join are selected
   * together for `bodyKinds` and resolved by {@link toMeshEvent}, so a
   * spine-participating event still reads its prose from `mesh_chat` alone and
   * never rescues a stale `mesh_events.body`.
   */
  listByKinds(kinds: readonly string[], opts: { bodyKinds: readonly string[] }): MeshEvent[] {
    if (kinds.length === 0) return [];
    const kindHoles = kinds.map(() => "?").join(",");
    // An empty body set is a legitimate ask ("none of them"), and `IN ()` is a
    // syntax error, so say it as a constant instead of building empty holes.
    const wantsBody =
      opts.bodyKinds.length === 0 ? "0" : `e.kind IN (${opts.bodyKinds.map(() => "?").join(",")})`;
    const rows = this.db
      .prepare(`
        SELECT e.id, e.ts, e.kind, e.actor_id, e.detail, e.success, e.payload,
               CASE WHEN ${wantsBody} THEN e.body END AS body,
               CASE WHEN ${wantsBody} THEN c.body END AS chat_body
        FROM mesh_events e
        LEFT JOIN mesh_chat c ON json_extract(e.payload, '$.messageId') = c.id
        WHERE e.kind IN (${kindHoles})
        ORDER BY e.rowid ASC
      `)
      .all(...opts.bodyKinds, ...opts.bodyKinds, ...kinds) as (MeshEventRow & {
      chat_body?: string | null;
    })[];
    return rows.map(toMeshEvent);
  }

  /**
   * Forward, all-actors **windowed** scan — the nightly distiller's mesh_events read
   * (ISSUE_NUM phase 2a), served via `GET /api/mesh/events?since=&until=`. Events in the
   * half-open window `[sinceISO, untilISO)` (`untilISO` optional — omitted = open-
   * ended, today's behavior), oldest-first (ISO sorts chronologically; `rowid`
   * breaks ties), capped at `limit`. `hasMore` is true when more matched than
   * `limit`. The `until` upper bound lets the distiller fix an **atomic window** at
   * run start so a run never sees events that stream in mid-run (Operator's atomicity
   * point). Unlike {@link listEventsByActors} this spans ALL actors + reads forward.
   */
  listEventsSince(
    sinceISO: string,
    limit: number,
    untilISO?: string,
    kinds?: string[],
    order: "asc" | "desc" = "asc"
  ): { events: MeshEvent[]; hasMore: boolean } {
    if (limit <= 0) return { events: [], hasMore: false };
    const params: (string | number)[] = [sinceISO];
    let sql = `
      SELECT e.*, c.body as chat_body 
      FROM mesh_events e
      LEFT JOIN mesh_chat c ON json_extract(e.payload, '$.messageId') = c.id
      WHERE e.ts >= ?
    `;
    if (untilISO != null) {
      sql += ` AND e.ts < ?`;
      params.push(untilISO);
    }
    if (kinds && kinds.length > 0) {
      sql += ` AND e.kind IN (${kinds.map(() => "?").join(", ")})`;
      params.push(...kinds);
    }
    const direction = order === "desc" ? "DESC" : "ASC";
    sql += ` ORDER BY e.ts ${direction}, e.rowid ${direction} LIMIT ?`;
    params.push(limit + 1);
    const rows = this.db.prepare(sql).all(...params) as (MeshEventRow & {
      chat_body?: string | null;
    })[];
    const hasMore = rows.length > limit;
    const events = (hasMore ? rows.slice(0, limit) : rows).map(toMeshEvent);
    return { events, hasMore };
  }

  /**
   * Count events in `[sinceISO, untilISO)` whose `kind` is one of `kinds` — a cheap
   * `COUNT(*)` used by the nightly distill day-gate to decide whether the window holds
   * any substantive activity (without materializing the rows). `untilISO` is exclusive;
   * omit it for an open upper bound. Returns 0 for an empty `kinds`.
   */
  countEventsSince(sinceISO: string, kinds: readonly string[], untilISO?: string): number {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(", ");
    const params: (string | number)[] = [sinceISO];
    let sql = `SELECT COUNT(*) AS n FROM mesh_events WHERE ts >= ?`;
    if (untilISO != null) {
      sql += ` AND ts < ?`;
      params.push(untilISO);
    }
    sql += ` AND kind IN (${placeholders})`;
    params.push(...kinds);
    const row = this.db.prepare(sql).get(...params) as { n: number };
    return row.n;
  }

  /** Raw actual-start facts used by the quota estimator. */
  listProviderStartsSince(provider: string, sinceISO: string): RunStartEvent[] {
    const rows = this.db
      .prepare(
        `SELECT *
         FROM mesh_events
         WHERE kind = 'run_start'
           AND ts >= ?
           AND json_extract(payload, '$.provider') = ?
         ORDER BY ts ASC, rowid ASC`
      )
      .all(sinceISO, provider) as MeshEventRow[];
    return rows.map((row) => {
      const event = toMeshEvent(row);
      return {
        ...event,
        kind: "run_start",
        payload: JSON.parse(row.payload ?? "{}") as RunStartPayload,
      };
    });
  }

  /**
   * Fetch a single event by id (PK lookup), or `null` if absent. The dashboard
   * SSE wiring uses this to re-read a just-recorded event so the live frame is
   * byte-identical to the same event fetched via the JSON endpoints (same
   * `clampBody` tail-truncation).
   */
  getById(id: string): MeshEvent | null {
    const row = this.db
      .prepare(`
      SELECT e.*, c.body as chat_body 
      FROM mesh_events e
      LEFT JOIN mesh_chat c ON json_extract(e.payload, '$.messageId') = c.id
      WHERE e.id = ?
    `)
      .get(id) as (MeshEventRow & { chat_body?: string | null }) | undefined;
    return row ? toMeshEvent(row) : null;
  }

  getLatestRowid(): number {
    const row = this.db.prepare(`SELECT MAX(rowid) as max_id FROM mesh_events`).get() as {
      max_id: number | null;
    };
    return row.max_id ?? 0;
  }

  /**
   * A newest-first page of events whose subject (`actor_id`) is one of
   * `actorIds`. Used by the dashboard Events tab, including the merged stream
   * across a multi-selection. Pass the previous page's `nextCursor` as
   * `before` to page backward in time. `kinds`, if given, restricts to those
   * event kinds. Returns an empty page for an empty `actorIds`.
   */
  listEventsByActors(
    actorIds: string[],
    opts: { limit: number; before?: number | null; kinds?: string[]; conversation?: boolean } = {
      limit: 50,
    }
  ): EventPage {
    const { limit } = opts;
    if (actorIds.length === 0 || limit <= 0) return { events: [], nextCursor: null };

    const actorPlaceholders = actorIds.map(() => "?").join(", ");
    const params: (string | number)[] = [...actorIds];
    let sql = `
      SELECT e.rowid AS rowid, e.*, c.body as chat_body 
      FROM mesh_events e
      LEFT JOIN mesh_chat c ON json_extract(e.payload, '$.messageId') = c.id
      WHERE e.actor_id IN (${actorPlaceholders})
    `;

    if (opts.conversation && actorIds.length === 2) {
      sql += ` AND (
        (c.sender_id = ? AND c.recipient_id = ?) OR
        (c.sender_id = ? AND c.recipient_id = ?)
      )`;
      params.push(actorIds[0], actorIds[1], actorIds[1], actorIds[0]);
    }

    if (opts.kinds && opts.kinds.length > 0) {
      sql += ` AND e.kind IN (${opts.kinds.map(() => "?").join(", ")})`;
      params.push(...opts.kinds);
    }
    if (opts.before != null) {
      sql += ` AND e.rowid < ?`;
      params.push(opts.before);
    }
    // Fetch one extra row to tell whether an older page exists.
    sql += ` ORDER BY e.rowid DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = this.db.prepare(sql).all(...params) as (MeshEventRow & {
      rowid: number;
      chat_body?: string | null;
    })[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1].rowid : null;
    return { events: page.map(toMeshEvent), nextCursor };
  }

  /**
   * The actor's ledger source journal after a durable event-id watermark, oldest
   * first: inbound messages *and* the actor's own yield notes (see
   * {@link PORTABLE_CONTEXT_SOURCE_KINDS}). Portable-context v2 folds from here;
   * `mesh_events` remains authoritative while the actor's JSON ledger is only a
   * materialized cache.
   *
   * The two kinds share ONE rowid watermark, which is why they are read in a
   * single interleaved query rather than two: chronological order across both is
   * what lets a later yield note update or resolve an item an earlier message
   * created.
   */
  listLedgerSourcesAfter(
    actorId: string,
    afterEventId: string | null,
    limit = 50
  ): { events: MeshEvent[]; hasMore: boolean } {
    if (limit <= 0) return { events: [], hasMore: false };
    let afterRowid = 0;
    if (afterEventId) {
      const watermark = this.db
        .prepare("SELECT rowid FROM mesh_events WHERE id = ?")
        .get(afterEventId) as { rowid: number } | undefined;
      if (!watermark) {
        throw new Error(`portable-context watermark event not found: ${afterEventId}`);
      }
      afterRowid = watermark.rowid;
    }
    const kinds = Object.keys(PORTABLE_CONTEXT_SOURCE_KINDS);
    const rows = this.db
      .prepare(
        `SELECT e.*, c.body AS chat_body
         FROM mesh_events e
         LEFT JOIN mesh_chat c ON json_extract(e.payload, '$.messageId') = c.id
         WHERE e.rowid > ? AND e.kind IN (${kinds.map(() => "?").join(", ")}) AND e.actor_id = ?
         ORDER BY e.rowid ASC
         LIMIT ?`
      )
      .all(afterRowid, ...kinds, actorId, limit + 1) as (MeshEventRow & {
      chat_body?: string | null;
    })[];
    return {
      events: rows.slice(0, limit).map(toMeshEvent),
      hasMore: rows.length > limit,
    };
  }

  /**
   * Returns the most recent event timestamp (`MAX(ts)`) for every actor that has
   * at least one mesh event. One grouped query, not N+1; the `idx_mesh_events_actor_ts`
   * covering index supplies the answer without touching the table rows.
   */
  latestActivityByActor(): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT actor_id AS actorId, MAX(ts) AS ts
         FROM mesh_events
         WHERE actor_id IS NOT NULL
         GROUP BY actor_id`
      )
      .all() as { actorId: string; ts: string }[];
    return new Map(rows.map((r) => [r.actorId, r.ts]));
  }
}

/**
 * The `messageId` an event carries in its JSON `payload`, or null. An event
 * carrying one is *spine-participating*: its prose is single-sourced in
 * `mesh_chat` (keyed by this id), so the mesh_chat JOIN is the authority for its
 * body — see {@link toMeshEvent}. Events with no messageId (legacy pre-ISSUE_NUM
 * message rows with a null payload, run outputs, every non-message kind) keep
 * their body in `mesh_events.body`.
 */
function messageIdOf(payload: string | null): string | null {
  if (payload == null) return null;
  try {
    const parsed = JSON.parse(payload) as { messageId?: unknown };
    return typeof parsed.messageId === "string" ? parsed.messageId : null;
  } catch {
    return null;
  }
}

function toMeshEvent(row: MeshEventRow & { chat_body?: string | null }): MeshEvent {
  // Body resolution is scoped by messageId presence, NOT by kind. A
  // spine-participating event (payload.messageId present) reads its body from
  // the mesh_chat JOIN and nowhere else: mesh_chat is the single source, so a
  // JOIN miss means the body is genuinely gone — never rescue a stale
  // `row.body`, which under the ISSUE_NUM single-source model is the duplicate the
  // 0006 rewire eliminated. Every other event (no messageId: legacy null-payload
  // message rows, run outputs, non-message kinds) keeps its own `row.body`,
  // where that prose legitimately lives. Kind-scoping would wrongly blank the
  // ~1942 legacy message_sent/received rows whose bodies live in mesh_events.
  const body = messageIdOf(row.payload) != null ? (row.chat_body ?? null) : row.body;
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    actorId: row.actor_id,
    detail: row.detail,
    body,
    payload: row.payload,
    success: row.success == null ? null : row.success === 1,
  };
}
