import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { validateInboxInterruptionForWrite } from "../../repositories/inbox-interruption.js";
import {
  type InboxActorWork,
  type InboxAppendInput,
  type InboxEntry,
  type InboxItemsAppendedListener,
  type InboxItemsHandledListener,
  type InboxListOptions,
  type InboxPage,
  type InboxPayload,
  type InboxRepository,
  type MarkHandledResult,
  validateInboxPayload,
} from "../../repositories/inbox-repository.js";

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

/**
 * Receives an error thrown by an `onItemsAppended` listener. The notification
 * is advisory, so a listener failure is reported here rather than surfaced to
 * the appending caller, whose write has already committed.
 */
export type InboxListenerErrorHandler = (error: unknown) => void;

export const INBOX_MUTATION_EFFECT = "inbox.mutation";

/**
 * What one committed inbox write owes its listeners (#1289), as plain data so
 * a writer can hand it across a thread boundary and deliver it on the main
 * thread in commit order. See {@link SqliteInboxRepository.deliverMutationEffect}.
 */
export interface InboxMutationEffect {
  kind: typeof INBOX_MUTATION_EFFECT;
  /** Entries this write marked handled, for the handled listeners. */
  handled: { actorId: string; results: MarkHandledResult[] } | null;
  /** Rows this write inserted, for the appended listeners. */
  appended: InboxEntry[];
}

/** Where a write operation takes each committed inbox write's effect (#1289). */
export interface InboxWriteContext {
  emit(effect: InboxMutationEffect): void;
}

/** SQLite implementation of the actor inbox persistence seam. */
export class SqliteInboxRepository implements InboxRepository {
  private readonly listeners = new Set<InboxItemsAppendedListener>();
  private readonly handledListeners = new Set<InboxItemsHandledListener>();
  private onListenerError: InboxListenerErrorHandler = () => {};
  /** Set while {@link inWriteOperation} runs. */
  private writeContext: InboxWriteContext | undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Journal listener failures. Set from the composition root the way
   * `ActorMesh`'s own log is, so a dropped advisory nudge is visible in the
   * running service rather than only under test; until it is set, a failure is
   * contained silently and durable recovery remains the authority.
   */
  setListenerErrorHandler(handler: InboxListenerErrorHandler): void {
    this.onListenerError = handler;
  }

  append(inputs: InboxAppendInput[]): InboxEntry[] {
    if (inputs.length === 0) return [];
    // Inside an enclosing transaction the write would be only a savepoint whose
    // fate the outer caller decides, so no after-commit notification could be
    // honest, and a silently deferred row is reconciled only by the next
    // boot/resume sweep. Refuse before any write rather than defer.
    // A write operation's transaction is the exception: its writer delivers
    // the effect only once that transaction commits (#1289 C2).
    if (this.db.inTransaction && !this.writeContext) {
      throw new Error("inbox append must not run inside an enclosing transaction");
    }
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
      validateInboxInterruptionForWrite(input.payload);
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
    const inserted = this.db.transaction(() => {
      const insertedRows: InboxEntry[] = [];
      for (const row of rows) {
        const result = insert.run(
          row.id,
          row.actorId,
          row.source,
          row.deliveredAt.toISOString(),
          JSON.stringify(row.payload)
        );
        if (result.changes === 1) {
          insertedRows.push({
            ...row,
            seenAt: null,
            handledAt: null,
            handledNote: null,
          });
        }
      }
      return insertedRows;
    })();
    // Notify only once the rows are durable: outside a write operation the
    // transaction above has committed, and nothing here is awaited, so the
    // appending caller's own wake still follows in the same turn; inside one,
    // its writer delivers the effect once the operation commits.
    this.committed({ kind: INBOX_MUTATION_EFFECT, handled: null, appended: inserted });
    return inserted;
  }

