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
 * Every capability below is scoped to the holder's own subtree (itself
 * included) wherever the operation names a target actor; the mesh enforces that
 * boundary, not the tool layer alone.
 */

/** Grant or revoke any grantable capability within the holder's subtree, and inspect the grant ledger. */
export const CAPABILITY_ADMIN_CAPABILITY = "capability-admin";

/** Enroll, unenroll, and list experiment rollouts within the holder's subtree. */
export const EXPERIMENT_ADMIN_CAPABILITY = "experiment-admin";

/**
 * Replace the model pool of any actor in the holder's subtree (the holder
 * itself included) and manage the runtime model-class registry.
 */
export const MODEL_ADMIN_CAPABILITY = "model-admin";

/**
 * Lifecycle management of actors in the holder's subtree — revive, re-title,
 * re-charter, reparent — plus the mesh-wide inspection and wake-schedule tools
 * that have no per-actor target.
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
 * Host/process maintenance is a grantable MCP server like any other: the
 * capability name is the server name, and the composition point mounts the
 * server for whichever actor holds the grant. Unlike the administrative
 * capabilities it is NOT delegable — it acts on the whole daemon, so the
 * subtree boundary cannot bound it; the mesh lets a holder hold, revoke and
 * restore it on itself but never grant it to another actor.
 */
export const HOST_MAINTENANCE_CAPABILITIES: ReadonlySet<string> = new Set([
  UPDATE_MCP_NAME,
  PNPM_HARDLINKS_MCP_NAME,
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
 * The bootstrap set this boot can actually stand behind: every administrative
 * capability (they gate tools on the agent-exec endpoint, which always exists)
 * plus only those host-maintenance servers the wiring managed to build. A host
 * whose deploy checkout can't be resolved boots without `update`, and a seeded
 * grant with no server behind it would read as authority that does nothing.
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
