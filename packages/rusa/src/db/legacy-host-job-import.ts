import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { z } from "zod";
import { HOST_JOBS_FILENAME, type HostJobRecord } from "../actor/host-job-store.js";
import type { Repositories } from "./repositories/index.js";

/** The receipt key for this source; see {@link LegacyImportReceiptRepository}. */
export const HOST_JOB_IMPORT_SOURCE = HOST_JOBS_FILENAME;

/** The read-only slice of {@link Repositories} a plan is allowed to touch. */
interface PlanRepositories {
  actors: Pick<Repositories["actors"], "list">;
  hostJobs: Pick<Repositories["hostJobs"], "list">;
  legacyImportReceipts: Pick<Repositories["legacyImportReceipts"], "has">;
}

const legacyJobSchema = z
  .object({
    id: z.string().min(1),
    actorId: z.string().min(1),
    unitName: z.string().min(1),
    scriptLabel: z.string(),
    manifest: z.object({ readPaths: z.array(z.string()) }).strict(),
    auditArtifactPath: z.string().min(1),
    auditArtifactSha256: z.string().min(1),
    runtimeMaxSec: z.number().int().nonnegative(),
    submittedAt: z.string().min(1),
    stopRequestedAt: z.string().min(1).optional(),
    completedAt: z.string().min(1).optional(),
    exitStatus: z.string().optional(),
    exitCode: z.string().optional(),
  })
  .strict();
const legacyFileSchema = z.object({ jobs: z.array(legacyJobSchema) }).strict();

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new Error(`Legacy host-job import: cannot parse ${path}`, { cause });
  }
}

// Mirrors legacy-actor-import.ts's archive helpers: rename rather than
// delete, so the pre-import file is always recoverable after a commit.
function backupPath(path: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  let candidate = `${path}.imported-${timestamp}.bak`;
  let suffix = 1;
  while (existsSync(candidate)) candidate = `${path}.imported-${timestamp}-${suffix++}.bak`;
  return candidate;
}

function archive(path: string): string {
  const destination = backupPath(path);
  renameSync(path, destination);
  return destination;
}

export interface LegacyHostJobImportResult {
  importedJobs: number;
  backupFiles: string[];
}

/** A read-only plan of what {@link applyLegacyHostJobImport} would do, with no writes performed. */
export type LegacyHostJobImportPlan =
  | { kind: "noop" }
  | { kind: "already-imported" }
  | { kind: "import"; jobs: HostJobRecord[] };

export interface LegacyHostJobImportPlanResult {
  plan: LegacyHostJobImportPlan;
  hasFile: boolean;
  filePath: string;
  /** Job rows the plan would write. */
  plannedJobs: number;
}

/**
 * Parse and validate `host-jobs.json` against the current `host_jobs`
 * projection without performing any write. Only accepts a read-only slice of
 * {@link Repositories}, so it cannot open a DB transaction, write a job, or
 * archive the legacy file.
 *
 * Refuses — rather than importing a partial view — whenever a row fails to
 * resolve. The retired JSON store parsed the file with an unchecked cast and
 * silently kept whatever came back, which is survivable for a file that stays
 * reparable in place; committing a subset is not, because it would make "this
 * actor never ran this job" durable and drop the pointer to that job's
 * write-once audit artifact.
 *
 * Two conflicts are refused that the JSON store resolved silently:
 *
 * - **Repeated unit names across distinct job ids.** The store returned the
 *   first insertion-order match from `findByUnitName`, so an exit delivered
 *   with only a unit name could wake the wrong actor. `host_jobs.unit_name` is
 *   UNIQUE, and naming the collision here beats surfacing a bare constraint
 *   error from inside the transaction.
 * - **A job owned by an actor with no `actors` row**, matching every other
 *   legacy importer.
 *
 * A repeated job *id* is not a conflict: later entries win, exactly as
 * `FileHostJobStore.refreshFromDisk()` resolved it by replaying `submit` into
 * an id-keyed map.
 *
 * @param options.pendingActorIds Actor ids that a legacy actor import has
 * planned but not yet committed. Preflight (`rusa db-check`) plans both imports
 * against one un-mutated copy, where the actor that owns a job may legitimately
 * not be in `actors` yet.
 */
