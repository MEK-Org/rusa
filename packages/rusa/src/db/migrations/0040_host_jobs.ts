import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Normalized store for host-plane job records, retiring `host-jobs.json` as a
 * source of truth. One row per job, mirroring the `capability_grants` (0036)
 * and `event_source_owners` (0038) shape: ordinary scalar columns for every
 * field the mesh queries, and `actor_id` owned by the `actors` row that
 * submitted the job.
 *
 * ## Terminal state as columns, not a status enum
 *
 * `stop_requested_at` / `completed_at` / `exit_status` / `exit_code` stay
 * nullable timestamps and values rather than collapsing into one lifecycle
 * enum, matching `capability_grants.revoked_at`. A job that was asked to stop
 * and then exited has both facts, and both are audit-relevant; an enum would
 * have to pick one. "Active" is `completed_at IS NULL` — the same predicate the
 * store already used to decide whether a job still occupies a concurrency slot.
 *
 * `exit_code` is TEXT, not INTEGER: it is systemd's `ExecMainStatus` as
 * reported, and the record has always carried it as a string. Coercing it here
 * would make the value that comes back out differ from the value that went in
 * for anything systemd does not report as a bare integer.
 *
 * ## `unit_name` is UNIQUE
 *
 * The host-job exit endpoint resolves a job by unit name alone when systemd's
 * ExecStopPost fires without a job id (`handleHostJobExit`), and that lookup
 * decides which actor gets woken. Unit names are `job-<handle>-<id>` and so are
 * unique by construction, but the retired JSON store only ever returned the
 * first match in insertion order — with duplicates present it would silently
 * wake whichever actor happened to be inserted first. Making the constraint
 * real turns that into a refusal at import time instead of a misdirected wake.
 *
 * ## `manifest` is one versioned JSON document
 *
 * The read-scope manifest is not decomposed into a child table. The same
 * manifest object is written verbatim into the write-once host-job audit
 * artifact and sha256-hashed at submit time, so the artifact hash is what
 * proves what was authorized. Storing rows assembled from parts would leave the
 * database unable to show it holds *that* document rather than a re-encoding of
 * it. As with `actors.model_config` (0034), the column carries no
 * database-level shape constraint: the versioned document shape is owned and
 * validated by `DbHostJobStore` at the point of consumption.
 *
 * ## `ON DELETE RESTRICT`
 *
 * Matches `capability_grants` and `event_source_owners.actor_id`. A host-job
 * row is durable audit history — it names a submitting actor, the hash of what
 * it submitted, and how the job ended — so it must not disappear silently with
 * its actor. Checked against the repository layer as it stands: `ActorRepository`
 * exposes no delete and retirement is a `retired_at` timestamp, so RESTRICT
 * blocks no production path today and forces a future deletion path to say out
 * loud what becomes of the record of who ran what on the host plane.
 */
export const hostJobs: Migration = {
  id: "0040_host_jobs",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE host_jobs (
        id                    TEXT PRIMARY KEY,
        actor_id              TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        unit_name             TEXT NOT NULL UNIQUE,
        script_label          TEXT NOT NULL,
        manifest              TEXT NOT NULL,
        audit_artifact_path   TEXT NOT NULL,
        audit_artifact_sha256 TEXT NOT NULL,
        runtime_max_sec       INTEGER NOT NULL,
        submitted_at          TEXT NOT NULL,
        stop_requested_at     TEXT,
        completed_at          TEXT,
        exit_status           TEXT,
        exit_code             TEXT
      );

      CREATE INDEX host_jobs_by_actor ON host_jobs (actor_id);

      -- Every submit consults the submitting actor's active-job count before
      -- admitting another, so the concurrency check gets its own partial index
      -- rather than scanning that actor's whole job history each time.
      CREATE INDEX host_jobs_active_by_actor
        ON host_jobs (actor_id) WHERE completed_at IS NULL;
    `);
  },
};
