import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import type { ActorRecord } from "../actor/actor-record.js";
import { resolveHome } from "../config/index.js";
import { planLegacyActorImport } from "../db/legacy-actor-import.js";
import { planLegacyCapabilityGrantImport } from "../db/legacy-capability-grant-import.js";
import { planLegacyEventSubscriptionImport } from "../db/legacy-event-subscription-import.js";
import { planLegacyHostJobImport } from "../db/legacy-host-job-import.js";
import { pendingMigrationIds, runMigrations } from "../db/migrations/runner.js";
import { Repositories } from "../db/repositories/index.js";
import { widenToWal } from "../db/wal.js";

export interface DbCheckResult {
  pendingMigrationIds: string[];
  plannedActors: number;
  plannedScheduledMessages: number;
  plannedCapabilityGrants: number;
  plannedEventSourceOwnerships: number;
  plannedHostJobs: number;
}

/**
 * The actor set the grant planner would see at boot. `start.ts` imports legacy
 * actors before legacy grants, so by the time it plans grants the actors named
 * by `capability-grants.json` are committed rows. Preflight plans both against
 * one unchanged database, so a grant naming an actor that only exists in
 * `threads.json` would look like a dangling reference unless the planned
 * records are added to the committed ones here. The union is read-only: these
 * records are the actor plan's own output, never written back.
 *
 * When the actor import plans nothing there is nothing to add, and when actors
 * are already committed the actor planner has verified `threads.json` matches
 * them exactly, so the union adds nothing either.
 */
function actorsVisibleToGrantPlan(committed: ActorRecord[], pending: ActorRecord[]): ActorRecord[] {
  const byId = new Map(committed.map((record) => [record.id, record]));
  for (const record of pending) {
    if (!byId.has(record.id)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

/** Resolve symlinks when the path exists on disk; otherwise just normalize it. */
function realOrNormalized(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Preflight a copy of an instance home: apply pending migrations to its
 * `data/mesh.db`, then plan (never write) the legacy JSON import against the
 * same copy. Never falls back to the default Rusa home, and refuses to run
 * against the live configured/default Rusa home (including a symlink alias
 * of it) — a caller must supply an explicit path to a separate copy, since
 * this opens a real database and this function's whole purpose is to be safe
 * to run against a copy before a deploy touches the live instance.
 */
export function runDbCheckAgainstHome(home: string): DbCheckResult {
  if (!home.trim()) {
    throw new Error("rusa db-check: --home is required and has no default fallback");
  }
  if (!existsSync(home) || !statSync(home).isDirectory()) {
    throw new Error(`rusa db-check: --home "${home}" does not exist as a directory`);
  }
  const liveHome = resolveHome();
  if (realOrNormalized(home) === realOrNormalized(liveHome)) {
    throw new Error(
      `rusa db-check: --home "${home}" resolves to the live Rusa home (${liveHome}); ` +
        "db-check must run against a separate copy, never the live home"
    );
  }
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "mesh.db"));
  try {
    widenToWal(db);
    db.pragma("foreign_keys = ON");
    const pending = pendingMigrationIds(db);
    runMigrations(db);

    const repositories = new Repositories(db);
    const plan = planLegacyActorImport({ mcHome: home, repositories });

    // Every import is planned against one un-mutated copy, so an actor a grant,
    // a subscription or a host job references may still be pending rather than
    // committed. Each plan is told about those records explicitly instead of
    // failing on an ordering that only exists because preflight plans and never
    // applies.
    const pendingActors = plan.plan.kind === "import" ? plan.plan.records : [];

    // The grant planner accepts only a read-only slice, so the substituted
    // actor view cannot become a write: it can only be listed.
    const grantPlan = planLegacyCapabilityGrantImport({
      mcHome: home,
      repositories: {
        actors: {
          list: () => actorsVisibleToGrantPlan(repositories.actors.list(), pendingActors),
        },
        capabilityGrants: repositories.capabilityGrants,
      },
    });

    // Parentless *is* the definition of root that boot's `resolveRootActorId`
    // uses, and neither side can hold two: the `actors` table carries a unique
    // index over `parent_id IS NULL`, and a legacy document with anything other
    // than exactly one root is refused while planning, above. So the first match
    // is the only match, and preflight recognizes the same config-implied rows
    // boot would. Boot mints a root id when both sides are empty; preflight
    // cannot invent one, and does not need to — a minted id has never appeared
    // in a legacy document, so it matches nothing either.
    const rootId =
      repositories.actors.list().find((actor) => actor.parentId === null)?.id ??
      pendingActors.find((actor) => actor.parentId === null)?.id;
    const subscriptionPlan = planLegacyEventSubscriptionImport({
      mcHome: home,
      repositories,
      // With no root on either side there are no config-implied legacy rows to
      // recognize, and no id can match one.
      rootId: rootId ?? "",
      pendingActorIds: pendingActors.map((actor) => actor.id),
    });

    // Same pending-actor treatment as the subscription plan: a job's owning
    // actor may still be planned rather than committed on this un-mutated copy.
    const hostJobPlan = planLegacyHostJobImport({
      mcHome: home,
      repositories,
      pendingActorIds: pendingActors.map((actor) => actor.id),
    });

    return {
      pendingMigrationIds: pending,
      plannedActors: plan.plannedActors,
      plannedScheduledMessages: plan.plannedScheduledMessages,
      plannedCapabilityGrants: grantPlan.plan.kind === "import" ? grantPlan.plan.grants.length : 0,
      plannedEventSourceOwnerships: subscriptionPlan.plannedSubscriptions,
      plannedHostJobs: hostJobPlan.plannedJobs,
    };
  } finally {
    db.close();
  }
}

/** CLI entry point for `rusa db-check --home <dir>`. Exits non-zero on any actionable failure. */
export function runDbCheck(opts: { home: string }): void {
  try {
    const result = runDbCheckAgainstHome(opts.home);
    console.log(
      result.pendingMigrationIds.length > 0
        ? `Pending migrations: ${result.pendingMigrationIds.join(", ")}`
        : "Pending migrations: none"
    );
    console.log(
      `Legacy import plan: ${result.plannedActors} actor(s), ` +
        `${result.plannedScheduledMessages} scheduled message(s), ` +
        `${result.plannedCapabilityGrants} capability grant(s), ` +
        `${result.plannedEventSourceOwnerships} event source ownership(s), ` +
        `${result.plannedHostJobs} host job(s)`
    );
    console.log("✓ db-check passed");
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