export function planLegacyHostJobImport(options: {
  mcHome: string;
  repositories: PlanRepositories;
  pendingActorIds?: Iterable<string>;
}): LegacyHostJobImportPlanResult {
  const filePath = join(options.mcHome, HOST_JOBS_FILENAME);
  const hasFile = existsSync(filePath);
  if (!hasFile) {
    return { plan: { kind: "noop" }, hasFile, filePath, plannedJobs: 0 };
  }

  // The receipt is the precedence rule: once the import transaction committed,
  // SQLite is authoritative and a source file still on disk is stale by
  // construction — a failed archive rename, or a restored backup. Reading it
  // again could only overwrite durable rows the mesh has since moved on from.
  if (options.repositories.legacyImportReceipts.has(HOST_JOB_IMPORT_SOURCE)) {
    return { plan: { kind: "already-imported" }, hasFile, filePath, plannedJobs: 0 };
  }

  const parsed = legacyFileSchema.safeParse(readJson(filePath));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Legacy host-job import: ${filePath} has unresolved row(s); ` +
        `refusing to import a partial host-job view (${detail})`
    );
  }

  // A repeated id resolves the way the retired store resolved it: last wins.
  const byId = new Map<string, HostJobRecord>();
  for (const job of parsed.data.jobs) byId.set(job.id, job);
  const jobs = [...byId.values()];

  const byUnitName = new Map<string, string>();
  for (const job of jobs) {
    const owner = byUnitName.get(job.unitName);
    if (owner !== undefined) {
      throw new Error(
        `Legacy host-job import: unit name '${job.unitName}' is claimed by both job ` +
          `'${owner}' and job '${job.id}'; refusing to import an ambiguous exit route`
      );
    }
    byUnitName.set(job.unitName, job.id);
  }

  const actorIds = new Set(options.repositories.actors.list().map((actor) => actor.id));
  for (const id of options.pendingActorIds ?? []) actorIds.add(id);
  for (const job of jobs) {
    if (!actorIds.has(job.actorId)) {
      throw new Error(
        `Legacy host-job import: job '${job.id}' references unknown actor '${job.actorId}'`
      );
    }
  }

  // No receipt but durable rows already exist: something wrote host jobs
  // outside the importer, so neither side can be shown to be newer. Refuse
  // rather than guess which job history survives.
  const existing = options.repositories.hostJobs.list();
  if (existing.length > 0) {
    throw new Error(
      `Legacy host-job import: ${filePath} is present but ${existing.length} durable host ` +
        "job(s) were written without an import receipt; refusing to overwrite them"
    );
  }

  return { plan: { kind: "import", jobs }, hasFile, filePath, plannedJobs: jobs.length };
}

/**
 * Apply a {@link LegacyHostJobImportPlan} produced by
 * {@link planLegacyHostJobImport} for the same home: write the durable rows and
 * the import receipt in one transaction, then archive the legacy file.
 *
 * The two steps split the failure modes cleanly. An interruption before commit
 * leaves no rows and no receipt, so the next boot re-plans against the intact
 * file and gets the complete legacy view. An interruption after commit leaves
 * rows and a receipt, so the next boot sees the receipt, archives the file
 * unread, and gets the complete database view. There is no ordering that yields
 * a mixture.
 */
export function applyLegacyHostJobImport(
  planResult: LegacyHostJobImportPlanResult,
  options: { db: Database.Database; repositories: Repositories; now?: () => string }
): LegacyHostJobImportResult {
  const { plan, filePath } = planResult;
  const now = options.now ?? (() => new Date().toISOString());

  switch (plan.kind) {
    case "noop":
      return { importedJobs: 0, backupFiles: [] };

    case "already-imported":
      return { importedJobs: 0, backupFiles: [archive(filePath)] };

    case "import": {
      const { jobs } = plan;
      options.db.transaction(() => {
        // `submit` writes every field including terminal state, so a job that
        // had already exited lands exited rather than being resurrected as an
        // active one occupying a concurrency slot.
        for (const job of jobs) options.repositories.hostJobs.submit(job);
        options.repositories.legacyImportReceipts.record(
          HOST_JOB_IMPORT_SOURCE,
          now(),
          jobs.length
        );
      })();
      return { importedJobs: jobs.length, backupFiles: [archive(filePath)] };
    }
  }
}

/**
 * Import the retired `host-jobs.json` file exactly once: plan, then apply.
 * See {@link planLegacyHostJobImport} and {@link applyLegacyHostJobImport}.
 */
export function importLegacyHostJobState(options: {
  mcHome: string;
  db: Database.Database;
  repositories: Repositories;
}): LegacyHostJobImportResult {
  const planResult = planLegacyHostJobImport(options);
  return applyLegacyHostJobImport(planResult, options);
}
