/**
 * Basename of the retired host-job JSON under `$RUSA_HOME`. SQLite is
 * authoritative for host jobs; this name survives only so the one-time legacy
 * importer can find, import and archive a file left over from before the
 * cutover.
 */
export const HOST_JOBS_FILENAME = "host-jobs.json";

/**
 * A job's deny-by-default read-scope allow-list . Empty by default: a
 * submitted job can read nothing beyond the base OS/toolchain visibility until
 * the submitter explicitly lists a path here. Enforced by
 * {@link ../host-job-runner.js buildHostJobBwrapArgs} (shadow-then-punch-holes)
 * and validated against a hard denylist before a job is ever submitted — see
 * `validateManifest` in `host-job-runner.ts`.
 */
export interface HostJobManifest {
  readPaths: string[];
}

/**
 * One host-plane job launched through the `host-jobs` grantable capability. Runs
 * in a transient `systemd-run --user --collect` unit, cgroup-scoped so a deploy
 * restart can't orphan it  — see `host-job-runner.ts` for the exact
 * invocation. `scriptLabel` is display-only; the audit artifact pointer + hash
 * are the durable source of truth for exactly what was submitted.
 */
export interface HostJobRecord {
  id: string;
  /** The submitting/owning actor — the only actor allowed to list/status/stop it. */
  actorId: string;
  /** The transient unit name: `job-<handle>-<id>`, resolved server-side only. */
  unitName: string;
  /** Short display-only human label for the script; never the audit record. */
  scriptLabel: string;
  manifest: HostJobManifest;
  /** Host-plane-only, write-once artifact containing script + args + manifest. */
  auditArtifactPath: string;
  /** sha256 of the bytes at `auditArtifactPath`, stamped at submit time. */
  auditArtifactSha256: string;
  /** RuntimeMaxSec backstop actually applied (submitter-requested, capped). */
  runtimeMaxSec: number;
  submittedAt: string;
  /** Set once `stop_job` is called; the unit may still take a moment to exit. */
  stopRequestedAt?: string;
  /** Set once the unit actually exits (ExecStopPost wake-on-exit fired). */
  completedAt?: string;
  /** systemd's reported result (`success`, `exit-code`, `signal`, `oom-kill`, …). */
  exitStatus?: string;
  /** The unit's `ExecMainStatus` (numeric exit code as a string), when known. */
  exitCode?: string;
}

/** A job is still occupying a concurrency slot until it's known to have exited. */
function isActive(job: HostJobRecord): boolean {
  return job.completedAt === undefined;
}

/**
 * Persistence boundary for host jobs — mirrors {@link CapabilityGrantStore}:
 * SQLite in production (`DbHostJobStore`), in-memory for tests. Every
 * read/write is scoped by `actorId` so one actor's tools can never see or
 * mutate another actor's jobs (the per-actor namespace enforcement lives one
 * layer up, in `host-jobs-mcp.ts`, by only ever calling these methods with the
 * caller's own `selfId`).
 */
export interface HostJobStore {
  submit(job: HostJobRecord): void;
  recordStopRequested(id: string, at: string): void;
  recordExit(id: string, at: string, exitStatus: string, exitCode?: string): void;
  get(id: string): HostJobRecord | undefined;
  findByUnitName(unitName: string): HostJobRecord | undefined;
  /** Every job, every actor — the file store's persistence view. */
  list(): HostJobRecord[];
  listFor(actorId: string): HostJobRecord[];
  activeCountFor(actorId: string): number;
}

/**
 * Copy a record deeply enough that a caller holding one cannot reach back into
 * stored state. `manifest` is the only nested value, and it is the job's
 * read-scope allow-list, so a shared reference would let a holder of a returned
 * record widen what a stored job claims to have been authorized to read.
 */
function copy(job: HostJobRecord): HostJobRecord {
  return { ...job, manifest: { readPaths: [...job.manifest.readPaths] } };
}

/** In-memory host-job store — for tests. */
export class InMemoryHostJobStore implements HostJobStore {
  private readonly jobs = new Map<string, HostJobRecord>();

  submit(job: HostJobRecord): void {
    this.jobs.set(job.id, copy(job));
  }

  recordStopRequested(id: string, at: string): void {
    const existing = this.jobs.get(id);
    if (!existing || existing.stopRequestedAt) return;
    this.jobs.set(id, { ...existing, stopRequestedAt: at });
  }

  recordExit(id: string, at: string, exitStatus: string, exitCode?: string): void {
    const existing = this.jobs.get(id);
    if (!existing || existing.completedAt) return;
    this.jobs.set(id, { ...existing, completedAt: at, exitStatus, exitCode });
  }

  get(id: string): HostJobRecord | undefined {
    const job = this.jobs.get(id);
    return job ? copy(job) : undefined;
  }

  findByUnitName(unitName: string): HostJobRecord | undefined {
    for (const job of this.jobs.values()) {
      if (job.unitName === unitName) return copy(job);
    }
    return undefined;
  }

  list(): HostJobRecord[] {
    return [...this.jobs.values()].map(copy);
  }

  listFor(actorId: string): HostJobRecord[] {
    return this.list().filter((j) => j.actorId === actorId);
  }

  activeCountFor(actorId: string): number {
    return this.listFor(actorId).filter(isActive).length;
  }
}
