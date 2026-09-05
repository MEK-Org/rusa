import type Database from "better-sqlite3";
import type { CapabilityGrant, CapabilityGrantStore } from "../../actor/capability-grants.js";

type GrantRow = {
  actor_id: string;
  capability: string;
  granted_by: string;
  granted_at: string;
  revoked_at: string | null;
};

function fromRow(row: GrantRow): CapabilityGrant {
  return {
    actorId: row.actor_id,
    capability: row.capability,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}

/**
 * SQLite implementation of {@link CapabilityGrantStore} — every call reads
 * straight from `capability_grants` with no process-local cache, so a grant
 * or revoke committed by another connection is visible to the next call
 * without an orchestrator restart. `actor_id` is owned by the referenced
 * `actors` row (0036_capability_grants).
 */
export class DbCapabilityGrantStore implements CapabilityGrantStore {
  constructor(private readonly db: Database.Database) {}

  grant(grant: CapabilityGrant): void {
    this.db
      .prepare(
        `INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at, revoked_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(actor_id, capability) DO UPDATE SET
           granted_by = excluded.granted_by,
           granted_at = excluded.granted_at,
           revoked_at = NULL`
      )
      .run(grant.actorId, grant.capability, grant.grantedBy, grant.grantedAt);
  }

  revoke(actorId: string, capability: string, at: string): void {
    this.db
      .prepare(
        `UPDATE capability_grants SET revoked_at = ?
         WHERE actor_id = ? AND capability = ? AND revoked_at IS NULL`
      )
      .run(at, actorId, capability);
  }

  list(): CapabilityGrant[] {
    return (
      this.db
        .prepare(
          "SELECT actor_id, capability, granted_by, granted_at, revoked_at FROM capability_grants"
        )
        .all() as GrantRow[]
    ).map(fromRow);
  }

  activeFor(actorId: string): string[] {
    return (
      this.db
        .prepare(
          "SELECT capability FROM capability_grants WHERE actor_id = ? AND revoked_at IS NULL ORDER BY capability"
        )
        .all(actorId) as Array<{ capability: string }>
    ).map((row) => row.capability);
  }
}
