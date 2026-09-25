import type Database from "better-sqlite3";
import type { ChatWakeMode, ChatWakeModeSetting, ChatWakeModeStore } from "../../chat/wake-mode.js";

type WakeModeRow = {
  resource: string;
  mode: ChatWakeMode;
  set_by: string;
  set_at: string;
};

/**
 * SQLite implementation of {@link ChatWakeModeStore} over
 * `chat_space_wake_modes` (0051). Reads go straight to the table so a mode set
 * through one connection governs the next arriving message on another.
 */
export class DbChatWakeModeStore implements ChatWakeModeStore {
  constructor(private readonly db: Database.Database) {}

  get(resource: string): ChatWakeModeSetting | undefined {
    const row = this.db
      .prepare(
        "SELECT resource, mode, set_by, set_at FROM chat_space_wake_modes WHERE resource = ?"
      )
      .get(resource) as WakeModeRow | undefined;
    return row
      ? { resource: row.resource, mode: row.mode, setBy: row.set_by, setAt: row.set_at }
      : undefined;
  }

  set(setting: ChatWakeModeSetting): void {
    this.db
      .prepare(
        `INSERT INTO chat_space_wake_modes (resource, mode, set_by, set_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(resource) DO UPDATE SET
           mode = excluded.mode,
           set_by = excluded.set_by,
           set_at = excluded.set_at`
      )
      .run(setting.resource, setting.mode, setting.setBy, setting.setAt);
  }

  clear(resource: string): void {
    this.db.prepare("DELETE FROM chat_space_wake_modes WHERE resource = ?").run(resource);
  }
}
