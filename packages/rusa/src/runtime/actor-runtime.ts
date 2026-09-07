import type { ActorOptions } from "../actor/actor.js";
import type { RunResult } from "../providers/types.js";

/**
 * The explicitly selected behavior of an actor runtime. Role describes the
 * actor to reviewers; it does not grant authority or select hidden defaults.
 * Callers provide workspace, driver, MCP, scheduling, and lifecycle inputs.
 */
export interface ActorRuntimeProfile {
  identity: {
    actorId: string;
    role: "root" | "worker";
  };
  options: Omit<ActorOptions, "onRunEnd">;
  terminal: ActorTerminalLifecycle;
}

/**
 * Terminal-stage dependencies kept at the composition boundary. The ordering
 * intentionally preserves the current runtime while giving root and worker
 * construction one lifecycle seam for a later behavior change.
 */
export interface ActorTerminalLifecycle {
  /** Root accounting currently closes before durable completion; workers omit it. */
  finishInboxRun?: () => void;
  completeRun: (result: RunResult) => string;
  logRunEnd: (runId: string, result: RunResult) => void;
  recordRunEnd: (runId: string, result: RunResult) => void;
  /** Mesh worker bookkeeping currently runs immediately after the terminal event. */
  afterTerminal?: (result: RunResult) => void;
  /** Includes compaction plus its existing observation event. */
  compact?: () => Promise<void>;
  /** Called only for non-capped failures, after compaction as today. */
  routeFailure?: (result: RunResult) => Promise<void>;
}

/**
 * Gives each actor construction site the same explicit terminal pipeline.
 *
 * This deliberately does not move scheduler admission, provider selection,
 * logging policy, persistence implementations, or MCP mounting out of the
 * command composition root. Those concerns remain injected above this seam.
 */
export function composeActorRuntime(profile: ActorRuntimeProfile): ActorOptions {
  const { options, terminal } = profile;

  return {
    ...options,
    onRunEnd: async (result) => {
      terminal.finishInboxRun?.();
      const runId = terminal.completeRun(result);
      terminal.logRunEnd(runId, result);
      terminal.recordRunEnd(runId, result);
      terminal.afterTerminal?.(result);
      await terminal.compact?.();
      if (!result.success && !result.capped) await terminal.routeFailure?.(result);
    },
  };
}

/**
 * Construct an actor through the shared profile while allowing the command to
 * retain its existing local-vs-E2E driver decision.
 */
export function createActorRuntime<TActor>(
  profile: ActorRuntimeProfile,
  instantiate: (options: ActorOptions) => TActor
): TActor {
  return instantiate(composeActorRuntime(profile));
}
