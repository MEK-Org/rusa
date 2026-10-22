import {
  type ActorRunModelConfig,
  createActorRunModelConfig,
} from "../db/repositories/actor-run-model-config.js";
import type { ActorRunRepository } from "../db/repositories/actor-run-repository.js";
import type { InstanceRunReceiptRepository } from "../db/repositories/run-receipt-repository.js";
import { type Logger, nullLogger } from "../observability/logger.js";
import type { RawProviderModelConfig } from "../providers/model-config.js";
import type { RunResult } from "../providers/types.js";
import { outputOmittedChars } from "../remote-instances/run-material.js";

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
  /**
   * Open this actor's externally-minted durable run. Throws if one is already
   * open. `durableHost` names the execution instance that owes the run a
   * durable terminal receipt (#1020); that receipt, not this ledger, then
   * writes the run's terminal.
   */
  begin(
    actorId: string,
    runId: string,
    modelConfig: ActorRunModelConfig,
    durableHost?: string
  ): void;
  /**
   * Close this actor's named open run. A receipt-backed run's claim is
   * released instead, leaving its receipt to close it; a successful return
   * still spends its selected-work recovery budget (#1119). Throws if it is
   * not the active run.
   */
  complete(actorId: string, runId: string, result: RunResult): void;
  /** Close this actor's named open run as abandoned, or report there was none. */
  abandon(actorId: string, runId: string, reason: string): string | null;
  /** The run this actor currently has open, if any. */
  activeRunId(actorId: string): string | undefined;
}

export function createRunAccounting(
  runs: () => ActorRunRepository,
  receipts?: () => InstanceRunReceiptRepository,
  log: Logger = nullLogger
): RunAccounting {
  const activeRunIds = new Map<string, string>();
  /** Open runs whose terminal arrives as a host receipt, not through this ledger. */
  const receiptBacked = new Set<string>();
  const assertActive = (actorId: string, runId: string): void => {
    const activeRunId = activeRunIds.get(actorId);
    if (!activeRunId) throw new Error(`actor has no active durable run: ${actorId}`);
    if (activeRunId !== runId) {
      throw new Error(`actor ${actorId} has active durable run ${activeRunId}, not ${runId}`);
    }
  };
  const complete = (actorId: string, runId: string, result: RunResult): void => {
    assertActive(actorId, runId);
    if (receiptBacked.has(runId)) {
      // The receipt closes the run. A successful return still spends the
      // selected-work recovery budget now, so a withheld receipt cannot
      // grant another recovery (#1119).
      if (result.success) receipts?.().recordReturn(runId);
      receiptBacked.delete(runId);
      activeRunIds.delete(actorId);
      return;
    }
    // The write is synchronous, so nothing can interleave between it and the
    // claim it closes: a second terminal event either precedes this one and
    // finds a claim, or follows it and finds none. Writing first is what makes
    // a failed write recoverable — the claim still names the open row, so the
    // close can be retried and no new run can start over the top of it.
    runs().complete(runId, {
      success: result.success,
      exitCode: result.exitCode,
      output: result.output,
      outputOmittedChars: outputOmittedChars(result),
    });
    activeRunIds.delete(actorId);
  };
  return {
    begin: (actorId, runId, modelConfig, durableHost) => {
      if (activeRunIds.has(actorId)) {
        throw new Error(`actor already has an active durable run: ${actorId}`);
      }
      if (durableHost !== undefined) {
        if (!receipts) throw new Error("run receipts are not configured on this leader");
        const early = receipts().startRun({ runId, instanceId: durableHost, actorId, modelConfig });
        // Its arrival was logged as an `unknown_run` conflict; this is where it applied.
        if (early?.status === "applied") {
          log.info("instance_receipt_applied", {
            followerId: durableHost,
            runId,
            actorId,
            early: true,
            actorRunClosed: early.actorRunClosed,
          });
        }
        receiptBacked.add(runId);
      } else {
        runs().start({ id: runId, actorId, modelConfig });
      }
      activeRunIds.set(actorId, runId);
    },
    complete,
    abandon: (actorId, runId, reason) => {
      const activeRunId = activeRunIds.get(actorId);
      if (!activeRunId) return null;
      if (activeRunId !== runId) {
        throw new Error(`actor ${actorId} has active durable run ${activeRunId}, not ${runId}`);
      }
      if (!receiptBacked.delete(runId)) runs().abandon(runId, reason);
      activeRunIds.delete(actorId);
      return runId;
    },
    activeRunId: (actorId) => activeRunIds.get(actorId),
  };
}
