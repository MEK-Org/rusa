import type Database from "better-sqlite3";
import type { ChatWakeMode, ChatWakeModeSetting, ChatWakeModeStore } from "../../chat/wake-mode.js";

type WakeModeRow = {
  resource: string;
  mode: ChatWakeMode;
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
      .prepare("SELECT resource, mode FROM chat_space_wake_modes WHERE resource = ?")
      .get(resource) as WakeModeRow | undefined;
    return row ? { resource: row.resource, mode: row.mode } : undefined;
  }

  set(setting: ChatWakeModeSetting): void {
    this.db
      .prepare(
        `INSERT INTO chat_space_wake_modes (resource, mode)
         VALUES (?, ?)
         ON CONFLICT(resource) DO UPDATE SET
           mode = excluded.mode`
      )
      .run(setting.resource, setting.mode);
  }

  clear(resource: string): void {
    this.db.prepare("DELETE FROM chat_space_wake_modes WHERE resource = ?").run(resource);
  }
}
