import type { Database } from "better-sqlite3";
import { parseReference } from "../../references/reference.js";

export interface ReferenceCacheRow {
  ref: string;
  document_version: number;
  entity_json: string;
  fetched_at: string;
  refresh_after: string;
}

export class ReferenceCacheRepository {
  constructor(private readonly db: Database) {}

  get(ref: string): ReferenceCacheRow | null {
    if (parseReference(ref).key !== ref)
      throw new Error("ReferenceCacheRepository requires canonical refs");
    const row = this.db
      .prepare(
        `SELECT ref, document_version, entity_json, fetched_at, refresh_after
         FROM reference_cache
         WHERE ref = ?`
      )
      .get(ref) as ReferenceCacheRow | undefined;
    return row ?? null;
  }

  set(row: ReferenceCacheRow): void {
    if (parseReference(row.ref).key !== row.ref)
      throw new Error("ReferenceCacheRepository requires canonical refs");
    this.db
      .prepare(
        `INSERT INTO reference_cache (ref, document_version, entity_json, fetched_at, refresh_after)
         VALUES (@ref, @document_version, @entity_json, @fetched_at, @refresh_after)
         ON CONFLICT(ref) DO UPDATE SET
           document_version = excluded.document_version,
           entity_json = excluded.entity_json,
           fetched_at = excluded.fetched_at,
           refresh_after = excluded.refresh_after`
      )
      .run(row);
  }

  delete(ref: string): void {
    if (parseReference(ref).key !== ref)
      throw new Error("ReferenceCacheRepository requires canonical refs");
    this.db.prepare(`DELETE FROM reference_cache WHERE ref = ?`).run(ref);
  }
}
