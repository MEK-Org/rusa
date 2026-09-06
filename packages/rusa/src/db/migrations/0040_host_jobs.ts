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
 * decides which actor gets woken. This is the one place the durable store is
 * deliberately stricter than the JSON store it replaces, so what motivates it
 * is worth being exact about: no duplicate has been observed, and none is
 * expected. Unit names are `job-<handle>-<8 hex chars of a v4 uuid>`, which is
 * near-unique rather than unique by construction — 32 bits, minted per submit,
 * with nothing before this constraint checking the result. The retired store
 * returned the first insertion-order match from `findByUnitName`, so a
 * collision there would have silently woken whichever actor was inserted
 * first, with no trace. The constraint turns a silent misroute into a refusal:
 * for a live submit, before the unit is launched (see `submit_job`), and for
 * legacy data, at import time.
 *
 * Refusing the whole legacy import rather than quarantining the ambiguous rows
 * is the same choice every shipped importer makes, for the same reason: the
 * cheaper treatment has to drop one of two jobs that share a unit name, which
 * makes "this actor never ran this job" durable and drops the pointer to that
 * job's write-once audit artifact, while the surviving twin still answers an
 * exit that may belong to the dropped one. Refusal is repairable in place —
 * the file is untouched, the plan names both job ids and the unit, and the
 * next boot re-plans — and only reachable through a hand-edited or merged
 * legacy file, since nothing in the retired store ever wrote a duplicate.
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

      -- One index, on the only column anything filters by. Every host-job read
      -- is per-actor (list, and the active-job count each submit consults), and
      -- an actor's history is what that one actor has ever submitted while
      -- capped at 5 concurrently active, so the completed_at IS NULL filter
      -- runs over rows this index already located. A partial index for the
      -- active count would be a second durable write-path construct bought
      -- with no measurement; add it when real job volumes show the filter is
      -- material.
      CREATE INDEX host_jobs_by_actor ON host_jobs (actor_id);
    `);
  },
};
