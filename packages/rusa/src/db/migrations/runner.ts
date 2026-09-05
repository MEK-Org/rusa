import type { Database } from "better-sqlite3";
import { migrations } from "./index.js";

/**
 * IDs of migrations not yet recorded as applied. Safe to call before
 * {@link runMigrations}: it only ensures the `_migrations` bookkeeping table
 * exists, which `runMigrations` does unconditionally anyway. Used by
 * `rusa db-check` to report what a real run would apply.
 */
export function pendingMigrationIds(db: Database): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const applied = new Set(
    (db.prepare("SELECT id FROM _migrations").all() as Array<{ id: string }>).map((m) => m.id)
  );
  return migrations
    .filter((migration) => !applied.has(migration.id))
    .map((migration) => migration.id);
}

/**
 * Executes all pending migrations against the provided database.
 * Handles both fresh databases and upgrades from pre-migration systems.
 */
export function runMigrations(db: Database): void {
  // 1. Ensure the migrations tracking table exists.
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 2. Check if this is an existing database from before the migration system.
  // We check for the presence of the 'tasks' table as a proxy for 'existing data'.
  const tables = db
    .prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'
  `)
    .all() as Array<{ name: string }>;

  const hasExistingTables = tables.length > 0;

  // 3. Process migrations.
  const appliedMigrations = new Set(
    (db.prepare("SELECT id FROM _migrations").all() as Array<{ id: string }>).map((m) => m.id)
  );

  for (const migration of migrations) {
    if (appliedMigrations.has(migration.id)) {
      continue;
    }

    // Special case: If we have existing tables but no migration record for the initial schema,
    // we assume the database is already at the initial schema state.
    if (migration.id === "0001_initial_schema" && hasExistingTables) {
      db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
      continue;
    }

    // Apply the migration.
    try {
      if (migration.noTransaction) {
        migration.up(db);
        db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
      } else {
        db.transaction(() => {
          migration.up(db);
          db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
        })();
      }
    } catch (error) {
      console.error(`Failed to apply migration ${migration.id}:`, error);
      throw error;
    }
  }
}
