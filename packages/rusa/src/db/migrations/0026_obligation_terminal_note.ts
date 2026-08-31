import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Record *why* an obligation reached its terminal state.
 *
 * `setTerminalStatus` moves a node to `done` or `cancelled` and stores nothing
 * about the reasoning. For `done` the reason is often recoverable from a linked
 * artifact; for `cancelled` it is not recoverable at all — the intent that is no
 * longer current, and the reason it stopped being current, disappear in the same
 * write. #1485 makes cancellation the ordinary way to retire intent ("intent
 * that is no longer current is cancelled and may become a fresh obligation
 * later"), which makes an unexplained cancellation routine rather than an edge
 * case.
 *
 * It also closes the loop on human-owned decision children. An operator answers
 * a question by marking it done; without a note the answer itself lands nowhere
 * the tree can reach, only the fact that something was answered — which is the
 * same shape of loss this branch exists to fix, one level down.
 *
 * Nullable and never backfilled. A row that terminated before this column
 * existed has no recorded reason, and inventing one would be exactly the
 * fabricated provenance 0025 refused. The CHECK keeps "no reason given" to a
 * single representation so a blank string cannot masquerade as an answer.
 */
export const obligationTerminalNote: Migration = {
  id: "0026_obligation_terminal_note",
  up: (db: Database) => {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(obligations)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );

    if (!columns.has("terminal_note")) {
      // SQLite's one-argument trim() strips spaces ONLY, so the `trim(x) > 0`
      // idiom used elsewhere in this schema would admit a tab- or newline-only
      // note. A note is free prose and genuinely may arrive that way, so the
      // whitespace set is spelled out rather than assumed.
      db.exec(
        `ALTER TABLE obligations ADD COLUMN terminal_note TEXT
           CHECK (
             terminal_note IS NULL
             OR length(trim(terminal_note, char(32) || char(9) || char(10) || char(13))) > 0
           )`
      );
    }
  },
};
