import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  type InboxActorWork,
  type InboxAppendInput,
  type InboxEntry,
  type InboxListOptions,
  type InboxPage,
  type InboxPayload,
  type InboxStore,
  type MarkHandledResult,
  validateInboxPayload,
} from "../../actor/inbox-store.js";

interface InboxRow {
  id: string;
  actor_id: string;
  source: string;
  delivered_at: string;
  seen_at: string | null;
  handled_at: string | null;
  handled_note: string | null;
  payload_json: string;
}

interface CursorValue {
  deliveredAt: string;
  id: string;
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorValue {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorValue;
    if (typeof parsed.deliveredAt !== "string" || typeof parsed.id !== "string") throw new Error();
    return parsed;
  } catch {
    throw new Error("invalid inbox cursor");
  }
}

function toEntry(row: InboxRow): InboxEntry {
  const payload = JSON.parse(row.payload_json) as InboxPayload;
  validateInboxPayload(payload);
  return {
    id: row.id,
    actorId: row.actor_id,
    source: row.source,
    deliveredAt: new Date(row.delivered_at),
    seenAt: row.seen_at === null ? null : new Date(row.seen_at),
    handledAt: row.handled_at === null ? null : new Date(row.handled_at),
    handledNote: row.handled_note,
    payload,
  };
}

