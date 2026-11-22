import {
  chatWriteParam,
  holdsChatWriteSpace,
  parseChatWriteScope,
} from "../chat/chat-write-scope.js";
import {
  CAPABILITY_ADMIN_CAPABILITY,
  EXPERIMENT_ADMIN_CAPABILITY,
} from "./administrative-capabilities.js";
import type { ActiveGrantRecord, DelegationReach } from "./capability-grants.js";

// Who may grant, revoke, enroll and unenroll, as functions of durable reads,
// so the mesh and a write operation decide it the same way (#1289). Inside a
// write operation they read the transaction's state, so the decision and the
// write it authorizes cannot be split by a revocation or a reparent.

/** The durable reads the grant and experiment authority checks make. */
export interface GrantAuthorityReader {
  /** The actor's durable record, or undefined when it has none. */
  actor(id: string): { readonly parentId?: string | null; readonly status?: string } | undefined;
  /** The capabilities the actor holds now. */
  capabilities(id: string): readonly string[];
  /** Active grant records held by the actor now (durable rows + policy-derived delegable entries). */
  activeGrants(id: string): readonly ActiveGrantRecord[];
}

/** True if `ancestorId` is `id` itself or any ancestor up the actor tree. */
export function isAncestorIn(
  reader: Pick<GrantAuthorityReader, "actor">,
  ancestorId: string,
  id: string
): boolean {
  let cursor: string | null = id;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === ancestorId) return true;
    seen.add(cursor);
    cursor = reader.actor(cursor)?.parentId ?? null;
  }
  return false;
}

/**
 * True when holding `held` covers delegating `target`: exact match everywhere,
 * plus Chat space containment (`chat-write:*` or `chat-write:spaces/S` covers
 * `chat-write:spaces/S` and `chat-write:spaces/S/threads/T`).
 */
function capabilityCovers(held: string, target: string): boolean {
  if (held === target) return true;
  const targetChat = chatWriteParam(target);
  if (targetChat !== undefined) {
    const parsed = parseChatWriteScope(targetChat);
    if (parsed && parsed.kind !== "all") {
      return holdsChatWriteSpace([held], parsed.space);
    }
  }
  return false;
}

/** Highest delegation reach `grantorId` holds over `capability`, or undefined if none. */
function delegableReachFor(
  reader: GrantAuthorityReader,
  grantorId: string,
  capability: string
): DelegationReach | undefined {
  let reach: DelegationReach | undefined;
  for (const grant of reader.activeGrants(grantorId)) {
    if (!grant.delegable) continue;
    if (!capabilityCovers(grant.capability, capability)) continue;
    if (grant.delegable === "anyone") return "anyone";
    reach = "descendants";
  }
  return reach;
}

/** The active durable grant row for `(actorId, capability)`, if any. */
function activeDurableGrant(
  reader: GrantAuthorityReader,
  actorId: string,
  capability: string
): ActiveGrantRecord | undefined {
  return reader
    .activeGrants(actorId)
    .find((grant) => grant.grantedBy !== null && grant.capability === capability);
}

/**
 * Grantor authority for a grant or revocation (#1346):
 * - A `capability-admin` holder may grant or revoke any grantable capability
 *   within its own subtree (itself included), set any delegation reach, and
 *   replace any existing row in its subtree.
 * - Otherwise (non-admin, or an admin acting outside its subtree):
 *   - **grant:** the grantor must hold a delegable covering grant (exact match,
 *     or Chat space containment), the grantee must be within that grant's reach
 *     (`"descendants"` = grantor's subtree, `"anyone"` = any existing actor),
 *     any requested `delegable` flag must not exceed the grantor's own reach,
 *     and if an active durable grant row already exists on the grantee it must
 *     have been granted by `grantorId`.
 *   - **revoke:** an active durable grant row must exist on the grantee with
 *     `grantedBy === grantorId`.
 * Fail-closed: an unknown grantor holds nothing. Ids are already resolved.
 */
