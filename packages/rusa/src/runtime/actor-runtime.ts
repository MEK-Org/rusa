import type { ActorOptions } from "../actor/actor.js";
import type { RunResult } from "../providers/types.js";

/** The construction target supplied by command composition. */
export interface ActorRuntimeDriver<TActor> {
  kind: "local" | "external";
  instantiate: (options: ActorOptions) => TActor;
}

/**
 * The explicitly selected inputs of an actor runtime. An actor is identified
 * by its id and relationship, not a root/worker role. The command composition
 * root supplies the configured-root routing and chooses the driver; this
 * profile only receives the resulting inputs.
 */
export interface ActorRuntimeProfile<TActor> {
  actor: {
    id: string;
    parentId?: string | null;
  };
  /** Effective capabilities selected by composition; policy remains above this seam. */
  capabilities: ReadonlySet<string>;
  workspace: {
    path: string;
    sandboxed: boolean;
  };
  driver: ActorRuntimeDriver<TActor>;
  options: Omit<ActorOptions, "id" | "cwd" | "sandbox" | "onRunEnd">;
  /**
   * Direct construction sites may bind the current terminal pipeline here.
   * RunManager deliberately omits it and owns terminal cleanup around the
   * invocation instead.
   */
  terminal?: ActorTerminalLifecycle;
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
export function composeActorRuntime<TActor>(profile: ActorRuntimeProfile<TActor>): ActorOptions {
  const { actor, workspace, options, terminal } = profile;

  const actorOptions: ActorOptions = {
    ...options,
    id: actor.id,
    cwd: workspace.path,
    sandbox: workspace.sandboxed,
  };

  if (!terminal) {
    return actorOptions;
  }

  return {
    ...actorOptions,
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
export function createActorRuntime<TActor>(profile: ActorRuntimeProfile<TActor>): TActor {
  return profile.driver.instantiate(composeActorRuntime(profile));
}
