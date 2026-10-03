import type Database from "better-sqlite3";

/** One stored Room entry episode. `documentJson` is opaque here (#829). */
export interface RoomEntryEpisodeRow {
  id: string;
  principalId: string;
  enteredAt: string;
  endedAt: string | null;
  documentJson: string;
}

type Row = {
  id: string;
  principal_id: string;
  entered_at: string;
  ended_at: string | null;
  document_json: string;
};

const COLUMNS = "id, principal_id, entered_at, ended_at, document_json";

function fromRow(row: Row): RoomEntryEpisodeRow {
  return {
    id: row.id,
    principalId: row.principal_id,
    enteredAt: row.entered_at,
    endedAt: row.ended_at,
    documentJson: row.document_json,
  };
}

/** Data access for `room_entry_episodes`. Callers own read-modify-write transactions. */
export class RoomEntryEpisodeRepository {
  constructor(private readonly db: Database.Database) {}

  get(id: string): RoomEntryEpisodeRow | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM room_entry_episodes WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** The principal's current (not yet ended) episode, if any. */
  current(principalId: string): RoomEntryEpisodeRow | null {
    const row = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM room_entry_episodes WHERE principal_id = ? AND ended_at IS NULL`
      )
      .get(principalId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  /** Every stored episode, oldest first. Collection keeps the table small. */
  list(): RoomEntryEpisodeRow[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM room_entry_episodes ORDER BY entered_at, id`)
      .all() as Row[];
    return rows.map(fromRow);
  }

  insert(row: RoomEntryEpisodeRow): void {
    this.db
      .prepare(`INSERT INTO room_entry_episodes (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`)
      .run(row.id, row.principalId, row.enteredAt, row.endedAt, row.documentJson);
  }

  update(id: string, patch: { endedAt: string | null; documentJson: string }): void {
    this.db
      .prepare("UPDATE room_entry_episodes SET ended_at = ?, document_json = ? WHERE id = ?")
      .run(patch.endedAt, patch.documentJson, id);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM room_entry_episodes WHERE id = ?").run(id).changes === 1;
  }

  /** Run a read-modify-write atomically on the shared connection. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