/** SQLite implementation of the actor inbox persistence seam. */
export class InboxRepository implements InboxStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date()
  ) {}

  append(inputs: InboxAppendInput[]): InboxEntry[] {
    if (inputs.length === 0) return [];
    const insert = this.db.prepare(
      `INSERT INTO actor_inbox_entries
        (id, actor_id, source, delivered_at, seen_at, handled_at, payload_json)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(id) DO NOTHING`
    );
    const rows = inputs.map((input) => {
      if (!input.actorId.trim()) throw new Error("inbox actorId is required");
      if (!input.source.trim()) throw new Error("inbox source is required");
      validateInboxPayload(input.payload);
      const deliveredAt = input.deliveredAt ?? this.now();
      if (!Number.isFinite(deliveredAt.getTime())) throw new Error("invalid deliveredAt");
      return {
        id: input.id ?? randomUUID(),
        actorId: input.actorId,
        source: input.source,
        deliveredAt,
        payload: input.payload,
      };
    });
    const insertedIds = this.db.transaction(() => {
      const inserted = new Set<string>();
      for (const row of rows) {
        const result = insert.run(
          row.id,
          row.actorId,
          row.source,
          row.deliveredAt.toISOString(),
          JSON.stringify(row.payload)
        );
        if (result.changes === 1) inserted.add(row.id);
      }
      return inserted;
    })();
    return rows
      .filter((row) => insertedIds.has(row.id))
      .map((row) => ({ ...row, seenAt: null, handledAt: null, handledNote: null }));
  }

  list(actorId: string, options: InboxListOptions = {}): InboxPage {
    const status = options.status ?? "unhandled";
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("inbox list limit must be an integer from 1 to 100");
    }
    const where = ["actor_id = ?"];
    const params: Array<string | number> = [actorId];
    if (status === "unhandled") where.push("handled_at IS NULL");
    else if (status === "handled") where.push("handled_at IS NOT NULL");
    if (options.source !== undefined) {
      where.push("source = ?");
      params.push(options.source);
    }
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      where.push("(delivered_at < ? OR (delivered_at = ? AND id < ?))");
      params.push(cursor.deliveredAt, cursor.deliveredAt, cursor.id);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM actor_inbox_entries
         WHERE ${where.join(" AND ")}
         ORDER BY delivered_at DESC, id DESC LIMIT ?`
      )
      .all(...params, limit + 1) as InboxRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      entries: pageRows.map(toEntry),
      unhandledCount: this.countUnhandled(actorId),
      nextCursor:
        hasMore && last ? encodeCursor({ deliveredAt: last.delivered_at, id: last.id }) : null,
    };
  }

  read(actorId: string, entryId: string): InboxEntry | null {
    const row = this.db
      .prepare("SELECT * FROM actor_inbox_entries WHERE actor_id = ? AND id = ?")
      .get(actorId, entryId) as InboxRow | undefined;
    return row ? toEntry(row) : null;
  }

  countUnhandled(actorId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM actor_inbox_entries WHERE actor_id = ? AND handled_at IS NULL"
      )
      .get(actorId) as { count: number };
    return row.count;
  }

  actorsWithUnhandled(): InboxActorWork[] {
    return this.actorsWithPending("handled_at IS NULL");
  }

  actorsWithUnseen(): InboxActorWork[] {
    return this.actorsWithPending("handled_at IS NULL AND seen_at IS NULL");
  }

  markSeen(actorId: string, at = this.now()): InboxEntry[] {
    if (!Number.isFinite(at.getTime())) throw new Error("invalid seenAt");
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM actor_inbox_entries
           WHERE actor_id = ? AND seen_at IS NULL AND handled_at IS NULL
           ORDER BY delivered_at ASC, id ASC`
        )
        .all(actorId) as InboxRow[];
      if (rows.length === 0) return [];
      const stamp = at.toISOString();
      this.db
        .prepare(
          `UPDATE actor_inbox_entries SET seen_at = ?
           WHERE actor_id = ? AND seen_at IS NULL AND handled_at IS NULL`
        )
        .run(stamp, actorId);
      return rows.map((row) => toEntry({ ...row, seen_at: stamp }));
    })();
  }

  markHandled(
    actorId: string,
    entryIds: string[],
    at = this.now(),
    handledNote?: string
  ): MarkHandledResult[] {
    if (
      entryIds.length < 1 ||
      entryIds.length > 100 ||
      new Set(entryIds).size !== entryIds.length
    ) {
      throw new Error("markHandled requires 1 to 100 unique entry ids");
    }
    if (!Number.isFinite(at.getTime())) throw new Error("invalid handledAt");
    const note = handledNote?.trim() || null;
    return this.db.transaction(() => {
      const placeholders = entryIds.map(() => "?").join(", ");
      const rows = this.db
        .prepare(
          `SELECT * FROM actor_inbox_entries
           WHERE actor_id = ? AND id IN (${placeholders})`
        )
        .all(actorId, ...entryIds) as InboxRow[];
      if (rows.length !== entryIds.length) throw new Error("inbox entry not found");
      const byId = new Map(rows.map((row) => [row.id, row]));
      const stamp = at.toISOString();
      // This is intentionally the only production UPDATE of handled_at.
      this.db
        .prepare(
          `UPDATE actor_inbox_entries SET handled_at = ?, handled_note = ?
           WHERE actor_id = ? AND id IN (${placeholders}) AND handled_at IS NULL`
        )
        .run(stamp, note, actorId, ...entryIds);
      return entryIds.map((id) => {
        const previous = byId.get(id);
        if (!previous) throw new Error("inbox entry not found");
        return {
          id,
          handledAt: new Date(previous.handled_at ?? stamp),
          alreadyHandled: previous.handled_at !== null,
        };
      });
    })();
  }

  private actorsWithPending(where: string): InboxActorWork[] {
    const rows = this.db
      .prepare(
        `SELECT actor_id AS actorId,
                CASE WHEN MAX(
                  CASE WHEN json_extract(payload_json, '$.priority') = 'responsive'
                       THEN 1 ELSE 0 END
                ) = 1 THEN 'responsive' ELSE 'normal' END AS priority
         FROM actor_inbox_entries
         WHERE ${where}
         GROUP BY actor_id
         ORDER BY actor_id`
      )
      .all() as InboxActorWork[];
    return rows.map((row) => ({ actorId: row.actorId, priority: row.priority }));
  }
}
