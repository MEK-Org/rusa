import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/** Support recurring obligations as durable scheduled work. */
export const recurringObligations: Migration = {
  id: "0034_recurring_obligations",
  noTransaction: true,
  up: (db: Database) => {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.transaction(() => {
      // 1. Recreate obligations table to add scheduled status and recurrence columns
      db.exec(`
        CREATE TABLE new_obligations (
          id             TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
          parent_id      TEXT REFERENCES new_obligations(id) ON DELETE RESTRICT,
          owner_id       TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
          intent         TEXT,
          external_ref   TEXT,
          status         TEXT NOT NULL CHECK (status IN ('ready', 'waiting', 'done', 'cancelled', 'scheduled')),
          priority       REAL CHECK (priority IS NULL OR (typeof(priority) IN ('real', 'integer') AND priority BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308)),
          created_at     TEXT,
          updated_at     TEXT,
          creator_id     TEXT CHECK (creator_id IS NULL OR length(trim(creator_id)) > 0),
          terminal_note  TEXT CHECK (terminal_note IS NULL OR length(trim(terminal_note, char(32) || char(9) || char(10) || char(13))) > 0),
          title          TEXT CHECK (title IS NULL OR (length(trim(title, char(32) || char(9) || char(10) || char(13))) > 0 AND length(title) <= 200 AND instr(title, char(10)) = 0 AND instr(title, char(13)) = 0)),
          resolution_ref TEXT CHECK (resolution_ref IS NULL OR length(trim(resolution_ref)) > 0),
          recurrence_policy TEXT CHECK (recurrence_policy IN ('completion_interval', 'cron') OR recurrence_policy IS NULL),
          recurrence_cron TEXT,
          recurrence_interval_seconds INTEGER,
          next_ready_at TEXT,
          CHECK (parent_id IS NULL OR parent_id <> id),
          CHECK (external_ref IS NULL OR length(trim(external_ref)) > 0),
          CHECK (
            (recurrence_policy IS NULL AND recurrence_cron IS NULL AND recurrence_interval_seconds IS NULL AND (status <> 'scheduled' OR next_ready_at IS NULL)) OR
            (recurrence_policy = 'cron' AND recurrence_cron IS NOT NULL AND length(trim(recurrence_cron)) > 0 AND recurrence_interval_seconds IS NULL) OR
            (recurrence_policy = 'completion_interval' AND recurrence_cron IS NULL AND recurrence_interval_seconds IS NOT NULL AND typeof(recurrence_interval_seconds) = 'integer' AND recurrence_interval_seconds > 0)
          ),
          CHECK (status <> 'scheduled' OR (recurrence_policy IS NOT NULL AND next_ready_at IS NOT NULL))
        );
      `);

      db.exec(`
        INSERT INTO new_obligations (id, parent_id, owner_id, intent, external_ref, status, priority, created_at, updated_at, creator_id, terminal_note, title, resolution_ref)
        SELECT id, parent_id, owner_id, intent, external_ref, status, priority, created_at, updated_at, creator_id, terminal_note, title, resolution_ref FROM obligations;
      `);

      db.exec("DROP TABLE obligations;");
      db.exec("ALTER TABLE new_obligations RENAME TO obligations;");

      db.exec("CREATE INDEX idx_obligations_parent ON obligations(parent_id);");
      db.exec(
        "CREATE INDEX idx_obligations_owner_status_priority ON obligations(owner_id, status, priority, id);"
      );
      db.exec(
        "CREATE UNIQUE INDEX idx_obligations_live_external_ref ON obligations(external_ref COLLATE NOCASE) WHERE external_ref IS NOT NULL AND status IN ('ready', 'waiting', 'scheduled');"
      );
      db.exec("CREATE INDEX idx_obligations_created_at ON obligations(created_at);");

      // 2. Create obligation_completions ledger
      db.exec(`
        CREATE TABLE obligation_completions (
          id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
          obligation_id TEXT NOT NULL REFERENCES obligations(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          completed_at TEXT NOT NULL,
          note TEXT,
          resolution_ref TEXT,
          next_ready_at TEXT,
          UNIQUE(obligation_id, sequence)
        );
      `);
    })();
    db.exec("PRAGMA foreign_keys = ON;");
  },
};
