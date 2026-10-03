import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type { Obligation } from "./obligation.js";

/**
 * Resolve a requested obligation owner to one this mesh can actually route to.
 *
 * Shared rather than reimplemented per surface. `0025` collapsed owner into one
 * entity id specifically because a `kind` column removed the pressure to have a
 * canonical id per principal — live data held three ids for one operator. That
 * pressure only exists if every write boundary applies the same rule, so this
 * is the rule, in one place.
 *
 * Accepts a live actor or a durable user principal. Unknown ids, retired
 * actors and infrastructure ids cannot own work.
 */
export function resolveObligationOwner(
  actors: Pick<ActorRepository, "get">,
  rawOwnerId: string,
  principals?: Pick<PrincipalRepository, "get" | "listUsers">
): { ok: true; ownerId: string } | { ok: false; error: string } {
  const ownerId = rawOwnerId.trim();
  if (principals) {
    const p = principals.get(ownerId);
    if (p && p.kind === "user") return { ok: true, ownerId };
  }
  const record = actors.get(ownerId);
  if (!record)
    return {
      ok: false,
      error: `unknown obligation owner: ${ownerId}; use the verified human message fromId, ask your parent for its durable principal mapping, or name an active actor id`,
    };
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
