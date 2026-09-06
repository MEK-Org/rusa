import type { ActorRunRepository } from "../db/repositories/actor-run-repository.js";
import type { RunResult } from "../providers/types.js";

/**
 * The leader's durable run ledger, addressed by actor.
 *
 * An actor has at most one open run, and terminal accounting is addressed to
 * *that* run: {@link RunAccounting.complete} closes the run this actor actually
 * started, so a caller cannot invent a run that never began, nor close the same
 * one twice. The distinction matters most for a remote actor, whose failures
 * arrive out of band — a follower can drop while its actor sits idle, or while a
 * completion is already in flight, and neither is a run outcome.
 */
export interface RunAccounting {
  /** Open this actor's durable run. Throws if one is already open. */
  begin(actorId: string, provider: string): string;
  /** Close this actor's open run. Throws if the actor has none. */
  complete(actorId: string, result: RunResult): string;
  /** Close this actor's open run as abandoned, or report there was none. */
  abandon(actorId: string, reason: string): string | null;
  /** The run this actor currently has open, if any. */
  activeRunId(actorId: string): string | undefined;
  /**
   * Close an open run only if there is one, reporting whether it landed.
   * The caller does not know whether the run it is unwinding was ever admitted.
   */
  completeIfActive(actorId: string, result: RunResult): string | null;
}

export function createRunAccounting(runs: () => ActorRunRepository): RunAccounting {
  const activeRunIds = new Map<string, string>();
  const complete = (actorId: string, result: RunResult): string => {
    const runId = activeRunIds.get(actorId);
    if (!runId) throw new Error(`actor has no active durable run: ${actorId}`);
    // Drop the claim before the write, so a second terminal event racing this
    // one finds nothing to close rather than double-counting the same run.
    activeRunIds.delete(actorId);
    runs().complete(runId, {
      success: result.success,
      exitCode: result.exitCode,
      output: result.output,
      yieldStatus: result.yieldStatus,
      yieldNote: result.yieldNote,
      model: result.model,
    });
    return runId;
  };
  return {
    begin: (actorId, provider) => {
      if (activeRunIds.has(actorId)) {
        throw new Error(`actor already has an active durable run: ${actorId}`);
      }
      const runId = runs().start({ actorId, provider });
      activeRunIds.set(actorId, runId);
      return runId;
    },
    complete,
    completeIfActive: (actorId, result) =>
      activeRunIds.has(actorId) ? complete(actorId, result) : null,
    abandon: (actorId, reason) => {
      const runId = activeRunIds.get(actorId);
      if (!runId) return null;
      activeRunIds.delete(actorId);
      runs().abandon(runId, reason);
      return runId;
    },
    activeRunId: (actorId) => activeRunIds.get(actorId),
  };
}
