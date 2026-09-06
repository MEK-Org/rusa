import type Database from "better-sqlite3";
import { z } from "zod";
import type { HostJobManifest, HostJobRecord, HostJobStore } from "../../actor/host-job-store.js";

/**
 * Version of the `host_jobs.manifest` document. The column carries no
 * database-level shape constraint (0040_host_jobs); the shape is owned and
 * validated here, at the point of consumption, exactly as `actors.model_config`
 * is owned by `SqliteActorRepository`.
 */
export const HOST_JOB_MANIFEST_SCHEMA_VERSION = 1;

const manifestDocumentSchema = z
  .object({
    schemaVersion: z.literal(HOST_JOB_MANIFEST_SCHEMA_VERSION),
    readPaths: z.array(z.string()),
  })
  .strict();

type JobRow = {
  id: string;
  actor_id: string;
  unit_name: string;
  script_label: string;
  manifest: string;
  audit_artifact_path: string;
  audit_artifact_sha256: string;
  runtime_max_sec: number;
  submitted_at: string;
  stop_requested_at: string | null;
  completed_at: string | null;
  exit_status: string | null;
  exit_code: string | null;
};

/** Serializes the read-scope manifest as its versioned document. */
export function buildManifestDocument(manifest: HostJobManifest): string {
  return JSON.stringify({
    schemaVersion: HOST_JOB_MANIFEST_SCHEMA_VERSION,
    readPaths: [...manifest.readPaths],
  });
}

function parseManifest(jobId: string, json: string): HostJobManifest {
  try {
    return { readPaths: manifestDocumentSchema.parse(JSON.parse(json)).readPaths };
  } catch (cause) {
    throw new Error(`DbHostJobStore: invalid manifest for host job '${jobId}'`, { cause });
  }
}

function fromRow(row: JobRow): HostJobRecord {
  return {
    id: row.id,
    actorId: row.actor_id,
    unitName: row.unit_name,
    scriptLabel: row.script_label,
    manifest: parseManifest(row.id, row.manifest),
    auditArtifactPath: row.audit_artifact_path,
    auditArtifactSha256: row.audit_artifact_sha256,
    runtimeMaxSec: row.runtime_max_sec,
    submittedAt: row.submitted_at,
    ...(row.stop_requested_at !== null ? { stopRequestedAt: row.stop_requested_at } : {}),
    ...(row.completed_at !== null ? { completedAt: row.completed_at } : {}),
    ...(row.exit_status !== null ? { exitStatus: row.exit_status } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
  };
}

const SELECT_COLUMNS = `id, actor_id, unit_name, script_label, manifest,
  audit_artifact_path, audit_artifact_sha256, runtime_max_sec, submitted_at,
  stop_requested_at, completed_at, exit_status, exit_code`;

// Submit order, and `id` only to make ties deterministic. The retired JSON
// store returned insertion order, which for a store only ever appended to at
// submit time is the same sequence.
const ORDER_BY = "ORDER BY submitted_at, id";

/**
 * SQLite implementation of {@link HostJobStore} — every call reads straight
 * from `host_jobs` with no process-local cache, so a submit or exit committed
 * by another connection is visible to the next call without an orchestrator
 * restart. That matters more here than for the other cut-over stores: the
 * host-job exit endpoint records a terminal state from an HTTP handler while
 * the mesh is concurrently listing and counting the same rows.
 *
 * `actor_id` is owned by the referenced `actors` row (0040_host_jobs). Scoping
 * by actor is a filter, not an authorization check — the per-actor namespace
 * enforcement lives in `host-jobs-mcp.ts`, which only ever calls these methods
 * with the caller's own `selfId`.
 */
export class DbHostJobStore implements HostJobStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert the job, or replace an existing row with the same id. The overwrite
   * mirrors the in-memory store, which keys jobs by id and lets a re-submit
   * win; production ids are freshly minted per submit, so it is reachable only
   * by a caller that reuses one deliberately.
   */
  submit(job: HostJobRecord): void {
    this.db
      .prepare(
        `INSERT INTO host_jobs (
           id, actor_id, unit_name, script_label, manifest,
           audit_artifact_path, audit_artifact_sha256, runtime_max_sec, submitted_at,
           stop_requested_at, completed_at, exit_status, exit_code
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           actor_id = excluded.actor_id,
           unit_name = excluded.unit_name,
           script_label = excluded.script_label,
           manifest = excluded.manifest,
           audit_artifact_path = excluded.audit_artifact_path,
           audit_artifact_sha256 = excluded.audit_artifact_sha256,
           runtime_max_sec = excluded.runtime_max_sec,
           submitted_at = excluded.submitted_at,
           stop_requested_at = excluded.stop_requested_at,
           completed_at = excluded.completed_at,
           exit_status = excluded.exit_status,
           exit_code = excluded.exit_code`
      )
      .run(
        job.id,
        job.actorId,
        job.unitName,
        job.scriptLabel,
        buildManifestDocument(job.manifest),
        job.auditArtifactPath,
        job.auditArtifactSha256,
        job.runtimeMaxSec,
        job.submittedAt,
        job.stopRequestedAt ?? null,
        job.completedAt ?? null,
        job.exitStatus ?? null,
        job.exitCode ?? null
      );
  }

  /** First stop request wins; the unit may still take a moment to exit. */
  recordStopRequested(id: string, at: string): void {
    this.db
      .prepare(
        "UPDATE host_jobs SET stop_requested_at = ? WHERE id = ? AND stop_requested_at IS NULL"
      )
      .run(at, id);
  }

  /** First exit wins, so a duplicate ExecStopPost delivery cannot rewrite it. */
  recordExit(id: string, at: string, exitStatus: string, exitCode?: string): void {
    this.db
      .prepare(
        `UPDATE host_jobs SET completed_at = ?, exit_status = ?, exit_code = ?
         WHERE id = ? AND completed_at IS NULL`
      )
      .run(at, exitStatus, exitCode ?? null, id);
  }

  get(id: string): HostJobRecord | undefined {
    const row = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM host_jobs WHERE id = ?`).get(id) as
      | JobRow
      | undefined;
    return row ? fromRow(row) : undefined;
  }

  findByUnitName(unitName: string): HostJobRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM host_jobs WHERE unit_name = ?`)
      .get(unitName) as JobRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(): HostJobRecord[] {
    return (
      this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM host_jobs ${ORDER_BY}`).all() as JobRow[]
    ).map(fromRow);
  }

  listFor(actorId: string): HostJobRecord[] {
    return (
      this.db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM host_jobs WHERE actor_id = ? ${ORDER_BY}`)
        .all(actorId) as JobRow[]
    ).map(fromRow);
  }

  activeCountFor(actorId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM host_jobs WHERE actor_id = ? AND completed_at IS NULL")
      .get(actorId) as { n: number };
    return row.n;
  }
}
