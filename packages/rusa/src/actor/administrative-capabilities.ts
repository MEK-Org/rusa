import { PNPM_HARDLINKS_MCP_NAME } from "../mcp/pnpm-hardlinks-mcp.js";
import { UPDATE_MCP_NAME } from "../mcp/update-mcp.js";
import type { CapabilityGrantStore } from "./capability-grants.js";

/**
 * Administrative authority over other actors is a set of narrowly named,
 * grant-derived capabilities (#549) — not a property of the distinguished root
 * actor. Each name covers exactly one existing administrative surface; none of
 * them is a catch-all "root" marker, and holding one confers nothing about the
 * others. Topology (`parentId === null`), the `isRoot` record flag, and the
 * literal `root` address grant none of these.
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
 * The capabilities administered on the agent-execution endpoint itself. They
 * mount no server of their own; the mesh consults them for authority and the
 * endpoint registers the matching management tools for a holder.
 */
export const ADMINISTRATIVE_CAPABILITIES: ReadonlySet<string> = new Set([
  CAPABILITY_ADMIN_CAPABILITY,
  EXPERIMENT_ADMIN_CAPABILITY,
  MODEL_ADMIN_CAPABILITY,
  ACTOR_ADMIN_CAPABILITY,
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
 * restarting or relinking the daemon, and editing the mesh-global model-class
 * registry. The subtree boundary that bounds every other delegation cannot
 * bound these, so the mesh never grants one — not downward, and not to the
 * grantor itself, which is the path by which a delegated `capability-admin`
 * holder would otherwise widen into host authority. Only the bootstrap seed
 * (or a direct row) creates one; a holder may revoke it from itself, and that
 * revocation is deliberately one-way from inside the mesh.
 */
export const HOST_GLOBAL_CAPABILITIES: ReadonlySet<string> = new Set([
  MODEL_ADMIN_CAPABILITY,
  ...HOST_MAINTENANCE_CAPABILITIES,
]);

/**
 * Everything the configured actor held implicitly before administration became
 * grant-derived. This is the compatibility set the wiring seeds once per
 * installation so an upgrade keeps the configured actor's operational access.
 */
export const CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES: readonly string[] = [
  ...ADMINISTRATIVE_CAPABILITIES,
  ...HOST_MAINTENANCE_CAPABILITIES,
];

/**
 * The subset of the bootstrap set whose FIRST insertion this boot should
 * perform: every administrative capability (they gate tools on the agent-exec
 * endpoint, which always exists) plus only those host-maintenance servers the
 * wiring managed to build, so a host whose deploy checkout can't be resolved
 * never gets an `update` row written on its behalf. This governs insertion
 * only. Seeding is non-destructive by design, so a row seeded by an earlier
 * boot stays active on a later boot that cannot mount its server; that row is
 * inert until the server is mountable again.
 */
export function bootstrapCapabilitiesFor(mountable: ReadonlySet<string>): string[] {
  return CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES.filter(
    (capability) => ADMINISTRATIVE_CAPABILITIES.has(capability) || mountable.has(capability)
  );
}

/** The `grantedBy` recorded on a seeded row, so the audit view shows its provenance. */
export const CONFIGURED_ACTOR_BOOTSTRAP_GRANTOR = "system:bootstrap";

/**
 * Seed the configured actor's administrative grants exactly once per
 * (actor, capability) pair. A pair that already has a row — active OR revoked —
 * is left alone, so a revocation survives every later boot: the seed is a
 * one-time import of the access the configured actor already had, never a
 * standing source of authority. Returns the capabilities this call granted.
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
