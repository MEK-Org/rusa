import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface MeshChat {
  id: string;
  ts: string;
  senderId: string;
  recipientId: string;
  body: string;
  sessionId: string | null;
}

export interface MeshChatListOptions {
  peerId?: string;
  limit?: number;
}

interface MeshChatRow {
  id: string;
  ts: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  session_id: string | null;
}

/** Append-only data access for the `mesh_chat` table. */
export class MeshChatRepository {
  constructor(private readonly db: Database.Database) {}

  /** Append a single message and return its generated id. */
  record(opts: {
    id?: string;
    ts?: string;
    senderId: string;
    recipientId: string;
    body: string;
    sessionId?: string | null;
  }): string {
    const id = opts.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        opts.ts ?? new Date().toISOString(),
        opts.senderId,
        opts.recipientId,
        opts.body,
        opts.sessionId ?? null
      );
    return id;
  }

  /** Fetch a single message by id (PK lookup), or `null` if absent. */
  getById(id: string): MeshChat | null {
    const row = this.db.prepare(`SELECT * FROM mesh_chat WHERE id = ?`).get(id) as
      | MeshChatRow
      | undefined;
    return row ? toMeshChat(row) : null;
  }

  /** List recent messages visible to one actor, optionally with one peer only. */
  listForActor(actorId: string, opts: MeshChatListOptions = {}): MeshChat[] {
    const limit = opts.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("mesh chat limit must be between 1 and 100");
    }
    const peerClause = opts.peerId
      ? ` AND ((sender_id = ? AND recipient_id = ?)
               OR (sender_id = ? AND recipient_id = ?))`
      : "";
    const params: Array<string | number> = [actorId, actorId];
    if (opts.peerId) {
      params.push(actorId, opts.peerId, opts.peerId, actorId);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM mesh_chat
         WHERE (sender_id = ? OR recipient_id = ?)${peerClause}
         ORDER BY ts DESC, id DESC
         LIMIT ?`
      )
      .all(...params) as MeshChatRow[];
    return rows.map(toMeshChat);
  }

  /**
   * A newest-first page of chat messages between the given actors.
   * Pass the previous page's `nextCursor` as `before` to page backward in time.
   */
  listChatByActors(
    actorIds: string[],
    opts: { limit: number; before?: number | null } = { limit: 50 }
  ): ChatPage {
    const { limit } = opts;
    if (actorIds.length === 0 || limit <= 0) return { chat: [], nextCursor: null };

    const actorPlaceholders = actorIds.map(() => "?").join(", ");
    const params: (string | number)[] = [...actorIds, ...actorIds];
    let sql = `
      SELECT rowid, * 
      FROM mesh_chat
      WHERE sender_id IN (${actorPlaceholders}) AND recipient_id IN (${actorPlaceholders})
        AND sender_id != recipient_id
    `;

    if (opts.before != null) {
      sql += ` AND rowid < ?`;
      params.push(opts.before);
    }
    sql += ` ORDER BY rowid DESC LIMIT ?`;
    params.push(limit + 1);

    const rows = this.db.prepare(sql).all(...params) as (MeshChatRow & { rowid: number })[];
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? page[page.length - 1].rowid : null;
    return { chat: page.map(toMeshChat), nextCursor };
  }
}

export interface ChatPage {
  chat: MeshChat[];
  nextCursor: number | null;
}

function toMeshChat(row: MeshChatRow): MeshChat {
  return {
    id: row.id,
    ts: row.ts,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    body: row.body,
    sessionId: row.session_id,
  };
}
