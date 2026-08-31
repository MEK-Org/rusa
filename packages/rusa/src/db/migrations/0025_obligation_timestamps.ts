import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Give obligations a creation/last-mutation stamp and an immutable creator.
 *
 * **Temporal data.** The table has carried none since 0016, so nothing
 * downstream can express recency — "this obligation is recent" is not a
 * question the store can answer, which is what an ancestry projection needs to
 * make a stale premise visibly stale.
 *
 * **One id space.** `owner_kind` is dropped and human owners are normalised
 * onto the `human:*` prefix the mesh already mints, so an owner and a creator
 * are the same kind of value as every other entity reference in the schema.
 *
 * **Creator.** `owner_id` answers who holds the work *now*. It does not answer
 * who raised it, and reassignment destroys the distinction: after a move the row
 * preserves neither the creator nor the principal that moved it (meta-coder
 * #1671).
 *
 * It is a single entity id, not an id plus a `kind`. The mesh already has one
 * id space — `mcp/stamp.ts` mints `human:operator`, `system:mesh` and
 * `system:tracker-hygiene` alongside actor UUIDs and `root`, and
 * `isHumanOperator(actorId)` derives the category from the id's prefix. A
 * stored kind would restate what the id already says, and #1671's requirement
 * that actor/human/system writes stay distinguishable is met by binding the id
 * server-side, not by carrying a second column. `obligations.owner_kind` is the
 * one place that split the space, and the cost is visible in the live data:
 * three different owner ids resolve to the same operator, because nothing
 * forced a canonical one.
 *
 * **Written by the repository, not by triggers.** An earlier draft of this
 * migration stamped via `AFTER INSERT`/`AFTER UPDATE` triggers, trading
 * visibility for unmissability. The operator ruled against that shape on #1671
 * (2026-08-22): "I don't love triggers generally because they're kind of opaque
 * to the codebase ... let's just do this in a single transaction in the
 * repository instead of having a trigger." Root's concurrence names the reason
 * that applies here too — a trigger hides the write at exactly the seam a
 * reviewer needs to see. Drift across the repository's mutation sites is
 * defended by a test that enumerates them instead.
 *
 * Format matches `mesh_events.ts` and `obligation_capture_receipts.created_at`
 * (`2026-08-29T13:45:12.345Z`), not the legacy `datetime('now')` shape used by
 * `threads`.
 *
 * This is deliberately NOT the full #1671 attribution history: no per-mutation
 * snapshots, no mutating-principal record, no sequence. It is the denormalised
 * creator that #1671's own open question contemplates, and stays compatible
 * with a later `obligation_history` table where the create event is
 * authoritative.
 */
export const obligationTimestamps: Migration = {
  id: "0025_obligation_timestamps",
  up: (db: Database) => {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(obligations)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );

    // SQLite forbids a non-constant DEFAULT in ALTER TABLE ADD COLUMN, so these
    // arrive nullable and the repository fills them on write.
    if (!columns.has("created_at")) {
      db.exec("ALTER TABLE obligations ADD COLUMN created_at TEXT");
    }
    if (!columns.has("updated_at")) {
      db.exec("ALTER TABLE obligations ADD COLUMN updated_at TEXT");
    }
    if (!columns.has("creator_id")) {
      db.exec(
        `ALTER TABLE obligations ADD COLUMN creator_id TEXT
           CHECK (creator_id IS NULL OR length(trim(creator_id)) > 0)`
      );
    }

    // Collapse owner into the same single id space. `owner_kind` restated what
    // the id prefix already says, and by making a kind explicit it removed the
    // pressure to have one canonical id per entity — which is why the live
    // table holds three different owner ids for the same operator.
    if (columns.has("owner_kind")) {
      // Legacy human owners were free-form handles — a display name in one
      // row, a GitHub login in another — so prefixing alone would mint several
      // `human:*` ids for one person, which is the bug rather than the fix.
      // They all resolve to HUMAN_OPERATOR, the id the mesh already mints and
      // the only human identifier this repository should contain.
      const HUMAN_OPERATOR = "human:operator";
      db.prepare(
        `UPDATE obligations SET owner_id = ? WHERE owner_kind = 'human' AND owner_id <> ?`
      ).run(HUMAN_OPERATOR, HUMAN_OPERATOR);

      db.exec(`
        DROP INDEX IF EXISTS idx_obligations_owner_status_priority;
        ALTER TABLE obligations DROP COLUMN owner_kind;
        CREATE INDEX idx_obligations_owner_status_priority
          ON obligations(owner_id, status, priority, id);
      `);
    }

    // Backfill timestamps only where a real creation time exists. A capture
    // receipt is written in the same operation that mints its obligation, so its
    // created_at is that obligation's creation time.
    //
    // Today this recovers nothing: 0020 creates `obligation_capture_receipts`
    // but no code writes it — there is no capture gateway yet — so in practice
    // every pre-existing row takes the NULL path below. The join is kept rather
    // than deferred because it is the correct source the moment receipts start
    // being written, and reconstructing it after the fact would be guesswork.
    //
    // Every other pre-existing row stays NULL. Stamping them with the migration
    // time would assert that 100+ historical obligations were all created the
    // moment this shipped — a fabricated provenance, and precisely the kind of
    // confident-but-false history a recency signal exists to prevent. NULL reads
    // as "predates the column", which is true.
    const receipts = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("obligation_capture_receipts");
    if (receipts) {
      db.exec(`
        UPDATE obligations
        SET created_at = (
              SELECT MIN(receipt.created_at)
              FROM obligation_capture_receipts receipt
              WHERE receipt.obligation_id = obligations.id
            ),
            updated_at = (
              SELECT MIN(receipt.created_at)
              FROM obligation_capture_receipts receipt
              WHERE receipt.obligation_id = obligations.id
            )
        WHERE created_at IS NULL
          AND EXISTS (
            SELECT 1 FROM obligation_capture_receipts receipt
            WHERE receipt.obligation_id = obligations.id
          )
      `);
    }

    // Creator is NOT backfilled at all — #1671: "It must not infer creator from
    // current owner, GitHub author, or thread topology." Legacy rows read as
    // creator-unknown, which is the honest answer.

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_obligations_created_at
        ON obligations(created_at);

      CREATE TABLE IF NOT EXISTS obligation_ready_heads (
        owner_id TEXT PRIMARY KEY,
        head_id TEXT,
        previous_head_id TEXT,
        sequence INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (head_id) REFERENCES obligations(id) ON DELETE CASCADE
      );
    `);

    // Seed existing ready heads in migration 0025.
    const now = new Date().toISOString();
    db.prepare(`
      WITH RECURSIVE
        effective_priority(id, effective_priority, priority_source_id) AS (
          SELECT id, priority, id FROM obligations WHERE parent_id IS NULL
          UNION ALL
          SELECT child.id,
                 COALESCE(child.priority, parent.effective_priority),
                 CASE WHEN child.priority IS NOT NULL THEN child.id ELSE parent.priority_source_id END
          FROM obligations child
          JOIN effective_priority parent ON parent.id = child.parent_id
        )
      INSERT OR IGNORE INTO obligation_ready_heads (owner_id, head_id, previous_head_id, sequence, updated_at)
      SELECT owner_id, id, NULL, 1, ?
      FROM (
        SELECT obligation.owner_id,
               obligation.id,
               ROW_NUMBER() OVER (
                 PARTITION BY obligation.owner_id
                 ORDER BY effective_priority.effective_priority, obligation.id
               ) AS rank
        FROM obligations obligation
        JOIN effective_priority ON effective_priority.id = obligation.id
        WHERE obligation.status = 'ready'
      )
      WHERE rank = 1
    `).run(now);
  },
};
