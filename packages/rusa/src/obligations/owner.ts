import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type { Obligation } from "./obligation.js";

/**
 * Resolve a requested obligation owner to one this mesh can actually route to.
 *
 * Shared by every owner write boundary; identities are explicit and opaque.
 *
 * Accepts a live actor or a durable user principal. Everything else is refused: a
 * retired actor, an id that names nothing, and system principals, since nothing
 * mints a system owner today and admitting one would create work that appears
 * in no queue and wakes nobody.
 */
export function resolveObligationOwner(
  actors: Pick<ActorRepository, "get">,
  rawOwnerId: string,
  principals?: Pick<PrincipalRepository, "get">
): { ok: true; ownerId: string } | { ok: false; error: string } {
  const ownerId = rawOwnerId.trim();
  if (principals) {
    const p = principals.get(ownerId);
    if (p && p.kind === "user") return { ok: true, ownerId };
  }
  const record = actors.get(ownerId);
  if (!record) return { ok: false, error: `unknown obligation owner: ${ownerId}` };
  if (record.status !== "active") {
    return { ok: false, error: `obligation owner is not active: ${ownerId}` };
  }
  return { ok: true, ownerId };
}

/**
 * The owner-or-ancestor write policy used by the obligation MCP surface.
 *
 * Keep the topology query injected: obligations do not own actor traversal,
 * while wiring and tests can use ActorMesh's real ancestry relation directly.
 */
export function canManageObligation(
  actorId: string,
  obligation: Pick<Obligation, "ownerId">,
  isAncestorOf: (ancestorId: string, actorId: string) => boolean
): boolean {
  return isAncestorOf(actorId, obligation.ownerId);
}
