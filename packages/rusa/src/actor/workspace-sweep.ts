/**
 * Removing the workspaces of actors that have retired.
 *
 * An actor works in a directory, and that directory outlives the actor. rusa
 * deletes its own `<mcHome>/workers/<actorId>` when an actor retires, but a
 * provider CLI keeps a second workspace of its own that nothing ever removed —
 * so that area accumulates one directory per actor that has ever run, each
 * still holding whatever that actor cloned into it.
 *
 * That accumulation is the defect (#3): every one of those directories is
 * readable by every worker running now, so a worker's effective read access is
 * the union of everything every past worker ever checked out, regardless of
 * what its own task granted it. Deleting a retired actor's workspace means
 * there is nothing left there to reach sideways into.
 *
 * The rule is deliberately narrow, because the provider's area is shared with
 * material rusa did not put there: a directory is removed only when its name
 * resolves to an actor the registry knows *and* that record says retired.
 * Nothing is deleted on the strength of its name alone.
 */

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The three spellings of one actor's workspace, all seen live in the same
 * provider area: `worker-a1b2c3d4`, the bare `a1b2c3d4`, and the whole actor id.
 * The first two carry only the id's leading segment, which is why the caller
 * supplies the registry — eight hex characters name an actor only if an actor
 * by that prefix exists.
 */
const WORKSPACE_NAME =
  /^(?:worker-)?([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;

/** The actor a workspace directory is named for, or null if it names no actor. */
function workspaceActorPrefix(name: string): string | null {
  return WORKSPACE_NAME.exec(name)?.[1] ?? null;
}

/** Every path a provider CLI might have given `actorId`, so retirement can delete it. */
export function actorWorkspaceNames(actorId: string): string[] {
  const prefix = actorId.slice(0, 8);
  return [`worker-${prefix}`, prefix, actorId];
}

function subdirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // The area need not exist — a mesh that has never run this provider has no
    // scratch directory, which is not a condition to report.
    return [];
  }
}

export interface WorkspaceSweepOptions {
  /** rusa's own worker directories, named with the whole actor id. */
  workersDir: string;
  /** The provider CLI's workspace area, shared with unrelated material. */
  scratchDir: string;
  /**
   * Every actor the registry knows, live and retired. A workspace survives
   * unless this says its actor retired, so a registry that cannot be read
   * sweeps nothing rather than everything.
   */
  actors: readonly { id: string; retired: boolean }[];
}

/**
 * Absolute paths of the workspaces of actors that have retired.
 *
 * `root`, `quota-probe-<provider>` and `model-probe-<provider>` share the
 * workers directory and are not actors that retire; the provider's area holds
 * directories that were never a workspace at all. None of them resolves to a
 * retired actor, so none is ever a candidate.
 */
export function orphanedWorkspaces(opts: WorkspaceSweepOptions): string[] {
  const live = new Set<string>();
  const retired = new Set<string>();
  for (const actor of opts.actors) {
    (actor.retired ? retired : live).add(actor.id.slice(0, 8));
  }

  const orphans: string[] = [];
  for (const [dir, names] of [
    [opts.workersDir, subdirectories(opts.workersDir)],
    [opts.scratchDir, subdirectories(opts.scratchDir)],
  ] as const) {
    for (const name of names) {
      const prefix = workspaceActorPrefix(name);
      // A prefix shared by a live actor keeps the directory: eight hex is short,
      // and losing a retired actor's workspace to a collision costs a delayed
      // cleanup, where losing a live actor's costs it the work in progress.
      if (prefix && retired.has(prefix) && !live.has(prefix)) orphans.push(join(dir, name));
    }
  }
  return orphans;
}

/**
 * Delete every workspace {@link orphanedWorkspaces} names, and answer what was
 * actually removed.
 *
 * One failing directory does not stop the rest: removal can fail for reasons
 * that have nothing to do with the next entry — a read-only mount over part of
 * the tree, for instance — and this runs during boot, which must not abort over
 * housekeeping.
 */
export function sweepOrphanedWorkspaces(
  opts: WorkspaceSweepOptions & { log?: (message: string) => void }
): string[] {
  const removed: string[] = [];
  for (const path of orphanedWorkspaces(opts)) {
    try {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    } catch (err) {
      opts.log?.(
        `[start] could not remove orphaned workspace ${path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return removed;
}
