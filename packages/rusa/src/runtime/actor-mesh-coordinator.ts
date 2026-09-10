import type { InboxRepository } from "../repositories/inbox-repository.js";
import { type ActorLifecycleListener, emitLifecycle } from "./actor-lifecycle.js";
import type { RunManager } from "./run-manager.js";

export interface ActorRecordStub {
  id: string;
  parentId: string | null;
  status: "active" | "retired";
}

export interface ActorMeshCoordinatorOptions {
  inboxRepository: InboxRepository;
  runManager: RunManager;
  actors?: Map<string, ActorRecordStub>;
  lifecycle?: readonly ActorLifecycleListener[];
  log?: (message: string) => void;
}

/**
 * ActorMeshCoordinator demonstrates ActorMesh as a sibling process component
 * to EventManager in the converged architecture:
 *
 * Responsibilities:
 * - Owns actor relationships, records, parent/child hierarchy, and capabilities.
 * - Emits the mesh half of the actor lifecycle: onSpawn and onRetire. The run
 *   half (onQueued/onStart/onError/onEnd) belongs to RunManager.
 * - In start():
 *   1. Subscribes to advisory after-commit notifications from InboxRepository.
 *   2. Reconciles all pending work via InboxRepository.actorsWithUnhandled().
 * - Dispatches content-free pokes to RunManager: `dispatch(actorId)`.
 *
 * Boundaries:
 * - Does NOT own external event normalization or ingress routing (owned by EventManager).
 * - Does NOT own execution single-flight / coalescing / quota / execution state (owned by RunManager).
 */
export class ActorMeshCoordinator {
  private readonly inboxRepository: InboxRepository;
  private readonly runManager: RunManager;
  private readonly actors: Map<string, ActorRecordStub>;
  private readonly lifecycle: readonly ActorLifecycleListener[];
  private readonly log: (message: string) => void;
  private unsubscribeInbox?: () => void;
  private isStarted = false;

  constructor(options: ActorMeshCoordinatorOptions) {
    this.inboxRepository = options.inboxRepository;
    this.runManager = options.runManager;
    this.actors = options.actors ?? new Map();
    this.lifecycle = options.lifecycle ?? [];
    this.log = options.log ?? (() => {});
  }

  getActorRecord(actorId: string): ActorRecordStub | undefined {
    return this.actors.get(actorId);
  }

  async registerActor(record: ActorRecordStub): Promise<void> {
    const isNew = !this.actors.has(record.id);
    this.actors.set(record.id, record);
    if (isNew) await this.emit("onSpawn", { actorId: record.id });
  }

  async retireActor(actorId: string): Promise<void> {
    const record = this.actors.get(actorId);
    if (!record || record.status === "retired") return;
    this.actors.set(actorId, { ...record, status: "retired" });
    await this.emit("onRetire", { actorId });
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;

    // 1. Subscribe to advisory after-commit notifications
    this.unsubscribeInbox = this.inboxRepository.onItemsAppended((items) => {
      const seenActors = new Set<string>();
      for (const item of items) {
        if (!seenActors.has(item.actorId)) {
          seenActors.add(item.actorId);
          // Content-free poke to RunManager
          void this.runManager.dispatch(item.actorId);
        }
      }
    });

    // 2. Perform authoritative boot reconciliation against durable state
    const actorsWithWork = this.inboxRepository.actorsWithUnhandled();
    this.log(
      `[ActorMeshCoordinator] Boot reconciliation found ${actorsWithWork.length} actors with unhandled work`
    );
    for (const work of actorsWithWork) {
      void this.runManager.dispatch(work.actorId);
    }
  }

  async shutdown(): Promise<void> {
    this.isStarted = false;
    this.unsubscribeInbox?.();
    this.unsubscribeInbox = undefined;
  }

  private async emit<K extends keyof ActorLifecycleListener>(
    event: K,
    payload: Parameters<NonNullable<ActorLifecycleListener[K]>>[0]
  ): Promise<void> {
    await emitLifecycle(this.lifecycle, event, payload, (error) => {
      this.log(
        `[ActorMeshCoordinator] ${String(event)} listener failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }
}

export { ActorMeshCoordinator as ActorMesh };
