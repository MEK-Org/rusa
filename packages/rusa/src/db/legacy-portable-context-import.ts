import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  type PortableContextState,
  parsePortableContextState,
} from "../actor/portable-context-state.js";
import type { Repositories } from "./repositories/index.js";

/**
 * Basename of the retired portable-context directory under `$RUSA_HOME`.
 * SQLite is authoritative for snapshots; this name survives only so the
 * one-time importer can find, import and archive a directory left over from
 * before the cutover.
 */
export const PORTABLE_CONTEXT_DIRNAME = "portable-context";

/** The receipt key for this source; see {@link LegacyImportReceiptRepository}. */
export const PORTABLE_CONTEXT_IMPORT_SOURCE = PORTABLE_CONTEXT_DIRNAME;

/** The read-only slice of {@link Repositories} a plan is allowed to touch. */
interface PlanRepositories {
  actors: Pick<Repositories["actors"], "list">;
  portableContext: Pick<Repositories["portableContext"], "count">;
  legacyImportReceipts: Pick<Repositories["legacyImportReceipts"], "has">;
}

/** One legacy snapshot file, already read forward to the current schema version. */
export interface PlannedPortableContextSnapshot {
  actorId: string;
  state: PortableContextState;
}

// Mirrors the archive helpers in the other legacy importers: rename rather than
// delete, so the pre-import source is always recoverable after a commit. The
// whole directory moves in one rename, which is why an interrupted archive can
// only leave the source entirely present or entirely archived — never a
// half-imported directory whose remaining files look like the complete view.
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

export interface LegacyPortableContextImportResult {
  importedSnapshots: number;
  backupFiles: string[];
}

/** A read-only plan of what {@link applyLegacyPortableContextImport} would do. */
export type LegacyPortableContextImportPlan =
  | { kind: "noop" }
  | { kind: "already-imported" }
  | { kind: "import"; snapshots: PlannedPortableContextSnapshot[] };

export interface LegacyPortableContextImportPlanResult {
  plan: LegacyPortableContextImportPlan;
  hasDirectory: boolean;
  directoryPath: string;
  /** Snapshot rows the plan would write. */
  plannedSnapshots: number;
}

