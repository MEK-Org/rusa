import type { IncomingMessage } from "node:http";
import type { ActorRecord } from "../actor/actor-record.js";
import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import { getDashboardRequestIdentity } from "./auth.js";

export class TenantAccessDenied extends Error {
  constructor() {
    super("Access denied");
  }
}

/** Multi-user groundwork ONLY: not yet invoked by the live route dispatcher.
 * Never infer tenancy from email, a body parameter, human:operator, or literal root.
 * Call immediately before reads/writes; asynchronous operations must recheck after awaits.
 * Action-specific permissions and transaction-level race protection remain the caller's job. */
export class TenantAuthorization {
  constructor(
    private readonly principals: Pick<PrincipalRepository, "getUser">,
    private readonly actors: Pick<ActorRepository, "get" | "list">
  ) {}

  private scope(req: IncomingMessage): { userId: string; rootId: string } {
    const identity = getDashboardRequestIdentity(req);
    if (!identity) throw new TenantAccessDenied();
    // Re-read durable state: a cached request snapshot never overrides disablement or binding.
    const user = this.principals.getUser(identity.principal.id);
    if (
      !user ||
      user.disabledAt ||
      !user.rootActorId ||
      !user.identity ||
      user.identity.issuer !== identity.principal.identity?.issuer ||
      user.identity.subject !== identity.principal.identity?.subject
    )
      throw new TenantAccessDenied();
    const root = this.actors.get(user.rootActorId);
    if (!root || root.parentId !== null) throw new TenantAccessDenied();
    return { userId: user.id, rootId: root.id };
  }

  private ownedActor(rootId: string, actorId: string): ActorRecord | undefined {
    const target = this.actors.get(actorId);
    let actor = target;
    const visited = new Set<string>();
    while (actor) {
      if (visited.has(actor.id)) return undefined;
      visited.add(actor.id);
      if (actor.id === rootId) return target;
      if (actor.parentId === null) return undefined;
      actor = this.actors.get(actor.parentId);
    }
    return undefined;
  }

  requireActor(req: IncomingMessage, actorId: string): ActorRecord {
    const scope = this.scope(req);
    const actor = this.ownedActor(scope.rootId, actorId);
    // Unknown and foreign IDs are intentionally indistinguishable.
    if (!actor) throw new TenantAccessDenied();
    return actor;
  }

  requireActors(req: IncomingMessage, actorIds: readonly string[]): ActorRecord[] {
    const scope = this.scope(req);
    return actorIds.map((id) => {
      const actor = this.ownedActor(scope.rootId, id);
      if (!actor) throw new TenantAccessDenied();
      return actor;
    });
  }

  /** Enumerate a bounded actor set for unfiltered tenant reads/streams.
   * Do not interpret an empty result as "all actors" at a downstream API. */
  visibleActorIds(req: IncomingMessage): string[] {
    const scope = this.scope(req);
    return this.actors
      .list()
      .filter((actor) => this.ownedActor(scope.rootId, actor.id))
      .map((actor) => actor.id);
  }

  /** Base owner check for obligations; parent, dependencies, and payload references
   * still need their own checks before an entire object can be returned or mutated. */
  requireOwner(req: IncomingMessage, ownerId: string): void {
    const scope = this.scope(req);
    if (ownerId === scope.userId) return;
    if (!this.ownedActor(scope.rootId, ownerId)) throw new TenantAccessDenied();
  }

  /** Check both ends; a valid source cannot authorize a cross-tenant destination. */
  requireReparent(req: IncomingMessage, actorId: string, newParentId: string): void {
    const scope = this.scope(req);
    if (
      actorId === scope.rootId ||
      actorId === newParentId ||
      !this.ownedActor(scope.rootId, actorId) ||
      !this.ownedActor(scope.rootId, newParentId) ||
      this.ownedActor(actorId, newParentId)
    )
      throw new TenantAccessDenied();
  }
}
