import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Drop obsolete `obligation_ready_heads` table (#513).
 *
 * The ready-head cache table is recomputable and removed. Head-of-queue
 * deduplication and sequence tracking are maintained only in process memory,
 * current heads are derived on the fly from obligations, and no
 * persistence remains in SQLite.
 *
 * Operational rollback is roll-forward to a 0050-compatible build. Do not
 * deploy pre-0050 code against this schema: it writes the removed table. An
 * emergency code rollback must first recreate the 0025 table shape; its rows
 * are recomputable.
 */
export const dropObligationReadyHeads: Migration = {
  id: "0050_drop_obligation_ready_heads",
  up: (db: Database) => {
    db.exec("DROP TABLE IF EXISTS obligation_ready_heads;");
  },
};
