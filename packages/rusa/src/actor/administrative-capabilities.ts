import type { RusaConfig } from "../config/types.js";
import { OBLIGATION_RESPONSIVE_CAPABILITY } from "../mcp/obligations-mcp.js";
import { PNPM_HARDLINKS_MCP_NAME } from "../mcp/pnpm-hardlinks-mcp.js";
import { UPDATE_MCP_NAME } from "../mcp/update-mcp.js";
import type { ActorRecord } from "./actor-record.js";
import type { CapabilityGrantStore } from "./capability-grants.js";

/**
 * Administrative authority over other actors is a set of narrowly named,
 * grant-derived capabilities (#549) — not a property of the distinguished root
 * actor. Each name covers exactly one existing administrative surface; none of
 * them is a catch-all "root" marker, and holding one confers nothing about the
 * others. Explicit durable grants and the default actor’s in-memory capabilities authorize
 * these operations. Startup resolves the oldest active parentless actor, while the
 * literal `root` address itself grants nothing.
 *
 * Every operation that names a target actor is scoped to the holder's own
 * subtree (itself included); the mesh enforces that boundary, not the tool
 * layer alone. The few surfaces with no subtree to scope to — the daemon
 * itself and the mesh-global model-class registry — are host-global and are
 * never granted through the mesh (see {@link HOST_GLOBAL_CAPABILITIES}).
 */

/** Grant or revoke any grantable capability within the holder's subtree, and inspect the grant ledger. */
export const CAPABILITY_ADMIN_CAPABILITY = "capability-admin";

/** Enroll, unenroll, and list experiment rollouts within the holder's subtree. */
export const EXPERIMENT_ADMIN_CAPABILITY = "experiment-admin";

/**
 * Administer the host's model policy: the runtime model-class registry, which
 * is mesh-global (a class edit reaches every future spawn or model change on
 * the host), plus replacing the model pool of any actor in the holder's
 * subtree, itself included. The registry half is what makes this host-global
 * (see {@link HOST_GLOBAL_CAPABILITIES}); the per-actor half adds only "self"
 * over the parent path every ancestor already has.
 */
export const MODEL_ADMIN_CAPABILITY = "model-admin";

/**
 * Lifecycle management of actors in the holder's subtree — revive, re-title,
 * re-charter, reparent, schedule wakes — plus the inspection reads over that
 * same subtree (wakes, event-source ownership and subscriptions).
 */
export const ACTOR_ADMIN_CAPABILITY = "actor-admin";

/**
 * Manage membership of the one mesh-wide voice Chat Room (#663): add or remove
 * participants, and give an added actor an unused voice when its own collides.
 * The room has no subtree to scope to, so this is host-global like the
 * model-class registry: included in the in-memory default set and never granted
 * through the mesh. Room membership itself remains explicit.
 */
export const ROOM_ADMIN_CAPABILITY = "room-admin";

/**
 * Manage obligations regardless of their owner or actor-tree position. This is
 * deliberately distinct from actor administration: it lets a named actor work
 * human-owned and orphan-owned obligations, but grants no lifecycle, model, or
 * capability authority. The in-memory default role belongs to the oldest active
 * parentless actor; further bindings require an authenticated operator.
 */
export const OBLIGATIONS_ADMIN_CAPABILITY = "obligations-admin";

/**
 * Beyond the in-memory default role, these durable rows are changed only through an
 * authenticated operator boundary. Keeping this separate from host-global capabilities is
 * intentional: obligations administration has no host-wide side effect, but
 * an actor-facing grantor must not bootstrap cross-owner obligation reach.
 */
export const OPERATOR_PROVISIONED_CAPABILITIES: ReadonlySet<string> = new Set([
  OBLIGATIONS_ADMIN_CAPABILITY,
]);

/**
 * The capabilities administered on the agent-execution endpoint itself. They
 * mount no server of their own; the mesh consults them for authority and the
 * endpoint registers the matching management tools for a holder.
 */
export const ADMINISTRATIVE_CAPABILITIES: ReadonlySet<string> = new Set([
  CAPABILITY_ADMIN_CAPABILITY,
  EXPERIMENT_ADMIN_CAPABILITY,
  MODEL_ADMIN_CAPABILITY,
  ACTOR_ADMIN_CAPABILITY,
  ROOM_ADMIN_CAPABILITY,
]);

/**
 * Host/process maintenance is an MCP server like any other grantable one: the
 * capability name is the server name, and the composition point mounts the
 * server for whichever actor holds the row. Both are host-global (below).
 */
