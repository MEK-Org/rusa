import {
  CAPABILITY_ADMIN_CAPABILITY,
  EXPERIMENT_ADMIN_CAPABILITY,
} from "./administrative-capabilities.js";
import { PARENT_GRANTABLE_CAPABILITIES } from "./capability-grants.js";

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

/** The base a parent-grant decision matches; secrets keep their full name (#542). */
function parentGrantBase(capability: string): string {
  for (const base of [
    "chat-write",
    "calendar-read",
    "calendar-write",
    "email-send",
    "drive-read",
  ]) {
    if (capability.startsWith(`${base}:`)) return base;
  }
  return capability;
}

/**
 * Grantor authority for a grant or revocation. A `capability-admin` holder
 * may grant or revoke within its own subtree, itself included. Any other
 * grantor may only touch a capability in {@link PARENT_GRANTABLE_CAPABILITIES},
 * and only on its direct child. Fail-closed: an unknown grantor holds nothing.
 * Ids are already resolved.
 */
export function assertGrantAuthority(
  reader: GrantAuthorityReader,
  query: {
    readonly grantorId: string;
    readonly granteeId: string;
    readonly capability: string;
    readonly verb: "grant" | "revoke";
  }
): void {
  const { grantorId, granteeId, capability, verb } = query;
  const grantee = reader.actor(granteeId);
  if (!grantee) {
    throw new Error(`unknown thread id: ${granteeId}`);
  }
  if (reader.capabilities(grantorId).includes(CAPABILITY_ADMIN_CAPABILITY)) {
    if (!isAncestorIn(reader, grantorId, granteeId)) {
      throw new Error(
        `${grantorId} may only ${verb} capabilities in its own subtree (cannot ${verb} ${granteeId})`
      );
    }
    return;
  }
  if (!PARENT_GRANTABLE_CAPABILITIES.has(parentGrantBase(capability))) {
    throw new Error(
      `only a ${CAPABILITY_ADMIN_CAPABILITY} holder may ${verb} ${capability}; a parent without it may only ${verb}: ${
        [...PARENT_GRANTABLE_CAPABILITIES].join(", ") || "none"
      }`
    );
  }
  if (grantee.parentId !== grantorId) {
    throw new Error(
      `without ${CAPABILITY_ADMIN_CAPABILITY}, an actor may only ${verb} ${capability} to/from its direct children; ${granteeId} is not a child of ${grantorId}`
    );
  }
}

/**
 * Authority to enroll or unenroll: an `experiment-admin` holder, over its own
 * subtree (itself included), for an actor that exists. Fail-closed. Ids are
 * already resolved. Returns the target's record.
 */
export function assertExperimentAuthority(
  reader: GrantAuthorityReader,
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