  onItemsAppended(listener: InboxItemsAppendedListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onItemsHandled(listener: InboxItemsHandledListener): () => void {
    this.handledListeners.add(listener);
    return () => {
      this.handledListeners.delete(listener);
    };
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
    if (options.responsiveOnly) {
      where.push("json_extract(payload_json, '$.priority') = 'responsive'");
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
      unhandledCount: this.countUnhandled(actorId, { responsiveOnly: options.responsiveOnly }),
      nextCursor:
        hasMore && last ? encodeCursor({ deliveredAt: last.delivered_at, id: last.id }) : null,
    };
  }

  selectPrioritizedUnhandled(actorId: string): InboxEntry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM actor_inbox_entries
         WHERE actor_id = ? AND handled_at IS NULL
         ORDER BY CASE WHEN json_extract(payload_json, '$.priority') = 'responsive' THEN 0 ELSE 1 END,
                  delivered_at ASC,
                  id ASC
         LIMIT 1`
      )
      .get(actorId) as InboxRow | undefined;
    return row ? toEntry(row) : null;
  }

  read(actorId: string, entryId: string): InboxEntry | null {
    const row = this.db
      .prepare("SELECT * FROM actor_inbox_entries WHERE actor_id = ? AND id = ?")
      .get(actorId, entryId) as InboxRow | undefined;
    return row ? toEntry(row) : null;
  }

  countUnhandled(actorId: string, options: { responsiveOnly?: boolean } = {}): number {
    const responsiveWhere = options.responsiveOnly
      ? " AND json_extract(payload_json, '$.priority') = 'responsive'"
      : "";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM actor_inbox_entries
         WHERE actor_id = ? AND handled_at IS NULL${responsiveWhere}`
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

  unseenEntryIds(actorId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM actor_inbox_entries
         WHERE actor_id = ? AND seen_at IS NULL AND handled_at IS NULL
         ORDER BY delivered_at ASC, id ASC`
      )
      .all(actorId) as { id: string }[];
    return rows.map((row) => row.id);
  }

  markSeen(actorId: string, entryIds: readonly string[], at = this.now()): InboxEntry[] {
    if (!Number.isFinite(at.getTime())) throw new Error("invalid seenAt");
    if (entryIds.length === 0) return [];
    // The id list is bound as one JSON text rather than one parameter per id,
    // so its length meets no bound-parameter limit.
    const params = [actorId, JSON.stringify(entryIds)];
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM actor_inbox_entries
           WHERE actor_id = ? AND seen_at IS NULL AND handled_at IS NULL
             AND id IN (SELECT value FROM json_each(?))
           ORDER BY delivered_at ASC, id ASC`
        )
        .all(...params) as InboxRow[];
      if (rows.length === 0) return [];
      const stamp = at.toISOString();
      this.db
        .prepare(
          `UPDATE actor_inbox_entries SET seen_at = ?
           WHERE actor_id = ? AND seen_at IS NULL AND handled_at IS NULL
             AND id IN (SELECT value FROM json_each(?))`
        )
        .run(stamp, ...params);
      return rows.map((row) => toEntry({ ...row, seen_at: stamp }));
    })();
  }

  markHandled(
    actorId: string,
    entryIds: string[],
    at = this.now(),
    handledNote?: string
  ): MarkHandledResult[] {
    // As for replaceEntries: inside an enclosing transaction that is not a
    // write operation's, the handled notification would fire before the
    // outer caller decided the write's fate.
    if (this.db.inTransaction && !this.writeContext) {
      throw new Error("inbox markHandled must not run inside an enclosing transaction");
    }
    if (
      entryIds.length < 1 ||
      entryIds.length > 100 ||
      new Set(entryIds).size !== entryIds.length
    ) {
      throw new Error("markHandled requires 1 to 100 unique entry ids");
    }
    if (!Number.isFinite(at.getTime())) throw new Error("invalid handledAt");
    const note = handledNote?.trim() || null;
    const results = this.db.transaction(() => {
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
    if (results.length > 0) {
      this.committed({ kind: INBOX_MUTATION_EFFECT, handled: { actorId, results }, appended: [] });
    }
    return results;
  }

  replaceEntries(
    actorId: string,
    entryIds: string[],
    handledNote: string,
    replacements: InboxAppendInput[],
    at = this.now()
  ): { handled: MarkHandledResult[]; replacements: InboxEntry[] } {
    // A write operation's transaction is the one exception: its effect is
    // delivered only once that transaction has committed.
    if (this.db.inTransaction && !this.writeContext) {
      throw new Error("inbox replaceEntries must not run inside an enclosing transaction");
    }
    if (
      entryIds.length < 1 ||
      entryIds.length > 100 ||
      new Set(entryIds).size !== entryIds.length
    ) {
      throw new Error("replaceEntries requires 1 to 100 unique entry ids");
    }
    if (!Number.isFinite(at.getTime())) throw new Error("invalid handledAt");
    const note = handledNote.trim();
    if (!note) throw new Error("replaceEntries requires a non-empty handledNote");

    const insert = this.db.prepare(
      `INSERT INTO actor_inbox_entries
        (id, actor_id, source, delivered_at, seen_at, handled_at, payload_json)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(id) DO NOTHING`
    );
    const replacementRows = replacements.map((input) => {
      if (!input.actorId.trim()) throw new Error("inbox actorId is required");
      if (!input.source.trim()) throw new Error("inbox source is required");
      validateInboxPayload(input.payload);
      validateInboxInterruptionForWrite(input.payload);
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

    const { handled, insertedRows } = this.db.transaction(() => {
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
      this.db
        .prepare(
          `UPDATE actor_inbox_entries SET handled_at = ?, handled_note = ?
           WHERE actor_id = ? AND id IN (${placeholders}) AND handled_at IS NULL`
        )
        .run(stamp, note, actorId, ...entryIds);

      const handledResults = entryIds.map((id) => {
        const previous = byId.get(id);
        if (!previous) throw new Error("inbox entry not found");
        return {
          id,
          handledAt: new Date(previous.handled_at ?? stamp),
          alreadyHandled: previous.handled_at !== null,
        };
      });

      const inserted: InboxEntry[] = [];
      for (const row of replacementRows) {
        const result = insert.run(
          row.id,
          row.actorId,
          row.source,
          row.deliveredAt.toISOString(),
          JSON.stringify(row.payload)
        );
        if (result.changes === 1) {
          inserted.push({
            ...row,
            seenAt: null,
            handledAt: null,
            handledNote: null,
          });
        }
      }

      if (inserted.length !== replacementRows.length) {
        throw new Error("failed to insert all replacement inbox entries");
      }

      return { handled: handledResults, insertedRows: inserted };
    })();

    this.committed({
      kind: INBOX_MUTATION_EFFECT,
      handled: handled.length > 0 ? { actorId, results: handled } : null,
      appended: insertedRows,
    });
    return { handled, replacements: insertedRows };
  }

  /**
   * Run `work` as part of a write operation (#1289): each inbox write it makes
   * hands its committed consequences to `context.emit` as one
   * {@link InboxMutationEffect} instead of notifying listeners, because the
   * operation's transaction has not committed yet. The writer that ran the
   * operation delivers each effect through {@link deliverMutationEffect}.
   */
  inWriteOperation<T>(context: InboxWriteContext, work: () => T): T {
    if (this.writeContext) {
      throw new Error("SqliteInboxRepository.inWriteOperation cannot be nested");
    }
    this.writeContext = context;
    try {
      return work();
    } finally {
      this.writeContext = undefined;
    }
  }

  /**
   * Deliver one committed inbox write's consequences to this repository's
   * listeners, in the order a write outside a write operation notifies them
   * itself: handled, then appended. A listener failure is contained and
   * reported; it never throws, because the write has already committed.
   */
  deliverMutationEffect(effect: InboxMutationEffect): void {
    if (effect.kind !== INBOX_MUTATION_EFFECT) {
      throw new Error(`not an inbox mutation effect: ${String(effect.kind)}`);
    }
    if (effect.handled && effect.handled.results.length > 0) {
      this.notifyItemsHandled(effect.handled.actorId, effect.handled.results);
    }
    if (effect.appended.length > 0) this.notifyItemsAppended(effect.appended);
  }

  /** Hand a committed write's effect to the write operation, or deliver it now. */
  private committed(effect: InboxMutationEffect): void {
    if (!effect.handled && effect.appended.length === 0) return;
    if (this.writeContext) this.writeContext.emit(effect);
    else this.deliverMutationEffect(effect);
  }

  /**
   * Advisory delivery after commit. A listener that throws must neither undo
   * the durable write nor starve the listeners after it, so each failure is
   * contained and reported through `onListenerError`. A failure in the error
   * reporter itself is similarly contained.
   */
  private notifyItemsAppended(items: readonly InboxEntry[]): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(items);
      } catch (error) {
        try {
          this.onListenerError(error);
        } catch {
          // A throwing reporter must neither escape append nor starve later listeners.
        }
      }
    }
  }

  private notifyItemsHandled(actorId: string, results: readonly MarkHandledResult[]): void {
    for (const listener of [...this.handledListeners]) {
      try {
        listener(actorId, results);
      } catch (error) {
        try {
          this.onListenerError(error);
        } catch {
          // A throwing reporter must neither escape markHandled nor starve later listeners.
        }
      }
    }
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

  listRecentHandledEntries(limit = 50): InboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT id, actor_id, source, delivered_at, seen_at, handled_at, handled_note, payload_json
         FROM actor_inbox_entries
         WHERE handled_at IS NOT NULL
         ORDER BY handled_at DESC, id DESC
         LIMIT ?`
      )
      .all(limit) as InboxRow[];
    // A matching timestamp/note is not a durable batch identifier. Keep every
    // row visible rather than collapsing unrelated operator actions.
    return rows.map(toEntry);
  }
}
