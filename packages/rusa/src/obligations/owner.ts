import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import type { ActorRepository } from "../repositories/actor-repository.js";

/**
 * Resolve a requested obligation owner to one this mesh can actually route to.
 *
 * Shared rather than reimplemented per surface. `0025` collapsed owner into one
 * entity id specifically because a `kind` column removed the pressure to have a
 * canonical id per principal — live data held three ids for one operator. That
 * pressure only exists if every write boundary applies the same rule, so this
 * is the rule, in one place.
 *
 * Accepts a live actor or the single canonical operator id. Everything else is
 * refused: a retired actor, an id that names nothing, and any `system:*` id,
 * since nothing mints a system owner today and admitting one would create work
 * that appears in no queue and wakes nobody.
 */
export function resolveObligationOwner(
  actors: Pick<ActorRepository, "get">,
  rawOwnerId: string
): { ok: true; ownerId: string } | { ok: false; error: string } {
  const ownerId = rawOwnerId.trim();
  if (ownerId === HUMAN_OPERATOR) return { ok: true, ownerId };
  const record = actors.get(ownerId);
  if (!record) return { ok: false, error: `unknown obligation owner: ${ownerId}` };
  if (record.status !== "active") {
    return { ok: false, error: `obligation owner is not active: ${ownerId}` };
  }
  return { ok: true, ownerId };
}
