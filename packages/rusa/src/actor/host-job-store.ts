import { readFileSync, writeFileSync } from "node:fs";

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
 * Persistence boundary for host jobs — mirrors {@link CapabilityGrantStore}: a
 * local JSON file in production ({@link FileHostJobStore}), in-memory for tests.
 * Every read/write is scoped by `actorId` so one actor's tools can never see or
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

/** In-memory host-job store — for tests. */
export class InMemoryHostJobStore implements HostJobStore {
  private readonly jobs = new Map<string, HostJobRecord>();

  submit(job: HostJobRecord): void {
    this.jobs.set(job.id, { ...job });
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
    return job ? { ...job } : undefined;
  }

  findByUnitName(unitName: string): HostJobRecord | undefined {
    for (const job of this.jobs.values()) {
      if (job.unitName === unitName) return { ...job };
    }
    return undefined;
  }

  list(): HostJobRecord[] {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  listFor(actorId: string): HostJobRecord[] {
    return this.list().filter((j) => j.actorId === actorId);
  }

  activeCountFor(actorId: string): number {
    return this.listFor(actorId).filter(isActive).length;
  }
}

/**
 * JSON-file-backed host-job store — mirrors {@link FileCapabilityGrantStore}:
 * rewrites the whole file on every mutation, refreshes from disk on every read
 * so a record written by another process is visible without a restart.
 */
export class FileHostJobStore implements HostJobStore {
  private mem = new InMemoryHostJobStore();

  constructor(private readonly file: string) {
    this.refreshFromDisk();
  }

  private refreshFromDisk(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as { jobs?: HostJobRecord[] };
      const next = new InMemoryHostJobStore();
      for (const j of parsed.jobs ?? []) next.submit(j);
      this.mem = next;
    } catch {
      /* missing / empty / invalid → keep the current in-memory view */
    }
  }

  private flush(): void {
    try {
      writeFileSync(this.file, JSON.stringify({ jobs: this.mem.list() }, null, 2));
    } catch {
      /* best effort — in-memory copy remains authoritative for this process */
    }
  }

  submit(job: HostJobRecord): void {
    this.mem.submit(job);
    this.flush();
  }

  recordStopRequested(id: string, at: string): void {
    this.mem.recordStopRequested(id, at);
    this.flush();
  }

  recordExit(id: string, at: string, exitStatus: string, exitCode?: string): void {
    this.mem.recordExit(id, at, exitStatus, exitCode);
    this.flush();
  }

  get(id: string): HostJobRecord | undefined {
    this.refreshFromDisk();
    return this.mem.get(id);
  }

  findByUnitName(unitName: string): HostJobRecord | undefined {
    this.refreshFromDisk();
    return this.mem.findByUnitName(unitName);
  }

  list(): HostJobRecord[] {
    this.refreshFromDisk();
    return this.mem.list();
  }

  listFor(actorId: string): HostJobRecord[] {
    this.refreshFromDisk();
    return this.mem.listFor(actorId);
  }

  activeCountFor(actorId: string): number {
    this.refreshFromDisk();
    return this.mem.activeCountFor(actorId);
  }
}
