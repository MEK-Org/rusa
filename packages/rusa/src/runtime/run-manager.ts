import { randomUUID } from "node:crypto";
import type { ActorOptions } from "../actor/actor.js";
import type { RunResult } from "../providers/types.js";
import type { InboxRepository } from "../repositories/inbox-repository.js";
import { type ActorLifecycleListener, emitLifecycle } from "./actor-lifecycle.js";

export type ActorExecutionState = "idle" | "queued" | "running" | "winding_down";

/** The driver instantiation target supplied by command composition. */
export interface ActorRuntimeDriver<TActor = unknown> {
  kind: "local" | "external";
  instantiate: (options: ActorOptions) => TActor;
}

/**
 * Invocation inputs needed to construct and execute an actor run.
 *
 * Notice: This contains NO actor hierarchy (no parentId, no child records,
 * no subtree authority, and no isRoot / role). RunManager cares only about
 * execution inputs. This strictly preserves duck rootness.
 *
 * It also carries no terminal-stage callbacks: what happens around a run is
 * expressed as lifecycle events (see `actor-lifecycle.ts`), so this contract
 * stays about how to build and run the actor and nothing else.
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
  runActor: (actor: TActor, signal?: AbortSignal) => Promise<RunResult>;
}

/**
 * Helper to construct an Actor from explicit invocation inputs.
 * Demonstrates shared actor construction without role/isRoot branching.
 */
export function createActorFromInputs<TActor>(inputs: ActorInvocationInputs<TActor>): TActor {
  return inputs.driver.instantiate({
    ...inputs.options,
    id: inputs.actorId,
    cwd: inputs.workspace.path,
    sandbox: inputs.workspace.sandboxed,
  });
}

export interface RunManagerOptions<TActor = unknown> {
  inboxRepository: InboxRepository;
  resolveInvocationInputs: (actorId: string) => Promise<ActorInvocationInputs<TActor>>;
  /**
   * Lifecycle observers, notified in registration order. Logging, run
   * accounting, mesh event recording, compaction, and failure routing all
   * enter here rather than as named hooks on the invocation contract.
   */
  lifecycle?: readonly ActorLifecycleListener[];
  /** Maximum concurrent runs allowed (parallelism admission). */
  maxParallelism?: number;
  /**
   * Optional quota admission check.
   * Return false if provider quota is exhausted or throttled.
   */
  checkQuota?: (actorId: string) => boolean | Promise<boolean>;
  /** Mints the run id carried on onStart/onEnd/onError. */
  newRunId?: () => string;
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
 * - run lifecycle emission and follow-up dispatch
 *
 * NOTE on future fine-grained dispatch flags:
 * Per-item dispatch flags such as `{ interrupt, skipQueue, skipWake }` (e.g. for
 * FYI-tier items) have been floated as a future direction. This POC deliberately
 * preserves current dispatch semantics exactly: priority is derived from the
 * durable inbox row (`payload.priority === "responsive"` vs normal). Those flags
 * are a deferred possibility, not POC behavior and not POC schema.
 *
 * NOTE on future composable admission policy:
 * In this v1 implementation, parallelism limiting and quota throttling are
 * contained directly within RunManager. A later phase can evaluate policy
 * composition once its real admission contracts are known; this prototype
 * deliberately introduces no policy interface.
 */
export class RunManager<TActor = unknown> {
  private readonly inboxRepository: InboxRepository;
  private readonly resolveInvocationInputs: (
    actorId: string
  ) => Promise<ActorInvocationInputs<TActor>>;
  private readonly lifecycle: readonly ActorLifecycleListener[];
  private readonly maxParallelism: number;
  private readonly checkQuota?: (actorId: string) => boolean | Promise<boolean>;
  private readonly newRunId: () => string;
  private readonly log: (message: string) => void;

  private readonly actorStates = new Map<string, PerActorState>();
  private activeRunsCount = 0;
  private isShutdown = false;

  constructor(options: RunManagerOptions<TActor>) {
    this.inboxRepository = options.inboxRepository;
    this.resolveInvocationInputs = options.resolveInvocationInputs;
    this.lifecycle = options.lifecycle ?? [];
    this.maxParallelism = options.maxParallelism ?? 10;
    this.checkQuota = options.checkQuota;
    this.newRunId = options.newRunId ?? (() => randomUUID());
    this.log = options.log ?? (() => {});
  }

  stateOf(actorId: string): ActorExecutionState {
    return this.actorStates.get(actorId)?.state ?? "idle";
  }

  /**
   * The single dispatch entry point: a content-free poke.
   *
   * The caller specifies only which actor was nudged. RunManager inspects
   * the durable inbox repository to determine whether work exists and what
   * its priority is (responsive vs normal).
   */
  async dispatch(actorId: string): Promise<void> {
    if (this.isShutdown) return;

    // 1. Inspect durable inbox to derive priority. `actorsWithUnhandled()`
    //    already promotes an actor whose pending work includes a responsive
    //    entry, so the existing store answers both questions in one read.
    const pending = this.inboxRepository
      .actorsWithUnhandled()
      .find((work) => work.actorId === actorId);
    if (!pending) {
      return;
    }

    const isResponsive = pending.priority === "responsive";

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
    await this.emit("onQueued", { actorId });

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
    const runId = this.newRunId();

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
      this.inboxRepository.markSeen(actorId);

      // Consumes ONLY invocation inputs — NOT actor hierarchy!
      const inputs = await this.resolveInvocationInputs(actorId);

      // Construct actor through shared profile (duck rootness: no role/isRoot)
      const actor = createActorFromInputs(inputs);

      await this.emit("onStart", { actorId, runId });

      // Execute run
      const result = await inputs.runActor(actor, abortController.signal);

      // The end of a run is one event with many listeners, rather than a fixed
      // sequence of named terminal hooks.
      await this.emit("onEnd", { actorId, runId, result });
    } catch (error) {
      this.log(
        `[RunManager] Run failed for ${actorId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (started) await this.emit("onError", { actorId, runId, error });
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
          void this.dispatch(actorId);
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

  private async emit<K extends keyof ActorLifecycleListener>(
    event: K,
    payload: Parameters<NonNullable<ActorLifecycleListener[K]>>[0]
  ): Promise<void> {
    await emitLifecycle(this.lifecycle, event, payload, (error) => {
      this.log(
        `[RunManager] ${String(event)} listener failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }
}
