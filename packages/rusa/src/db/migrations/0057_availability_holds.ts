import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Durable availability holds (#539).
 *
 * A hold takes a provider lane, or one of its models, out of selection without
 * editing any configured model pool. `scope` is a JSON object naming what the
 * row holds: `{"provider":"kimi"}` holds the whole provider, and
 * `{"provider":"kimi","model":"kimi-k2"}` holds that one model on it. Several
 * rows may coexist, and setting the same scope again replaces its row.
 *
 * Scope text is canonical (provider first, model only when present, no other
 * keys or whitespace) with names normalized (trimmed, lowercase), so equal
 * scopes are equal strings and the unique index on `scope` sees duplicates.
 *
 * `expiry` is an ISO-8601 UTC timestamp, or NULL for a hold that lasts until it
 * is cleared. Expired rows are ignored at selection time and are not deleted
 * automatically.
 */
export const availabilityHolds: Migration = {
  id: "0057_availability_holds",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE availability_holds (
        scope      TEXT NOT NULL CHECK (
          json_valid(scope)
          AND json_type(scope, '$.provider') = 'text'
          AND json_extract(scope, '$.provider') <> ''
          AND json_extract(scope, '$.provider') = lower(trim(json_extract(scope, '$.provider')))
          AND (
            json_type(scope, '$.model') IS NULL
            OR (
              json_type(scope, '$.model') = 'text'
              AND json_extract(scope, '$.model') <> ''
              AND json_extract(scope, '$.model') = lower(trim(json_extract(scope, '$.model')))
            )
          )
          AND scope = CASE
            WHEN json_type(scope, '$.model') IS NULL
              THEN json_object('provider', json_extract(scope, '$.provider'))
            ELSE json_object(
              'provider', json_extract(scope, '$.provider'),
              'model', json_extract(scope, '$.model')
            )
          END
        ),
        expiry     TEXT,
        reason     TEXT NOT NULL DEFAULT '',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX availability_holds_scope ON availability_holds (scope);
    `);
  },
};
