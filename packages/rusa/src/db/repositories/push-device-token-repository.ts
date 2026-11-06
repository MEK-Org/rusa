import type Database from "better-sqlite3";

export interface PushDeviceToken {
  token: string;
  principalId: string;
  registeredAt: string;
  refreshedAt: string;
}

type PushDeviceTokenRow = {
  token: string;
  principal_id: string;
  registered_at: string;
  refreshed_at: string;
};

const COLUMNS = "token, principal_id, registered_at, refreshed_at";

/**
 * Principal-bound FCM device registration storage. A token can belong to only
 * one principal at a time: registering it after an account change transfers it
 * atomically, while revoke is always constrained to the current principal.
 */
export class PushDeviceTokenRepository {
  constructor(private readonly db: Database.Database) {}

  register(principalId: string, token: string, now: string): PushDeviceToken {
    const normalizedToken = requireToken(token);
    this.db
      .prepare(
        `INSERT INTO push_device_tokens (${COLUMNS}) VALUES (?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET
           principal_id = excluded.principal_id,
           registered_at = CASE
             WHEN push_device_tokens.principal_id = excluded.principal_id
               THEN push_device_tokens.registered_at
             ELSE excluded.registered_at
           END,
           refreshed_at = excluded.refreshed_at`
      )
      .run(normalizedToken, principalId, now, now);
    const stored = this.get(normalizedToken);
    if (!stored) throw new Error("push token registration was not stored");
    return stored;
  }

  /** Delete only a token the authenticated principal owns. */
  revoke(principalId: string, token: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM push_device_tokens WHERE token = ? AND principal_id = ?")
        .run(requireToken(token), principalId).changes > 0
    );
  }

  /** Internal delivery cleanup after an authoritative FCM invalid-token response. */
  remove(token: string): boolean {
    return this.db.prepare("DELETE FROM push_device_tokens WHERE token = ?").run(token).changes > 0;
  }

  listForPrincipal(principalId: string): PushDeviceToken[] {
    return (
      this.db
        .prepare(
          `SELECT ${COLUMNS} FROM push_device_tokens
           WHERE principal_id = ?
           ORDER BY registered_at ASC, token ASC`
        )
        .all(principalId) as PushDeviceTokenRow[]
    ).map(toPushDeviceToken);
  }

  get(token: string): PushDeviceToken | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM push_device_tokens WHERE token = ?`)
      .get(token) as PushDeviceTokenRow | undefined;
    return row ? toPushDeviceToken(row) : undefined;
  }
}

function requireToken(value: string): string {
  const token = value.trim();
  if (!token) throw new Error("push token is required");
  return token;
}

function toPushDeviceToken(row: PushDeviceTokenRow): PushDeviceToken {
  return {
    token: row.token,
    principalId: row.principal_id,
    registeredAt: row.registered_at,
    refreshedAt: row.refreshed_at,
  };
}
