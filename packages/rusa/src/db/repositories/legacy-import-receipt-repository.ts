import type Database from "better-sqlite3";

/**
 * Records that a legacy JSON source has been imported and the database is now
 * authoritative for it.
 *
 * The receipt is written inside the import transaction, so it exists exactly
 * when the imported rows do. That is what lets a later boot treat a source file
 * still sitting on disk — because the archive rename never ran, or because
 * someone restored a backup — as stale rather than as a competing authority.
 * Without it the only available test is comparing file content to durable rows,
 * which starts failing the moment the mesh legitimately changes those rows.
 */
export class LegacyImportReceiptRepository {
  constructor(private readonly db: Database.Database) {}

  /** True when `source` has already been imported and committed. */
  has(source: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM legacy_import_receipts WHERE source = ?").get(source) !==
      undefined
    );
  }

  /** Record the import of `source`. Idempotent: the first receipt's timestamp stands. */
  record(source: string, at: string, rowCount: number): void {
    this.db
      .prepare(
        `INSERT INTO legacy_import_receipts (source, imported_at, row_count)
         VALUES (?, ?, ?)
         ON CONFLICT(source) DO NOTHING`
      )
      .run(source, at, rowCount);
  }
}
