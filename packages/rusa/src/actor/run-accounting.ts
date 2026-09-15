import {
  type ActorRunModelConfig,
  createActorRunModelConfig,
} from "../db/repositories/actor-run-model-config.js";
import type { ActorRunRepository } from "../db/repositories/actor-run-repository.js";
import type { RawProviderModelConfig } from "../providers/model-config.js";
import type { RunResult } from "../providers/types.js";

/**
 * Project the exact validated tuple selected for a launch into the durable run
 * document. Production and the provider-matrix test share this boundary.
 */
export function projectActorRunLaunchConfig(selected: RawProviderModelConfig): ActorRunModelConfig {
  return createActorRunModelConfig({
    provider: selected.provider,
    model: selected.model ?? "",
    ...(selected.effort === undefined ? {} : { effort: selected.effort }),
  });
}

/**
 * The leader's durable run ledger, addressed by actor.
 *
 * An actor has at most one open run, and terminal accounting is addressed to
 * *that* run: {@link RunAccounting.complete} closes the run this actor actually
 * started, so a caller cannot invent a run that never began, nor close the same
 * one twice. The execution coordinator mints the id before start, then every
 * observer receives that same id through the lifecycle event. The distinction matters most for a remote actor, whose failures
 * arrive out of band — a follower can drop while its actor sits idle, or while a
 * completion is already in flight, and neither is a run outcome.
 */
export interface RunAccounting {
  /** Open this actor's externally-minted durable run. Throws if one is already open. */
  begin(actorId: string, runId: string, modelConfig: ActorRunModelConfig): void;
  /** Close this actor's named open run. Throws if it is not the active run. */
  complete(actorId: string, runId: string, result: RunResult): void;
  /** Close this actor's named open run as abandoned. */
  abandon(actorId: string, runId: string, reason: string): void;
  /** The run this actor currently has open, if any. */
  activeRunId(actorId: string): string | undefined;
}

export function createRunAccounting(runs: () => ActorRunRepository): RunAccounting {
  const activeRunIds = new Map<string, string>();
  const assertActive = (actorId: string, runId: string): void => {
    const activeRunId = activeRunIds.get(actorId);
    if (!activeRunId) throw new Error(`actor has no active durable run: ${actorId}`);
    if (activeRunId !== runId) {
      throw new Error(`actor ${actorId} has active durable run ${activeRunId}, not ${runId}`);
    }
  };
  const complete = (actorId: string, runId: string, result: RunResult): void => {
    assertActive(actorId, runId);
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
    });
    activeRunIds.delete(actorId);
  };
  return {
    begin: (actorId, runId, modelConfig) => {
      if (activeRunIds.has(actorId)) {
        throw new Error(`actor already has an active durable run: ${actorId}`);
      }
      runs().start({ id: runId, actorId, modelConfig });
      activeRunIds.set(actorId, runId);
    },
    complete,
    abandon: (actorId, runId, reason) => {
      assertActive(actorId, runId);
      runs().abandon(runId, reason);
      activeRunIds.delete(actorId);
    },
    activeRunId: (actorId) => activeRunIds.get(actorId),
  };
}