export function assertGrantAuthority(
  reader: GrantAuthorityReader,
  query: {
    readonly grantorId: string;
    readonly granteeId: string;
    readonly capability: string;
    readonly verb: "grant" | "revoke";
    readonly delegable?: DelegationReach;
  }
): void {
  const { grantorId, granteeId, capability, verb, delegable } = query;
  const grantee = reader.actor(granteeId);
  if (!grantee) {
    throw new Error(`unknown thread id: ${granteeId}`);
  }
  const isAdmin = reader.capabilities(grantorId).includes(CAPABILITY_ADMIN_CAPABILITY);
  if (isAdmin && isAncestorIn(reader, grantorId, granteeId)) {
    if (verb === "grant" && delegable === "anyone") {
      const grantor = reader.actor(grantorId);
      const isRoot = grantor !== undefined && (grantor.parentId ?? null) === null;
      if (!isRoot && delegableReachFor(reader, grantorId, capability) !== "anyone") {
        throw new Error(
          `${grantorId} cannot grant ${capability} with delegable="anyone": non-root ${CAPABILITY_ADMIN_CAPABILITY} holders are subtree-bound unless they already hold "anyone" reach`
        );
      }
    }
    return;
  }

  if (verb === "revoke") {
    const existing = activeDurableGrant(reader, granteeId, capability);
    if (existing && existing.grantedBy === grantorId) {
      return;
    }
    if (isAdmin) {
      throw new Error(
        `${grantorId} may only revoke capabilities in its own subtree (cannot revoke ${granteeId})`
      );
    }
    if (existing) {
      throw new Error(
        `${grantorId} cannot revoke ${capability} from ${granteeId}: it was granted by ${existing.grantedBy}`
      );
    }
    throw new Error(
      `only a ${CAPABILITY_ADMIN_CAPABILITY} holder or the grantor of an active grant may revoke ${capability} from ${granteeId}`
    );
  }

  const reach = delegableReachFor(reader, grantorId, capability);
  if (!reach) {
    if (isAdmin) {
      throw new Error(
        `${grantorId} may only grant capabilities in its own subtree (cannot grant ${granteeId})`
      );
    }
    throw new Error(
      `${grantorId} lacks ${CAPABILITY_ADMIN_CAPABILITY} and holds no delegable grant covering ${capability}`
    );
  }
  if (granteeId === grantorId) {
    throw new Error(`${grantorId} cannot delegate ${capability} to itself`);
  }
  if (reach === "descendants" && !isAncestorIn(reader, grantorId, granteeId)) {
    throw new Error(
      `${grantorId} may only delegate ${capability} within its own subtree (cannot grant ${granteeId})`
    );
  }
  if (delegable === "anyone" && reach !== "anyone") {
    throw new Error(
      `${grantorId} cannot grant ${capability} with delegable="anyone": its own reach is "${reach}"`
    );
  }
  const existing = activeDurableGrant(reader, granteeId, capability);
  if (existing && existing.grantedBy !== grantorId) {
    throw new Error(
      `${grantorId} cannot overwrite active grant of ${capability} on ${granteeId} granted by ${existing.grantedBy}`
    );
  }
}

/**
 * Authority to enroll or unenroll: an `experiment-admin` holder, over its own
 * subtree (itself included), for an actor that exists. Fail-closed. Ids are
 * already resolved. Returns the target's record.
 */
export function assertExperimentAuthority(
  reader: Pick<GrantAuthorityReader, "actor" | "capabilities">,
  query: {
    readonly callerId: string;
    readonly actorId: string;
    readonly verb: "enroll" | "unenroll";
  }
): NonNullable<ReturnType<GrantAuthorityReader["actor"]>> {
  const { callerId, actorId, verb } = query;
  const preposition = verb === "enroll" ? "in" : "from";
  if (!reader.capabilities(callerId).includes(EXPERIMENT_ADMIN_CAPABILITY)) {
    throw new Error(
      `only an ${EXPERIMENT_ADMIN_CAPABILITY} holder may ${verb} an actor ${preposition} an experiment`
    );
  }
  const record = reader.actor(actorId);
  if (!record) {
    throw new Error(`unknown thread id: ${actorId}`);
  }
  // Holding the capability is not reach: another top-level tree is a legal
  // shape this holder must not administer. The holder itself is admitted.
  if (!isAncestorIn(reader, callerId, actorId)) {
    throw new Error(
      `${callerId} may only ${verb} actors in its own subtree ${preposition} an experiment (cannot ${verb} ${actorId})`
    );
  }
  return record;
}
