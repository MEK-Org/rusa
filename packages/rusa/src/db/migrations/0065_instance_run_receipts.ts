import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Durable terminal receipts between an executing host and the control leader
 * (#1020). Both roles open the same lineage; each writes only its own side.
 *
 * A receipt is keyed by the run ID it closes: the host mints that ID and
 * registers it with the leader through `runStart`, and the leader validates
 * every receipt against the instance that registered the run (#1119 ruling,
 * superseding the per-instance sequence). A colliding registration fails on
 * the `actor_runs` primary key and changes nothing. One instance identity has
 * one writer: run-ID keying does not detect a cloned store or copied
 * credentials writing as the same identity, and nothing here claims to.
 *
 * On the host, `host_runs` records which identity opened each receipt-backed
 * run, so a re-enrolled store neither relabels nor closes another identity's
 * runs. `host_run_receipts` commits a run's local terminal and its receipt in
 * one transaction, as the exact bytes every retry sends; `id` is local commit
 * order, which delivery pages by. A row is pending until the leader durably
 * answers for it and is then deleted: the closed `actor_runs` row is the
 * host's record of the terminal. Deleting the highest row lets SQLite reuse
 * its id, which is still above every pending row, so pending receipts keep
 * their commit order.
 *
 * The leader records which remote runs started under the contract
 * (`instance_runs`, whose `returned_at` notes a successful provider return
 * seen over the transport: it spends the selected-work recovery budget
 * without asserting termination or closing the run), applies at most one terminal per run
 * (`instance_run_terminals`, which keeps the applied receipt's digest, not its
 * bytes: the closed `actor_runs` row carries its content), and keeps refused
 * receipts as bounded conflicts (`instance_receipt_conflicts`, full bytes as
 * evidence) without touching an accepted terminal. Its open `instance_runs`
 * rows are the unresolved-run inventory: they do not say whether a run is
 * still executing or its terminal was lost.
 * `receipt` is a versioned JSON document validated by its readers. No table
 * repeats an actor ID: `actor_runs` owns that column, and a receipt document
 * is immutable, so the configured-actor rekey (#1005) leaves it as the bytes
 * the host committed.
 */
export const instanceRunReceipts: Migration = {
  id: "0065_instance_run_receipts",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE host_runs (
        run_id TEXT PRIMARY KEY REFERENCES actor_runs(id) ON DELETE CASCADE,
        instance_id TEXT NOT NULL,
        started_at TEXT NOT NULL
      );

      CREATE TABLE host_run_receipts (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        instance_id TEXT NOT NULL,
        receipt TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_host_run_receipts_instance
        ON host_run_receipts(instance_id, id);

      CREATE TABLE instance_runs (
        run_id TEXT PRIMARY KEY REFERENCES actor_runs(id) ON DELETE CASCADE,
        instance_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        returned_at TEXT
      );

      CREATE TABLE instance_run_terminals (
        run_id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE TABLE instance_receipt_conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('run_conflict', 'wrong_instance', 'unknown_run')),
        digest TEXT NOT NULL,
        receipt TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE INDEX idx_instance_receipt_conflicts_run
        ON instance_receipt_conflicts(instance_id, run_id);
    `);
  },
};
