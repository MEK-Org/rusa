import type { ActorOptions } from "../actor/actor.js";
import type { RunResult } from "../providers/types.js";
import {
  type ActorRuntimeDriver,
  type ActorTerminalLifecycle,
  createActorRuntime,
} from "./actor-runtime.js";
import type { InboxItemRepository } from "./inbox-item-repository.js";

export type ActorExecutionState = "idle" | "queued" | "running" | "winding_down";

/**
 * Invocation inputs needed to construct and run an actor.
 *
 * Notice: This contains NO actor hierarchy (no parentId, no child records,
 * no subtree authority). RunManager cares only about execution inputs.
 */
export interface ActorInvocationInputs<TActor = unknown> {
  actorId: string;
  capabilities: ReadonlySet<string>;
  workspace: {
    path: string;
    sandboxed: boolean;
  };
  driver: ActorRuntimeDriver<TActor>;
  options: Omit<ActorOptions, "id" | "cwd" | "sandbox" | "onRunEnd">;
  terminal: ActorTerminalLifecycle;
  runActor: (actor: TActor, signal?: AbortSignal) => Promise<RunResult>;
}

export interface RunManagerOptions<TActor = unknown> {
  inboxRepository: InboxItemRepository;
  resolveInvocationInputs: (actorId: string) => Promise<ActorInvocationInputs<TActor>>;
  /** Maximum concurrent runs allowed (parallelism admission). */
  maxParallelism?: number;
  /**
   * Optional quota admission check.
   * Return false if provider quota is exhausted or throttled.
   */
  checkQuota?: (actorId: string) => boolean | Promise<boolean>;
  log?: (message: string) => void;
}

interface PerActorState {
  state: ActorExecutionState;
  dirty: boolean;
  responsiveQueued: boolean;
  admissionPending: boolean;
  abortController?: AbortController;
}

/**
 * RunManager owns the per-actor execution state machine:
 * - single flight per actor
 * - debounce / coalescing
 * - priority and dispatch behavior derived directly from durable inbox items
 * - quota and parallelism admission (v1 internal implementation)
 * - actor construction from explicit invocation inputs (no actor hierarchy)
 * - interruption of active runs
 * - terminal lifecycle execution and follow-up dispatch
 *
 * NOTE on future fine-grained dispatch flags:
 * Matt sketched possible future fine-grained dispatch flags on inbox items,
 * such as `{ interrupt: boolean; skipQueue: boolean; skipWake: boolean }` (e.g. for FYI-tier items).
 * In this POC, current dispatch semantics are preserved exactly: priority is
 * derived directly from the durable inbox item payload (`payload.priority === "responsive"` vs normal).
 * Fine-grained flags are explicitly deferred future possibilities, not POC behavior or schema.
 *
 * NOTE on future composable admission policy:
 * In this v1 implementation, parallelism limiting and quota throttling are
 * contained directly within RunManager. A later phase can evaluate policy
 * composition once its real admission contracts are known; this prototype
 * deliberately introduces no policy interface.
 */
export class RunManager<TActor = unknown> {
  private readonly inboxRepository: InboxItemRepository;
  private readonly resolveInvocationInputs: (
    actorId: string
  ) => Promise<ActorInvocationInputs<TActor>>;
  private readonly maxParallelism: number;
  private readonly checkQuota?: (actorId: string) => boolean | Promise<boolean>;
  private readonly log: (message: string) => void;

  private readonly actorStates = new Map<string, PerActorState>();
  private activeRunsCount = 0;
  private isShutdown = false;

  constructor(options: RunManagerOptions<TActor>) {
    this.inboxRepository = options.inboxRepository;
    this.resolveInvocationInputs = options.resolveInvocationInputs;
    this.maxParallelism = options.maxParallelism ?? 10;
    this.checkQuota = options.checkQuota;
    this.log = options.log ?? (() => {});
  }

  stateOf(actorId: string): ActorExecutionState {
    return this.actorStates.get(actorId)?.state ?? "idle";
  }

  /**
   * The single dispatch entry point: a content-free poke.
   *
   * The caller specifies only which actor was nudged. RunManager inspects
   * the durable inbox item repository to determine whether work exists and what
   * its priority is (responsive vs normal).
   */
  async dispatchRun(actorId: string): Promise<void> {
    if (this.isShutdown) return;

    // 1. Inspect durable inbox to derive priority
    const unhandled = await this.inboxRepository.getUnhandledItems(actorId);
    if (unhandled.length === 0) {
      return;
    }

    const isResponsive = unhandled.some((item) => item.payload?.priority === "responsive");

    let actorState = this.actorStates.get(actorId);
    if (!actorState) {
      actorState = {
        state: "idle",
        dirty: false,
        responsiveQueued: false,
        admissionPending: false,
      };
      this.actorStates.set(actorId, actorState);
    }

    if (actorState.state === "running") {
      // Coalesce: mark dirty so another run is dispatched upon completion
      actorState.dirty = true;
      if (isResponsive) {
        this.log(`[RunManager] Interrupting running actor ${actorId} due to responsive item`);
        actorState.abortController?.abort();
      }
      return;
    }

    if (actorState.state === "queued") {
      // Coalescing: already queued. Promote if newly responsive.
      if (isResponsive) {
        actorState.responsiveQueued = true;
      }
      // A queued opportunity may have been held at the v1 admission gate. A
      // new content-free poke re-checks that durable state, but never starts a
      // second admission attempt for the same actor.
      return this.attemptAdmission(actorId);
    }

    // Transition to queued
    actorState.state = "queued";
    actorState.responsiveQueued = isResponsive;

    // Attempt admission and execution. Callers may await this in focused
    // tests; process-local inbox notifications intentionally discard it.
    return this.attemptAdmission(actorId);
  }

