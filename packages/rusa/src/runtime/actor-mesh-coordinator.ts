import type { InboxItemRepository } from "./inbox-item-repository.js";
import type { RunManager } from "./run-manager.js";

export interface ActorRecordStub {
  id: string;
  parentId: string | null;
  status: "active" | "retired";
}

export interface ActorMeshCoordinatorOptions {
  inboxRepository: InboxItemRepository;
  runManager: RunManager;
  actors?: Map<string, ActorRecordStub>;
  log?: (message: string) => void;
}

/**
 * ActorMeshCoordinator demonstrates ActorMesh as a sibling process component
 * to EventManager in the converged architecture:
 *
 * Responsibilities:
 * - Owns actor relationships, records, parent/child hierarchy, and capabilities.
 * - In start():
 *   1. Subscribes to advisory after-commit notifications from InboxItemRepository.
 *   2. Reconciles all pending work via InboxItemRepository.listActorsWithUnhandledItems().
 * - Dispatches content-free pokes to RunManager: `dispatchRun(actorId)`.
 *
 * Boundaries:
 * - Does NOT own external event normalization or ingress routing (owned by EventManager).
 * - Does NOT own execution single-flight / coalescing / quota / execution state (owned by RunManager).
 */
export class ActorMeshCoordinator {
  private readonly inboxRepository: InboxItemRepository;
  private readonly runManager: RunManager;
  private readonly actors: Map<string, ActorRecordStub>;
  private readonly log: (message: string) => void;
  private unsubscribeInbox?: () => void;
  private isStarted = false;

  constructor(options: ActorMeshCoordinatorOptions) {
    this.inboxRepository = options.inboxRepository;
    this.runManager = options.runManager;
    this.actors = options.actors ?? new Map();
    this.log = options.log ?? (() => {});
  }

  getActorRecord(actorId: string): ActorRecordStub | undefined {
    return this.actors.get(actorId);
  }

  registerActor(record: ActorRecordStub): void {
    this.actors.set(record.id, record);
  }

  async start(): Promise<void> {
    if (this.isStarted) return;
    this.isStarted = true;

    // 1. Subscribe to advisory after-commit notifications
    this.unsubscribeInbox = this.inboxRepository.onItemsCommitted((items) => {
      const seenActors = new Set<string>();
      for (const item of items) {
        if (!seenActors.has(item.actorId)) {
          seenActors.add(item.actorId);
          // Content-free poke to RunManager
          void this.runManager.dispatchRun(item.actorId);
        }
      }
    });

    // 2. Perform authoritative boot reconciliation
    const actorsWithWork = await this.inboxRepository.listActorsWithUnhandledItems();
    this.log(
      `[ActorMeshCoordinator] Boot reconciliation found ${actorsWithWork.length} actors with unhandled work`
    );
    for (const actorId of actorsWithWork) {
      void this.runManager.dispatchRun(actorId);
    }
  }

  async shutdown(): Promise<void> {
    this.isStarted = false;
    this.unsubscribeInbox?.();
    this.unsubscribeInbox = undefined;
  }
}
