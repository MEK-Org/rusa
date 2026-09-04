import type Database from "better-sqlite3";
import type {
  ScheduledDelivery,
  ScheduledDeliveryStore,
} from "../../actor/scheduled-delivery-store.js";

interface ScheduledMessageRow {
  id: string;
  to_id: string;
  from_id: string;
  body: string;
  deliver_at: string;
  session_id: string | null;
}

function toScheduledDelivery(row: ScheduledMessageRow): ScheduledDelivery {
  return {
    id: row.id,
    toId: row.to_id,
    fromId: row.from_id,
    body: row.body,
    deliverAt: row.deliver_at,
    sessionId: row.session_id ?? undefined,
  };
}

/**
 * SQLite-backed data access for the `scheduled_messages` table (#209) — the
 * durable store for scheduled actor-to-actor messages, normalized and outside
 * `ThreadRecord`/`actors` (see the 0038 migration).
 */
export class ScheduledMessageRepository implements ScheduledDeliveryStore {
  constructor(private readonly db: Database.Database) {}

  insert(delivery: ScheduledDelivery): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO scheduled_messages (id, to_id, from_id, body, deliver_at, session_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        delivery.id,
        delivery.toId,
        delivery.fromId,
        delivery.body,
        delivery.deliverAt,
        delivery.sessionId ?? null
      );
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM scheduled_messages WHERE id = ?`).run(id);
  }

  get(id: string): ScheduledDelivery | undefined {
    const row = this.db.prepare(`SELECT * FROM scheduled_messages WHERE id = ?`).get(id) as
      | ScheduledMessageRow
      | undefined;
    return row ? toScheduledDelivery(row) : undefined;
  }

  listForRecipient(recipientId: string): ScheduledDelivery[] {
    const rows = this.db
      .prepare(`SELECT * FROM scheduled_messages WHERE to_id = ? ORDER BY deliver_at ASC`)
      .all(recipientId) as ScheduledMessageRow[];
    return rows.map(toScheduledDelivery);
  }

  countForRecipient(recipientId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM scheduled_messages WHERE to_id = ?`)
      .get(recipientId) as { n: number };
    return row.n;
  }

  listAll(): ScheduledDelivery[] {
    const rows = this.db
      .prepare(`SELECT * FROM scheduled_messages ORDER BY deliver_at ASC`)
      .all() as ScheduledMessageRow[];
    return rows.map(toScheduledDelivery);
  }
}