  async interrupt(actorId: string): Promise<boolean> {
    const actorState = this.actorStates.get(actorId);
    if (actorState && actorState.state === "running" && actorState.abortController) {
      actorState.abortController.abort();
      return true;
    }
    return false;
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    for (const [_actorId, state] of this.actorStates.entries()) {
      if (state.state === "running" && state.abortController) {
        state.abortController.abort();
      }
    }
  }

  private async attemptAdmission(actorId: string): Promise<void> {
    const actorState = this.actorStates.get(actorId);
    if (
      !actorState ||
      actorState.state !== "queued" ||
      actorState.admissionPending ||
      this.isShutdown
    ) {
      return;
    }

    // v1 admission: current responsive work bypasses the ordinary queue.
    // This preserves today's priority behavior; future dispatch flags are not
    // introduced by this prototype.
    if (!actorState.responsiveQueued && this.activeRunsCount >= this.maxParallelism) {
      this.log(`[RunManager] ${actorId} waiting in queue (max concurrency reached)`);
      return;
    }

    // Reserve a slot before an async quota check so concurrent pokes cannot
    // both observe the same available parallelism capacity.
    actorState.admissionPending = true;
    this.activeRunsCount++;
    let started = false;

    try {
      // v1 admission: retain the existing quota check inside RunManager.
      if (this.checkQuota) {
        const allowed = await this.checkQuota(actorId);
        if (!allowed) {
          this.log(`[RunManager] ${actorId} throttled by quota policy`);
          return;
        }
      }
      if (this.isShutdown) return;

      // Admitted: transition to running only after all v1 gates pass.
      started = true;
      actorState.state = "running";
      actorState.dirty = false;
      actorState.responsiveQueued = false;
      const abortController = new AbortController();
      actorState.abortController = abortController;

      // Mark unhandled items seen
      await this.inboxRepository.markSeen(actorId);

      // Consumes ONLY invocation inputs — NOT actor hierarchy!
      const inputs = await this.resolveInvocationInputs(actorId);

      // Construct actor through shared profile (duck rootness: no role/isRoot)
      const actor = createActorRuntime({
        actor: { id: actorId },
        capabilities: inputs.capabilities,
        workspace: inputs.workspace,
        driver: inputs.driver,
        options: inputs.options,
        // RunManager owns terminal cleanup for this invocation, so the shared
        // construction helper only receives execution inputs here.
      });

      // Execute run
      const result = await inputs.runActor(actor, abortController.signal);

      // Terminal cleanup stays with the run state machine, rather than the
      // actor hierarchy or the external EventManager.
      await this.finishTerminal(inputs.terminal, result);
    } catch (err) {
      this.log(
        `[RunManager] Run failed for ${actorId}: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.activeRunsCount--;
      actorState.admissionPending = false;
      if (!started) {
        if (this.isShutdown) actorState.state = "idle";
      } else {
        actorState.abortController = undefined;
        actorState.state = "idle";

        // If dirtied during the run, follow up once. Selecting and handling
        // inbox rows remains part of the existing actor execution path, so a
        // clean run is not redispatched merely because an actor may
        // intentionally leave an item unhandled; fresh durable deliveries or
        // boot reconciliation provide the next poke.
        const shouldFollowUp = actorState.dirty;
        actorState.dirty = false;
        if (shouldFollowUp) {
          void this.dispatchRun(actorId);
        }

        // Check any other queued actors for parallelism admission.
        for (const [otherId, otherState] of this.actorStates.entries()) {
          if (otherState.state === "queued") {
            void this.attemptAdmission(otherId);
          }
        }
      }
    }
  }

  /** Preserve the current terminal-stage order while making its owner explicit. */
  private async finishTerminal(terminal: ActorTerminalLifecycle, result: RunResult): Promise<void> {
    terminal.finishInboxRun?.();
    const runId = terminal.completeRun(result);
    terminal.logRunEnd(runId, result);
    terminal.recordRunEnd(runId, result);
    terminal.afterTerminal?.(result);
    await terminal.compact?.();
    if (!result.success && !result.capped) {
      await terminal.routeFailure?.(result);
    }
  }
}
