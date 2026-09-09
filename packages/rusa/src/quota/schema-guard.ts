import type Database from "better-sqlite3";

export const QUOTA_SCHEMA_VERSION = 1;

export class SchemaVersionRefusalError extends Error {
  constructor(
    readonly currentVersion: number,
    readonly maxSupportedVersion: number
  ) {
    super(
      `Database user_version ${currentVersion} is newer than supported schema version ${maxSupportedVersion}`
    );
    this.name = "SchemaVersionRefusalError";
  }
}

/**
 * Enforce the schema guard from §5.2 and §7 of the quota coordinator design.
 * Pure read-only check: refuses a database whose PRAGMA user_version is newer than supported.
 * Does NOT mutate the database.
 */
export function assertQuotaSchemaVersion(
  db: Database.Database,
  maxSupportedVersion: number = QUOTA_SCHEMA_VERSION
): number {
  const rawVersion = db.pragma("user_version", { simple: true });
  const current = typeof rawVersion === "number" ? rawVersion : Number(rawVersion ?? 0);
  if (current > maxSupportedVersion) {
    throw new SchemaVersionRefusalError(current, maxSupportedVersion);
  }
  return current;
}