/** Legacy snapshot files, in a stable order so a refusal names the same file every run. */
function snapshotFiles(directoryPath: string): string[] {
  // `.json` only. A crashed `FilePortableContextStore.save()` could leave a
  // `<actor>.json.<pid>.<uuid>.tmp` beside the real file — a partial write by
  // construction, which nothing ever read as state. Those, and anything else an
  // operator parked here, travel untouched into the archive rather than being
  // parsed or deleted.
  return readdirSync(directoryPath)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/**
 * Parse and validate every `portable-context/<actorId>.json` snapshot against
 * the current `portable_context_snapshots` projection without performing any
 * write. Only accepts a read-only slice of {@link Repositories}, so it cannot
 * open a DB transaction, write a snapshot, or archive the legacy directory.
 *
 * Refuses — rather than importing a partial view — whenever any file fails to
 * resolve. A snapshot is authoritative memory: its ledger item ids, statuses,
 * priorities, generation counter and `lastFoldedSourceId` were minted by a
 * model fold and cannot be rebuilt from the messages and run outputs they were
 * folded from. Importing the readable subset would make "this actor never
 * remembered any of that" durable while the cursor it kept moves on. Refusal
 * costs nothing by comparison: nothing is written, the directory is untouched,
 * the error names the offending file, and the next boot re-plans.
 *
 * This is also no stricter than the retired file store, which `parse()`d the
 * same document on every load and threw out of `buildPrompt` — uncaught — when
 * it failed. The strictness is unchanged; what moves is when it is discovered,
 * from one actor's first run to the boot that imports.
 *
 * @param options.pendingActorIds Actor ids that a legacy actor import has
 * planned but not yet committed. Preflight (`rusa db-check`) plans every import
 * against one un-mutated copy, where a snapshot's actor may legitimately not be
 * in `actors` yet.
 */
export function planLegacyPortableContextImport(options: {
  mcHome: string;
  repositories: PlanRepositories;
  pendingActorIds?: Iterable<string>;
}): LegacyPortableContextImportPlanResult {
  const directoryPath = join(options.mcHome, PORTABLE_CONTEXT_DIRNAME);
  const hasDirectory = existsSync(directoryPath) && statSync(directoryPath).isDirectory();
  if (!hasDirectory) {
    return { plan: { kind: "noop" }, hasDirectory, directoryPath, plannedSnapshots: 0 };
  }

  // The receipt is the precedence rule: once the import transaction committed,
  // SQLite is authoritative and a source directory still on disk is stale by
  // construction — a failed archive rename, or a restored backup. Reading it
  // again could only overwrite durable snapshots the mesh has since folded past.
  if (options.repositories.legacyImportReceipts.has(PORTABLE_CONTEXT_IMPORT_SOURCE)) {
    return { plan: { kind: "already-imported" }, hasDirectory, directoryPath, plannedSnapshots: 0 };
  }

  const snapshots: PlannedPortableContextSnapshot[] = [];
  for (const name of snapshotFiles(directoryPath)) {
    const filePath = join(directoryPath, name);
    const actorId = name.slice(0, -".json".length);
    let state: PortableContextState;
    try {
      state = parsePortableContextState(JSON.parse(readFileSync(filePath, "utf8")));
    } catch (cause) {
      throw new Error(
        `Legacy portable-context import: cannot read ${filePath}; ` +
          "refusing to import a partial memory view",
        { cause }
      );
    }
    // The file store keyed a snapshot by filename and checked the document
    // agreed on every load. Keeping that check here means the durable
    // `actor_id` is the same key the retired store served the state under.
    if (state.actorId !== actorId) {
      throw new Error(
        `Legacy portable-context import: ${filePath} holds a snapshot for actor ` +
          `'${state.actorId}'; refusing to file one actor's memory under another`
      );
    }
    snapshots.push({ actorId, state });
  }

  const actorIds = new Set(options.repositories.actors.list().map((actor) => actor.id));
  for (const id of options.pendingActorIds ?? []) actorIds.add(id);
  for (const { actorId } of snapshots) {
    if (!actorIds.has(actorId)) {
      throw new Error(
        `Legacy portable-context import: ${join(directoryPath, `${actorId}.json`)} ` +
          `references unknown actor '${actorId}'`
      );
    }
  }

  // No receipt but durable snapshots already exist: something folded outside
  // the importer, so neither side can be shown to be newer. Refuse rather than
  // guess which memory survives. This is table-wide, not per file — the
  // receipt is the precedence boundary for the whole source, so a directory
  // holding only actors the database has never folded still cannot be
  // blessed alongside rows that arrived some other way: that would issue a
  // receipt for a database whose memory came from two provenances at once.
  const durable = options.repositories.portableContext.count();
  if (durable > 0) {
    throw new Error(
      `Legacy portable-context import: ${directoryPath} is present but ${durable} durable ` +
        "snapshot(s) were written without an import receipt; refusing to overwrite them"
    );
  }

  return {
    plan: { kind: "import", snapshots },
    hasDirectory,
    directoryPath,
    plannedSnapshots: snapshots.length,
  };
}

/**
 * Apply a {@link LegacyPortableContextImportPlan} produced by
 * {@link planLegacyPortableContextImport} for the same home: write the durable
 * snapshots and the import receipt in one transaction, then archive the legacy
 * directory.
 *
 * The two steps split the failure modes cleanly. An interruption before commit
 * leaves no rows and no receipt, so the next boot re-plans against the intact
 * directory and gets the complete legacy view. An interruption after commit
 * leaves rows and a receipt, so the next boot sees the receipt, archives the
 * directory unread, and gets the complete database view. There is no ordering
 * that yields a mixture.
 */
export function applyLegacyPortableContextImport(
  planResult: LegacyPortableContextImportPlanResult,
  options: { db: Database.Database; repositories: Repositories; now?: () => string }
): LegacyPortableContextImportResult {
  const { plan, directoryPath } = planResult;
  const now = options.now ?? (() => new Date().toISOString());

  switch (plan.kind) {
    case "noop":
      return { importedSnapshots: 0, backupFiles: [] };

    case "already-imported":
      return { importedSnapshots: 0, backupFiles: [archive(directoryPath)] };

    case "import": {
      const { snapshots } = plan;
      options.db.transaction(() => {
        for (const { state } of snapshots) options.repositories.portableContext.save(state);
        options.repositories.legacyImportReceipts.record(
          PORTABLE_CONTEXT_IMPORT_SOURCE,
          now(),
          snapshots.length
        );
      })();
      return { importedSnapshots: snapshots.length, backupFiles: [archive(directoryPath)] };
    }
  }
}

/**
 * Import the retired `portable-context/` directory exactly once: plan, then
 * apply. See {@link planLegacyPortableContextImport} and
 * {@link applyLegacyPortableContextImport}.
 */
export function importLegacyPortableContextState(options: {
  mcHome: string;
  db: Database.Database;
  repositories: Repositories;
}): LegacyPortableContextImportResult {
  const planResult = planLegacyPortableContextImport(options);
  return applyLegacyPortableContextImport(planResult, options);
}
