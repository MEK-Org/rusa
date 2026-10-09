import type { Database } from "better-sqlite3";
import type { Migration } from "../../db/migrations/types.js";
import { QUOTA_SCHEMA_VERSION } from "../schema-guard.js";
import { quotaMigrations } from "./index.js";

/**
 * Apply pending quota.db migrations, recording each in `_migrations` as the
 * mesh.db runner does.
 *
 * quota.db is shared: every instance, the coordinator and the maintenance
 * scripts open the same file, and more than one can open it at once. So the
 * whole pass runs in one IMMEDIATE transaction. The first opener takes the
 * write lock and applies everything; a concurrent opener waits on its busy
 * timeout and then finds nothing pending. A failed migration rolls back the
 * whole pass, leaving the database and its records as they were.
 *
 * An applied id this binary does not know came from a newer binary. It is
 * ignored: `user_version` is what refuses a database this binary cannot use.
 * So every pass, not just the one that applies a migration, stamps a header
 * below {@link QUOTA_SCHEMA_VERSION} up to it, as the store's inline schema
 * code did before this runner: an older binary must keep refusing the file.
 */
export function runQuotaMigrations(
  db: Database,
  migrations: readonly Migration[] = quotaMigrations
): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const applied = new Set(
      (db.prepare("SELECT id FROM _migrations").all() as Array<{ id: string }>).map((m) => m.id)
    );
    const record = db.prepare("INSERT INTO _migrations (id) VALUES (?)");
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      if (migration.noTransaction) {
        throw new Error(`quota migration ${migration.id} cannot run outside the shared pass`);
      }
      migration.up(db);
      record.run(migration.id);
    }
    const rawVersion = db.pragma("user_version", { simple: true });
    const currentVersion = typeof rawVersion === "number" ? rawVersion : Number(rawVersion ?? 0);
    if (currentVersion < QUOTA_SCHEMA_VERSION) {
      db.pragma(`user_version = ${QUOTA_SCHEMA_VERSION}`);
    }
  }).immediate();
}
