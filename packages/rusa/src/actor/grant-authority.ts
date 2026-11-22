import {
  chatWriteParam,
  holdsChatWriteSpace,
  parseChatWriteScope,
} from "../chat/chat-write-scope.js";
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
  /** Active grant rows (with provenance) held by the actor now, when available. */
  activeGrants?(id: string): readonly { readonly capability: string; readonly grantedBy: string }[];
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

const GLASS_GOALS_PREFIX = "glass_goals:";

function parseGlassGoalsScope(
  capability: string
): { readonly user: string; readonly access: "read" | "write" } | undefined {
  if (!capability.startsWith(GLASS_GOALS_PREFIX)) return undefined;
  const rest = capability.slice(GLASS_GOALS_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return undefined;
  const user = rest.slice(0, sep);
  const access = rest.slice(sep + 1);
  if (access !== "read" && access !== "write") return undefined;
  return { user, access };
}

function glassGoalsCovers(
  held: { readonly user: string; readonly access: "read" | "write" },
  target: { readonly user: string; readonly access: "read" | "write" }
): boolean {
  return held.user === target.user && (held.access === "write" || held.access === target.access);
}

/**
 * True when `grantorId` actively holds a `glass_goals:<user>:read|write`
 * capability covering `target` that was not itself delegated by a non-admin
 * parent (one-level delegation, #1344).
 */
function holdsDelegableGlassGoals(
  reader: GrantAuthorityReader,
  grantorId: string,
  target: { readonly user: string; readonly access: "read" | "write" }
): boolean {
  const activeCaps = new Set(reader.capabilities(grantorId));
  if (reader.activeGrants) {
    const grantorParentId = reader.actor(grantorId)?.parentId ?? null;
    for (const grant of reader.activeGrants(grantorId)) {
      if (!activeCaps.has(grant.capability)) continue;
      const held = parseGlassGoalsScope(grant.capability);
      if (!held || !glassGoalsCovers(held, target)) continue;
      const delegatedByNonAdminParent =
        grantorParentId !== null &&
        grant.grantedBy === grantorParentId &&
        !reader.capabilities(grant.grantedBy).includes(CAPABILITY_ADMIN_CAPABILITY);
      if (!delegatedByNonAdminParent) return true;
    }
    return false;
  }
  for (const cap of activeCaps) {
    const held = parseGlassGoalsScope(cap);
    if (held && glassGoalsCovers(held, target)) return true;
  }
  return false;
}

/**
 * Grantor authority for a grant or revocation. Granting a thread-scoped
 * `chat-write:spaces/S/threads/T` is authorized by the grantor's own active
 * `chat-write` on space S, for any existing grantee (#1311): the grant is
 * narrower than what the grantor already holds. #1311 commissions that grant
 * only, so revoking it keeps the rules below. Granting or revoking a
 * `glass_goals:<user>:read|write` capability on a direct child is authorized
 * by the grantor's own non-parent-delegated active covering `glass_goals`
 * capability (#1344). Otherwise a `capability-admin` holder may grant or
 * revoke within its own subtree, itself included, and any other grantor may
 * only touch a capability in {@link PARENT_GRANTABLE_CAPABILITIES}, and only
 * on its direct child. Fail-closed: an unknown grantor holds nothing. Ids are
 * already resolved.
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
  const chatParam = chatWriteParam(capability);
  const chatScope = chatParam === undefined ? undefined : parseChatWriteScope(chatParam);
  if (
    verb === "grant" &&
    chatScope?.kind === "thread" &&
    holdsChatWriteSpace(reader.capabilities(grantorId), chatScope.space)
  ) {
    return;
  }
  const glassGoalsScope = parseGlassGoalsScope(capability);
  if (
    glassGoalsScope &&
    grantee.parentId === grantorId &&
    holdsDelegableGlassGoals(reader, grantorId, glassGoalsScope)
  ) {
    return;
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
