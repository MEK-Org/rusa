import type Database from "better-sqlite3";

/** One stored Chat Room participant. Root is implicit and never stored. */
export interface ChatRoomMember {
  actorId: string;
  addedBy: string;
  addedAt: string;
}

type ChatRoomRow = { actor_id: string; added_by: string; added_at: string };

/** Data access for the mesh-wide Chat Room roster (`chat_room_participants`). */
export class ChatRoomRepository {
  constructor(private readonly db: Database.Database) {}

  /** Stored participants in the order they were added. */
  list(): ChatRoomMember[] {
    const rows = this.db
      .prepare(
        "SELECT actor_id, added_by, added_at FROM chat_room_participants ORDER BY added_at, actor_id"
      )
      .all() as ChatRoomRow[];
    return rows.map((row) => ({
      actorId: row.actor_id,
      addedBy: row.added_by,
      addedAt: row.added_at,
    }));
  }

  has(actorId: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM chat_room_participants WHERE actor_id = ?").get(actorId) !==
      undefined
    );
  }

  /** Insert a participant. Returns false when the actor is already in the room. */
  add(member: ChatRoomMember): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO chat_room_participants (actor_id, added_by, added_at) VALUES (?, ?, ?)
         ON CONFLICT(actor_id) DO NOTHING`
      )
      .run(member.actorId, member.addedBy, member.addedAt);
    return result.changes === 1;
  }

  /** Delete a participant. Returns false when the actor was not in the room. */
  remove(actorId: string): boolean {
    return (
      this.db.prepare("DELETE FROM chat_room_participants WHERE actor_id = ?").run(actorId)
        .changes === 1
    );
  }

  /** Run several roster/actor writes atomically on the shared connection. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
