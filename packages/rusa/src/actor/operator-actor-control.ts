import type { ActorRecord } from "./actor-record.js";
import { OBLIGATIONS_ADMIN_CAPABILITY } from "./administrative-capabilities.js";
import type { CapabilityGrantStore } from "./capability-grants.js";
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

/** A human operator's request to change an actor's cross-owner obligation reach. */
export interface OperatorObligationsAdminAudit {
  principal: string;
  actorId: string;
  enabled: boolean;
  outcome: "ok" | "denied";
  /** Why a denied request was refused. */
  reason?: string;
}

/** An authenticated human operator's request to retire an actor. */
export interface OperatorRetireAudit {
  principal: string;
  actorId: string;
  outcome: "ok" | "denied";
  /** Why a denied retirement was refused. */
  reason?: string;
}

/** Durable readback returned after the operator action commits. */
export interface ObligationsAdminBinding {
  actorId: string;
  capability: typeof OBLIGATIONS_ADMIN_CAPABILITY;
  active: boolean;
}

export interface OperatorActorControlMesh {
  reparentThread(id: string, newParentId: string | null): void;
  retire(id: string): void;
  resolveActorId(id: string): string;
  isAncestorOf(ancestorId: string, id: string): boolean;
  recordEvent(event: {
    kind: "operator_actor_reparent" | "operator_obligations_admin" | "operator_actor_retire";
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
  constructor(
    private readonly mesh: OperatorActorControlMesh,
    private readonly grants: CapabilityGrantStore,
    private readonly rootId: string | undefined,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  reparent(actorId: string, newParentId: string | null, principal: RootControlPrincipal): void {
    const canonicalActorId = this.mesh.resolveActorId(actorId);
    const canonicalParentId = newParentId === null ? null : this.mesh.resolveActorId(newParentId);
    const fromParentId =
      this.mesh.list().find((record) => record.id === canonicalActorId)?.parentId ?? null;
    const audit = (outcome: OperatorReparentAudit["outcome"], reason?: string) =>
      this.record({
        principal,
        actorId: canonicalActorId,
        fromParentId,
        toParentId: canonicalParentId,
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
      this.mesh.reparentThread(canonicalActorId, canonicalParentId);
    } catch (err) {
      audit("denied", err instanceof Error ? err.message : String(err));
      throw err;
    }
    audit("ok");
  }

  /**
   * The authenticated operator may retire any active non-root actor, including
   * one detached from every actor-owned subtree (#1085). The configured root
   * stays protected even if it is reparented. The operator boundary checks that
   * the target is active immediately before the synchronous mesh mutation; the
   * mesh remains the lifecycle authority for all run, work, message, and
   * subscription retirement guards.
   */
  retire(actorId: string, principal: RootControlPrincipal): void {
    const canonicalActorId = this.mesh.resolveActorId(actorId);
    const audit = (outcome: OperatorRetireAudit["outcome"], reason?: string) =>
      this.recordRetirement({
        principal,
        actorId: canonicalActorId,
        outcome,
        ...(reason !== undefined ? { reason } : {}),
      });
    if (principal === "root-llm") {
      const reason = "only an authenticated human operator may use the operator retire boundary";
      audit("denied", reason);
      throw new Error(reason);
    }
    if (this.rootId !== undefined && this.mesh.isAncestorOf(canonicalActorId, this.rootId)) {
      const reason =
        "operator retirement may not target the configured root actor or a subtree containing it";
      audit("denied", reason);
      throw new Error(reason);
    }
    const target = this.mesh.list().find((record) => record.id === canonicalActorId);
    if (!target) {
      const reason = `unknown actor: ${canonicalActorId}`;
      audit("denied", reason);
      throw new Error(reason);
    }
    if (target.status !== "active") {
      const reason = `cannot retire actor ${canonicalActorId}: actor is not active`;
      audit("denied", reason);
      throw new Error(reason);
    }
    try {
      this.mesh.retire(canonicalActorId);
    } catch (err) {
      audit("denied", err instanceof Error ? err.message : String(err));
      throw err;
    }
    audit("ok");
  }

  /**
   * The only production mutation path for `obligations-admin` (#1003). It is
   * intentionally not an ActorMesh capability grant: even a capability-admin
   * actor must not obtain cross-owner obligation reach by delegation. The
   * response is a store readback, so an operator can observe the durable
   * binding before relying on it.
   */
  setObligationsAdmin(
    actorId: string,
    enabled: boolean,
    principal: RootControlPrincipal
  ): ObligationsAdminBinding {
    const canonicalActorId = this.mesh.resolveActorId(actorId);
    const audit = (outcome: OperatorObligationsAdminAudit["outcome"], reason?: string) =>
      this.recordObligationsAdmin({
        principal,
        actorId: canonicalActorId,
        enabled,
        outcome,
        ...(reason !== undefined ? { reason } : {}),
      });
    if (principal === "root-llm") {
      const reason = "only an authenticated human operator may provision obligations-admin";
      audit("denied", reason);
      throw new Error(reason);
    }
    if (!this.mesh.list().some((record) => record.id === canonicalActorId)) {
      const reason = `unknown actor: ${canonicalActorId}`;
      audit("denied", reason);
      throw new Error(reason);
    }

    if (enabled) {
      this.grants.grant({
        actorId: canonicalActorId,
        capability: OBLIGATIONS_ADMIN_CAPABILITY,
        grantedBy: `operator:${principal}`,
        grantedAt: this.now(),
      });
    } else {
      this.grants.revoke(canonicalActorId, OBLIGATIONS_ADMIN_CAPABILITY, this.now());
    }
    const active = this.grants.activeFor(canonicalActorId).includes(OBLIGATIONS_ADMIN_CAPABILITY);
    if (active !== enabled) {
      const reason = `durable ${OBLIGATIONS_ADMIN_CAPABILITY} readback did not match requested state`;
      audit("denied", reason);
      throw new Error(reason);
    }
    audit("ok");
    return { actorId: canonicalActorId, capability: OBLIGATIONS_ADMIN_CAPABILITY, active };
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

  private recordObligationsAdmin(audit: OperatorObligationsAdminAudit): void {
    this.mesh.recordEvent({
      kind: "operator_obligations_admin",
      actorId: audit.actorId,
      detail: `${audit.principal} ${audit.enabled ? "enabled" : "revoked"} obligations-admin: ${audit.outcome}`,
      payload: JSON.stringify(audit),
    });
  }

  private recordRetirement(audit: OperatorRetireAudit): void {
    this.mesh.recordEvent({
      kind: "operator_actor_retire",
      actorId: audit.actorId,
      detail: `${audit.principal} retire ${audit.outcome}`,
      payload: JSON.stringify(audit),
    });
  }
}
