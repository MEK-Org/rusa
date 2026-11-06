import type Database from "better-sqlite3";

export interface PushDeviceToken {
  token: string;
  principalId: string;
}

type PushDeviceTokenRow = {
  token: string;
  principal_id: string;
};

const COLUMNS = "token, principal_id";

/**
 * Principal-bound FCM device registration storage. A token can belong to only
 * one principal at a time: registering it after an account change transfers it
 * atomically, while revoke is always constrained to the current principal.
 */
export class PushDeviceTokenRepository {
  constructor(private readonly db: Database.Database) {}

  register(principalId: string, token: string): PushDeviceToken {
    const normalizedToken = requireToken(token);
    this.db
      .prepare(
        `INSERT INTO push_device_tokens (${COLUMNS}) VALUES (?, ?)
         ON CONFLICT(token) DO UPDATE SET
           principal_id = excluded.principal_id`
      )
      .run(normalizedToken, principalId);
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
           ORDER BY token ASC`
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
  };
}
