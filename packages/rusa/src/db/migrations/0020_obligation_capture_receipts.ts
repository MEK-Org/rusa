import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Provenance and outcome for every inbound delivery the capture gateway was
 * obliged to turn into an obligation (ISSUE_NUM leg 2).
 *
 * Keyed on `inbox_entry_id` rather than on a parallel (owner, source) tuple.
 * That identity already exists and is already a primary key: `deliverEvent`
 * derives `dedupe:<sha256(dedupeKey \0 actorId)>` and `actor_inbox_entries`
 * enforces it. A second tuple would be a second identity free to drift from the
 * first, and the FK here makes a receipt for a delivery that never happened
 * unrepresentable.
 *
 * A row exists only for deliveries *inside* the capture scope. Payloads the
 * gateway is not asked to capture (out-of-phase types, and anything explicitly
 * marked non-capturable) write nothing: they are not failed captures, they are
 * not captures at all, and recording them would bury the two states that carry
 * information under one row per webhook.
 *
 * `obligation_id` is nullable on purpose. A capture that fails still writes a
 * receipt, in the same transaction as the delivery it failed to capture, so
 * "delivered but uncaptured" is an explicit durable state rather than an
 * invisible crash window.
 */
export const obligationCaptureReceipts: Migration = {
  id: "0020_obligation_capture_receipts",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE obligation_capture_receipts (
        inbox_entry_id TEXT PRIMARY KEY
          REFERENCES actor_inbox_entries(id) ON DELETE CASCADE,
        obligation_id  TEXT REFERENCES obligations(id) ON DELETE RESTRICT,
        actor_id       TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
        source_type    TEXT NOT NULL CHECK (length(trim(source_type)) > 0),
        status         TEXT NOT NULL CHECK (status IN ('captured', 'failed')),
        failure_class  TEXT CHECK (
          failure_class IN ('unidentifiable-source', 'create-failed')
        ),
        reason         TEXT,
        created_at     TEXT NOT NULL,
        CHECK (status <> 'captured' OR obligation_id IS NOT NULL),
        CHECK (status <> 'captured' OR failure_class IS NULL),
        CHECK (status <> 'failed' OR (failure_class IS NOT NULL AND obligation_id IS NULL))
      );

      CREATE INDEX idx_capture_receipts_actor_status
        ON obligation_capture_receipts(actor_id, status, created_at);
      CREATE INDEX idx_capture_receipts_obligation
        ON obligation_capture_receipts(obligation_id);
    `);
  },
};
