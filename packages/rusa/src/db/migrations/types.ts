import type { Database } from "better-sqlite3";

/**
 * A database migration that can be applied to a SQLite database.
 */
export interface Migration {
  /**
   * Unique identifier for the migration.
   * Used to track if the migration has already been applied.
   * Suggested format: '0001_description_here'
   */
  id: string;

  /**
   * Can be raw SQL via db.exec() or more complex logic.
   */
  up: (db: Database) => void;

  /**
   * If true, the migration runner will not wrap the 'up' call in a transaction.
   * Required for migrations that use PRAGMAs that cannot run inside a transaction
   * (like PRAGMA foreign_keys = OFF).
   */
  noTransaction?: boolean;
}
