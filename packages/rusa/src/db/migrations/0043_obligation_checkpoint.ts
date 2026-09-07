import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Give an obligation one owner-rewritten record of *where the work stands*
 * (#302).
 *
 * The tree already holds why work exists (`intent`) and whether it is finished
 * (`status`). It has had nowhere to hold the third thing an arc actually needs
 * on every wake: exact head, migrations in flight, which gates cleared, what
 * happens next. With no mutable field for it, stewards encoded standing in
 * artifact labels, and reading an arc's state meant replaying thirty-odd
 * append-only rows in order.
 *
 * **Replace, not append.** The checkpoint is the *current* standing, so a write
 * discards the previous value. That is the whole design: a field you have to
 * reconstruct by replaying is the thing being replaced. The optional
 * `mesh_events` notification lets current readers refresh, while the durable
 * obligation row remains the source of truth; no history table is added here.
 *
 * The stamp is two columns rather than one because both halves are read for
 * different reasons — `checkpoint_at` says whether the standing is stale, and
 * `checkpoint_by` says whose account of it this is when an ancestor owner has
 * also been writing.
 *
 * All three are NULL together or set together, enforced by the CHECK carried on
 * the last-added column (SQLite's `ALTER TABLE ADD COLUMN` takes column
 * definitions only, so a whole-table constraint has to ride on a column, and
 * only the last one can see the other two). Clearing therefore returns the row
 * to genuinely-no-standing rather than leaving a stamp with nothing stamped.
 *
 * Every column is tested with an explicit `IS NOT NULL` before anything else is
 * asked of it: a CHECK whose expression evaluates to NULL *passes* in SQLite,
 * so `length(trim(col)) > 0` alone silently admits the NULL it was written to
 * exclude.
 *
 * Nullable and never backfilled: an obligation written before this column
 * existed has no recorded standing, and deriving one from artifacts would
 * assert a currency nobody vouched for.
 *
 * No length cap in the schema. Blankness and stamp coherence are
 * representation invariants that must never differ between the store and its
 * writers, so they belong here; how long a checkpoint may be is a judgment
 * about what stays legible in a queue, which the write boundary enforces
 * (`OBLIGATION_CHECKPOINT_MAX`) so retuning it never needs a table rebuild.
 */
export const obligationCheckpoint: Migration = {
  id: "0043_obligation_checkpoint",
  up: (db: Database) => {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(obligations)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );

    // The whitespace set is spelled out for the same reason 0026 spells it out:
    // SQLite's one-argument `trim()` strips spaces only, and a checkpoint is
    // free prose that may genuinely arrive tab- or newline-led.
    const WHITESPACE = "char(32) || char(9) || char(10) || char(13)";

    if (!columns.has("checkpoint")) {
      db.exec(
        `ALTER TABLE obligations ADD COLUMN checkpoint TEXT
           CHECK (
             checkpoint IS NULL
             OR length(trim(checkpoint, ${WHITESPACE})) > 0
           )`
      );
    }

    if (!columns.has("checkpoint_at")) {
      db.exec(
        `ALTER TABLE obligations ADD COLUMN checkpoint_at TEXT
           CHECK (
             checkpoint_at IS NULL
             OR length(trim(checkpoint_at, ${WHITESPACE})) > 0
           )`
      );
    }

    if (!columns.has("checkpoint_by")) {
      db.exec(
        `ALTER TABLE obligations ADD COLUMN checkpoint_by TEXT
           CONSTRAINT obligations_checkpoint_stamp_coherent
           CHECK (
             (checkpoint IS NULL AND checkpoint_at IS NULL AND checkpoint_by IS NULL)
             OR (
               checkpoint IS NOT NULL
               AND checkpoint_at IS NOT NULL
               AND checkpoint_by IS NOT NULL
               AND length(trim(checkpoint_by, ${WHITESPACE})) > 0
             )
           )`
      );
    }
  },
};
