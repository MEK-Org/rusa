import type { ActorRecord } from "./actor-record.js";
import type { RootControlPrincipal } from "./root-control.js";

/** What a human operator's reparent was asked to do and how it ended. */
export interface OperatorReparentAudit {
  principal: string;
  actorId: string;
  /** The parent as it stood when the request was decided; null for top level or unknown. */
  fromParentId: string | null;
  toParentId: string | null;
  outcome: "ok" | "denied";
  /** Why a denied move was refused. */
  reason?: string;
}

export interface OperatorActorControlMesh {
  reparentThread(id: string, newParentId: string | null): void;
  recordEvent(event: {
    kind: "operator_actor_reparent";
    actorId: string;
    detail?: string;
    payload?: string;
  }): void;
  list(): ActorRecord[];
}

/**
 * The authenticated human operator's boundary for reorganizing the actor
 * forest (#1003). An operator may detach any active actor to top level,
 * reattach it, or move it across forests — including the formerly configured
 * actor — which no actor-facing tool allows. It reaches no further than that:
 * the mesh still refuses cycles, self-parenting, unknown and retired actors at
 * mutation time, and moving an actor changes no grant, sandbox or placement.
 *
 * Every attempt is audited against the moved actor, allowed or denied, with
 * the principal and the old and new parent, so the timeline of any actor shows
 * who rearranged it. The actor's own `actor_reparented` event still records
 * the edge change itself.
 */
export class OperatorActorControl {
  constructor(private readonly mesh: OperatorActorControlMesh) {}

  reparent(actorId: string, newParentId: string | null, principal: RootControlPrincipal): void {
    const fromParentId = this.mesh.list().find((record) => record.id === actorId)?.parentId ?? null;
    const audit = (outcome: OperatorReparentAudit["outcome"], reason?: string) =>
      this.record({
        principal,
        actorId,
        fromParentId,
        toParentId: newParentId,
        outcome,
        ...(reason !== undefined ? { reason } : {}),
      });
    // The root LLM principal is an actor acting through root control; it does
    // not get to borrow the human operator's cross-forest reach.
    if (principal === "root-llm") {
      const reason = "only an authenticated human operator may use the operator reparent boundary";
      audit("denied", reason);
      throw new Error(reason);
    }
    try {
      this.mesh.reparentThread(actorId, newParentId);
    } catch (err) {
      audit("denied", err instanceof Error ? err.message : String(err));
      throw err;
    }
    audit("ok");
  }

  private record(audit: OperatorReparentAudit): void {
    const to = audit.toParentId ?? "top level";
    this.mesh.recordEvent({
      kind: "operator_actor_reparent",
      actorId: audit.actorId,
      detail: `${audit.principal} reparent ${audit.outcome}: ${audit.fromParentId ?? "top level"} -> ${to}`,
      payload: JSON.stringify(audit),
    });
  }
}