export const HOST_MAINTENANCE_CAPABILITIES: ReadonlySet<string> = new Set([
  UPDATE_MCP_NAME,
  PNPM_HARDLINKS_MCP_NAME,
]);

/**
 * Capabilities that act on the whole host rather than on a subtree of actors:
 * restarting or relinking the daemon, editing the mesh-global model-class
 * registry, and managing the mesh-wide Chat Room roster. The subtree boundary that bounds every other delegation cannot
 * bound these, so the mesh never grants one — not downward, and not to the
 * grantor itself, which is the path by which a delegated `capability-admin`
 * holder would otherwise widen into host authority. The default actor
 * holds these in memory. Explicit durable grants remain independently
 * revocable; revocation does not remove role-derived authority.
 */
export const HOST_GLOBAL_CAPABILITIES: ReadonlySet<string> = new Set([
  MODEL_ADMIN_CAPABILITY,
  ROOM_ADMIN_CAPABILITY,
  ...HOST_MAINTENANCE_CAPABILITIES,
]);

/**
 * Everything the configured actor held implicitly before administration became
 * grant-derived. The default role supplies this fixed set in memory for the
 * oldest active parentless actor, independently of explicit durable grants.
 */
export const CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES: readonly string[] = [
  ...ADMINISTRATIVE_CAPABILITIES,
  OBLIGATIONS_ADMIN_CAPABILITY,
  OBLIGATION_RESPONSIVE_CAPABILITY,
  ...HOST_MAINTENANCE_CAPABILITIES,
];

/** The former root’s implicit permissions, including configured communication scope. */
export function defaultActorBootstrapCapabilities(
  config: Pick<RusaConfig, "chat" | "slack">
): string[] {
  const capabilities = [...CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES];
  if (config.chat) {
    const spaces = config.chat.gchat;
    capabilities.push(
      ...(Array.isArray(spaces) ? spaces : ["*"]).map((space) => `chat-write:${space}`)
    );
  }
  if (config.slack) capabilities.push("slack-write:*");
  return capabilities;
}

/** Legacy default-row provenance; retained rows remain inspectable but grant no authority. */
export const CONFIGURED_ACTOR_BOOTSTRAP_GRANTOR = "system:bootstrap";

/**
 * Supply role-derived authority without materializing it in the grant store.
 * The composition point selects the recipient at boot (or first creation on an
 * empty instance). Explicit grants remain independent and revocable. Old
 * bootstrap rows remain in the audit view but cannot preserve a former
 * recipient's authority or a removed configured communication scope.
 */
export function withDefaultActorCapabilities(
  store: CapabilityGrantStore,
  recipient: () => string | undefined,
  capabilities: readonly string[]
): CapabilityGrantStore {
  return {
    grant: (grant) => store.grant(grant),
    revoke: (actorId, capability, at) => store.revoke(actorId, capability, at),
    list: () => store.list(),
    activeFor: (actorId) =>
      [
        ...new Set([
          ...store
            .list()
            .filter(
              (grant) =>
                grant.actorId === actorId &&
                !grant.revokedAt &&
                grant.grantedBy !== CONFIGURED_ACTOR_BOOTSTRAP_GRANTOR
            )
            .map((grant) => grant.capability),
          ...(actorId === recipient() ? capabilities : []),
        ]),
      ].sort(),
  };
}

/**
 * Legacy fixture helper: insert the former default grants exactly once per
 * (actor, capability) pair. A pair that already has a row — active OR revoked —
 * is left alone, so a revocation survives every later boot: the seed is a
 * materialization of defaults into durable rows. Returns the capabilities
 * this call granted. The caller resolves which actor receives the defaults.
 */
export function seedConfiguredActorGrants(
  store: CapabilityGrantStore,
  actorId: string,
  now: () => string = () => new Date().toISOString(),
  capabilities: readonly string[] = CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES
): string[] {
  const existing = new Set(
    store
      .list()
      .filter((grant) => grant.actorId === actorId)
      .map((grant) => grant.capability)
  );
  const seeded: string[] = [];
  for (const capability of capabilities) {
    if (existing.has(capability)) continue;
    store.grant({
      actorId,
      capability,
      grantedBy: CONFIGURED_ACTOR_BOOTSTRAP_GRANTOR,
      grantedAt: now(),
    });
    seeded.push(capability);
  }
  return seeded;
}

/** Default grants go to the oldest live top-level actor (#1087). Ties use its stable id. */
export function defaultGrantRecipient(records: readonly ActorRecord[]): ActorRecord | undefined {
  return records
    .filter((record) => record.parentId === null && record.status === "active")
    .sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id)
    )[0];
}
