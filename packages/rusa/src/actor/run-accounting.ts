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
}

export function createRunAccounting(runs: () => ActorRunRepository): RunAccounting {
  const activeRunIds = new Map<string, string>();
  const complete = (actorId: string, result: RunResult): string => {
    const runId = activeRunIds.get(actorId);
    if (!runId) throw new Error(`actor has no active durable run: ${actorId}`);
    // The write is synchronous, so nothing can interleave between it and the
    // claim it closes: a second terminal event either precedes this one and
    // finds a claim, or follows it and finds none. Writing first is what makes
    // a failed write recoverable — the claim still names the open row, so the
    // close can be retried and no new run can start over the top of it.
    runs().complete(runId, {
      success: result.success,
      exitCode: result.exitCode,
      output: result.output,
      yieldStatus: result.yieldStatus,
      yieldNote: result.yieldNote,
      model: result.model,
    });
    activeRunIds.delete(actorId);
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
    abandon: (actorId, reason) => {
      const runId = activeRunIds.get(actorId);
      if (!runId) return null;
      runs().abandon(runId, reason);
      activeRunIds.delete(actorId);
      return runId;
    },
    activeRunId: (actorId) => activeRunIds.get(actorId),
  };
}
