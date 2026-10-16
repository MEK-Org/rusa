import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Storage for the one-time import of the configured actor (#1002, under #465).
 *
 * `legacy_import_receipts.actor_id` names the actor an import bound. Only the
 * `config.yaml:rootActor` receipt sets it: that import has to remember *which*
 * actor it imported, because after it completes nothing may re-derive that
 * from topology. It is migration provenance and confers no authority. There is
 * deliberately no foreign key, so a receipt naming an actor whose row has gone
 * stays readable and boot can refuse by name instead of minting a replacement.
 *
 * `actors.display_handle` is the actor's own display handle where it is not
 * derived from its id. The configured actor's handle used to be re-read from
 * `rootActor.handle` on every boot and had no durable home; the import writes
 * it here once. NULL keeps every other actor's handle derived from its id.
 *
 * Both columns are nullable, so existing rows need no backfill: the import
 * fills them on the first boot after this migration. Rolling back to an
 * earlier binary leaves both columns unread; that binary goes back to reading
 * `rootActor` on every boot, as it always did.
 */
export const configuredActorImport: Migration = {
  id: "0060_configured_actor_import",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE legacy_import_receipts ADD COLUMN actor_id TEXT
        CHECK (actor_id IS NULL OR length(actor_id) > 0);
      ALTER TABLE actors ADD COLUMN display_handle TEXT
        CHECK (display_handle IS NULL OR length(display_handle) > 0);
    `);
  },
};
