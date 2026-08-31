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

import { existsSync, readdirSync, rmSync } from "node:fs";
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

/** An actor as this module needs to see it: an id, and whether it still runs. */
export interface ActorLiveness {
  id: string;
  retired: boolean;
}

/**
 * The id prefixes of the actors still running — the claim that keeps a
 * directory. `except` is the actor being retired right now, whose own record
 * may still read active at the moment its cleanup runs; it must not be counted
 * as the live claimant on its own workspace.
 */
function liveActorPrefixes(actors: readonly ActorLiveness[], except?: string): Set<string> {
  const live = new Set<string>();
  for (const actor of actors) {
    if (actor.retired || actor.id === except) continue;
    live.add(actor.id.slice(0, 8));
  }
  return live;
}

/**
 * The workspaces of `actorId` that are safe to remove now that it has retired.
 *
 * The whole-id spelling names one actor and always goes. The two short
 * spellings carry only the id's leading eight hex characters, which another
 * actor may answer to as well — and the two mistakes cost very differently:
 * leaving a retired actor's directory delays a cleanup until some later boot
 * sweep, where removing a live actor's takes its work in progress with it. So a
 * contested short spelling is left behind, for the sweep to collect once the
 * actor holding the prefix has retired too.
 */
export function removableWorkspaceNames(
  actorId: string,
  actors: readonly ActorLiveness[]
): string[] {
  const prefix = actorId.slice(0, 8);
  if (liveActorPrefixes(actors, actorId).has(prefix)) return [actorId];
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
  actors: readonly ActorLiveness[];
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
  const live = liveActorPrefixes(opts.actors);
  const retiredIds = new Set<string>();
  const retiredPrefixes = new Set<string>();
  for (const actor of opts.actors) {
    if (actor.retired) {
      retiredIds.add(actor.id);
      retiredPrefixes.add(actor.id.slice(0, 8));
    }
  }

  const orphans: string[] = [];

  // workersDir holds only directories named with the exact actor ID (full UUID).
  for (const name of subdirectories(opts.workersDir)) {
    if (retiredIds.has(name)) {
      orphans.push(join(opts.workersDir, name));
    }
  }

  // scratchDir can hold full UUID, worker-<prefix>, or bare <prefix> spellings.
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const PREFIX_REGEX = /^(?:worker-)?([0-9a-f]{8})$/;

  for (const name of subdirectories(opts.scratchDir)) {
    if (UUID_REGEX.test(name)) {
      if (retiredIds.has(name)) {
        orphans.push(join(opts.scratchDir, name));
      }
    } else {
      const match = PREFIX_REGEX.exec(name);
      if (match) {
        const prefix = match[1];
        if (retiredPrefixes.has(prefix) && !live.has(prefix)) {
          orphans.push(join(opts.scratchDir, name));
        }
      }
    }
  }

  return orphans;
}

/**
 * Repository checkouts in the provider's area that name no actor at all.
 *
 * The sweep removes only what it can attribute to a retired actor, which is the
 * right rule for deleting — but it also means a directory someone named by hand
 * (`mc-1283`, `pr1587`) keeps its checkout indefinitely and silently, and a
 * checkout is precisely the exposure #3 is about: repository content every
 * worker can read. Those are reported rather than removed.
 *
 * Reported, because content is not evidence of ownership. The same area holds
 * shared clones that are legitimately in use, and nothing in a directory
 * distinguishes one of those from a stray — so deleting on the strength of
 * "looks like a repo" would eventually take a clone someone is working in,
 * which costs far more than a directory that lingers until a human reads the
 * line and removes it.
 */
export function unattributedCheckouts(opts: WorkspaceSweepOptions): string[] {
  const known = new Set(opts.actors.map((actor) => actor.id.slice(0, 8)));
  const found: string[] = [];
  for (const name of subdirectories(opts.scratchDir)) {
    const prefix = workspaceActorPrefix(name);
    // A name that resolves to an actor is already this module's business: live
    // ones are kept and retired ones are swept, and neither is a stray.
    if (prefix && known.has(prefix)) continue;
    // `.git` is a directory in a clone and a file in a worktree; either says
    // this directory holds a repository rather than a cache or a scratch file.
    if (existsSync(join(opts.scratchDir, name, ".git"))) found.push(join(opts.scratchDir, name));
  }
  return found;
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
