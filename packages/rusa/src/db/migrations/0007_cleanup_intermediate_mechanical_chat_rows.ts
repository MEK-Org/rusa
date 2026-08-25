import type { Database } from "better-sqlite3";
import { CHAT_EXCLUDED_BODY_PREFIXES } from "../../actor/mesh-events.js";
import type { Migration } from "./types.js";

interface TableColumn {
  name: string;
}

function hasColumns(db: Database, table: string, columns: string[]): boolean {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[]).map((column) => column.name)
  );
  return columns.every((column) => present.has(column));
}

/**
 * One-shot cleanup of intermediate-vintage mechanical rows that leaked into
 * `mesh_chat` between the 0005 split deploy (2026-07-18 21:07Z) and the ISSUE_NUM
 * runtime rewire (2026-07-19 10:22Z). During that window mechanical
 * run-lifecycle notes were still written to `mesh_chat` as chat rows; ISSUE_NUM
 * routes them to the ISSUE_NUM inbox instead, so from the rewire onward no such row
 * is produced (a prod audit on 2026-07-19 confirmed zero mechanical `mesh_chat`
 * rows after the deploy). This removes the ones already recorded.
 *
 * Scope: only live-vintage rows (`id` not prefixed `bf:`). The 0006 backfill
 * excluded mechanical prefixes, so legacy `bf:` rows never carried them (the
 * same audit confirmed zero mechanical `bf:` rows); the `NOT LIKE 'bf:%'` guard
 * keeps this cleanup off the legacy partition regardless. Matches the same
 * reserved prefixes as the 0006 exclusion via the shared
 * {@link CHAT_EXCLUDED_BODY_PREFIXES}, so cleanup and backfill cannot drift.
 *
 * Idempotent: a re-run on a store with no mechanical rows deletes nothing.
 */
export const cleanupIntermediateMechanicalChatRows: Migration = {
  id: "0007_cleanup_intermediate_mechanical_chat_rows",
  up: (db: Database) => {
    if (!hasColumns(db, "mesh_chat", ["id", "body"])) {
      console.log(
        "Removed 0 intermediate-vintage mechanical rows from mesh_chat; table absent or lacks columns."
      );
      return;
    }

    const bodyPredicate = CHAT_EXCLUDED_BODY_PREFIXES.map(() => "body LIKE ?").join(
      "\n           OR "
    );
    const likeParams = CHAT_EXCLUDED_BODY_PREFIXES.map((prefix) => `${prefix}%`);

    const result = db
      .prepare(
        `DELETE FROM mesh_chat
         WHERE id NOT LIKE 'bf:%'
           AND (${bodyPredicate})`
      )
      .run(...likeParams);

    console.log(`Removed ${result.changes} intermediate-vintage mechanical rows from mesh_chat.`);
  },
};
