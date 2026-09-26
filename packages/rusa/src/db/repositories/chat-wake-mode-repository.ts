import type Database from "better-sqlite3";
import type { ChatWakeMode, ChatWakeModeSetting, ChatWakeModeStore } from "../../chat/wake-mode.js";

type EventSourceRow = {
  resource: string;
  config: string | null;
};

type EventSourceConfigV1 = {
  version: 1;
  chatWakeMode?: ChatWakeMode;
};

function parseConfig(raw: string | null): EventSourceConfigV1 | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      return undefined;
    }
    const chatWakeMode = (parsed as { chatWakeMode?: unknown }).chatWakeMode;
    if (chatWakeMode !== undefined && chatWakeMode !== "mentions" && chatWakeMode !== "all") {
      return undefined;
    }
    return parsed as EventSourceConfigV1;
  } catch {
    return undefined;
  }
}

/**
 * SQLite implementation of {@link ChatWakeModeStore} over
 * the active exact `event_source_owners.config` blob (0051). Reads go straight
 * to the row so a mode set through one connection governs the next arriving
 * message on another. Delegation/reclaim carries that blob with the source.
 */
export class DbChatWakeModeStore implements ChatWakeModeStore {
  constructor(private readonly db: Database.Database) {}

  get(resource: string): ChatWakeModeSetting | undefined {
    const row = this.db
      .prepare(
        "SELECT resource, config FROM event_source_owners WHERE resource = ? AND unsubscribed_at IS NULL"
      )
      .get(resource) as EventSourceRow | undefined;
    if (!row) return undefined;
    const config = parseConfig(row.config);
    return config?.chatWakeMode ? { resource: row.resource, mode: config.chatWakeMode } : undefined;
  }

  set(setting: ChatWakeModeSetting): void {
    const result = this.db
      .prepare(
        `UPDATE event_source_owners
         SET config = ?
         WHERE resource = ? AND unsubscribed_at IS NULL`
      )
      .run(
        JSON.stringify({ version: 1, chatWakeMode: setting.mode } satisfies EventSourceConfigV1),
        setting.resource
      );
    if (result.changes !== 1) {
      throw new Error(
        `cannot set chat wake mode for ${setting.resource}: no active event-source owner`
      );
    }
  }

  clear(resource: string): void {
    this.db
      .prepare(
        "UPDATE event_source_owners SET config = NULL WHERE resource = ? AND unsubscribed_at IS NULL"
      )
      .run(resource);
  }
}
