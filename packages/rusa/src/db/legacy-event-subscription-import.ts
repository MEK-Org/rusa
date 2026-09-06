import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  EVENT_SUBSCRIPTIONS_FILENAME,
  type EventSourceOwnership,
  parseLegacyEventSubscriptionDocument,
} from "../actor/event-subscriptions.js";
import type { Repositories } from "./repositories/index.js";

/** The receipt key for this source; see {@link LegacyImportReceiptRepository}. */
export const EVENT_SUBSCRIPTION_IMPORT_SOURCE = EVENT_SUBSCRIPTIONS_FILENAME;

/** The read-only slice of {@link Repositories} a plan is allowed to touch. */
interface PlanRepositories {
  actors: Pick<Repositories["actors"], "list">;
  eventSourceOwners: Pick<Repositories["eventSourceOwners"], "list">;
  legacyImportReceipts: Pick<Repositories["legacyImportReceipts"], "has">;
}

// Mirrors legacy-actor-import.ts's archive helpers: rename rather than
// delete, so the pre-import file is always recoverable after a commit.
function backupPath(path: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  let candidate = `${path}.imported-${timestamp}.bak`;
  let suffix = 1;
  while (existsSync(candidate)) candidate = `${path}.imported-${timestamp}-${suffix++}.bak`;
  return candidate;
}

function archive(path: string): string {
  const destination = backupPath(path);
  renameSync(path, destination);
  return destination;
}

export interface LegacyEventSubscriptionImportResult {
  importedSubscriptions: number;
  backupFiles: string[];
}

/** A read-only plan of what {@link applyLegacyEventSubscriptionImport} would do, with no writes performed. */
export type LegacyEventSubscriptionImportPlan =
  | { kind: "noop" }
  | { kind: "already-imported" }
  | { kind: "import"; subscriptions: EventSourceOwnership[] };

export interface LegacyEventSubscriptionImportPlanResult {
  plan: LegacyEventSubscriptionImportPlan;
  hasFile: boolean;
  filePath: string;
  /** Explicit subscriptions (active rows and tombstones) the plan would write. */
  plannedSubscriptions: number;
}

/**
 * Parse and validate `event-subscriptions.json` against the current
 * `event_source_owners` projection without performing any write. Only accepts a
 * read-only slice of {@link Repositories}, so it cannot open a DB transaction,
 * write a subscription, or archive the legacy file.
 *
 * Refuses — rather than importing a partial view — whenever the parse rejects a
 * row. The retired JSON store quarantined such rows and booted on the
 * remainder, which is defensible for a file that stays reparable in place;
 * committing the remainder is not, because it silently makes "this actor no
 * longer owns this event source" durable. Every unresolved row is named in the
 * error so the operator can repair the source and re-run.
 *
 * A legacy row otherwise resolves exactly as the JSON store resolved it:
 * canonical reference spellings converge to one key, several spellings of one
 * (resource, actor) pair collapse to that pair's latest state, tombstones are
 * preserved as tombstones, and an unversioned document's root-owned rows are
 * dropped as the config-implied seed `reconcileEventSources` re-derives anyway.
 *
 * @param options.rootId The root actor id, needed to recognize the
 * config-implied rows an unversioned document recorded durably.
 * @param options.pendingActorIds Actor ids that a legacy actor import has
 * planned but not yet committed. Preflight (`rusa db-check`) plans both imports
 * against one un-mutated copy, where the actors a subscription references may
 * legitimately not be in `actors` yet.
 */
export function planLegacyEventSubscriptionImport(options: {
  mcHome: string;
  repositories: PlanRepositories;
  rootId: string;
  pendingActorIds?: Iterable<string>;
}): LegacyEventSubscriptionImportPlanResult {
  const filePath = join(options.mcHome, EVENT_SUBSCRIPTIONS_FILENAME);
  const hasFile = existsSync(filePath);
  if (!hasFile) {
    return { plan: { kind: "noop" }, hasFile, filePath, plannedSubscriptions: 0 };
  }

  // The receipt is the precedence rule: once the import transaction committed,
  // SQLite is authoritative and a source file still on disk is stale by
  // construction — a failed archive rename, or a restored backup. Reading it
  // again could only overwrite durable rows the mesh has since moved on from.
  if (options.repositories.legacyImportReceipts.has(EVENT_SUBSCRIPTION_IMPORT_SOURCE)) {
    return { plan: { kind: "already-imported" }, hasFile, filePath, plannedSubscriptions: 0 };
  }

  const document = parseLegacyEventSubscriptionDocument(readFileSync(filePath, "utf8"), {
    file: filePath,
    rootId: options.rootId,
  });
  if (document.rejections.length > 0) {
    const detail = document.rejections
      .map((rejection) => `row ${rejection.row}: ${rejection.reason}`)
      .join("; ");
    throw new Error(
      `Legacy event-subscription import: ${filePath} has ${document.rejections.length} unresolved row(s); ` +
        `refusing to import a partial ownership view (${detail})`
    );
  }

  const actorIds = new Set(options.repositories.actors.list().map((actor) => actor.id));
  for (const id of options.pendingActorIds ?? []) actorIds.add(id);
  for (const subscription of document.subscriptions) {
    if (!actorIds.has(subscription.actorId)) {
      throw new Error(
        `Legacy event-subscription import: subscription to ${subscription.resource} ` +
          `references unknown actor '${subscription.actorId}'`
      );
    }
  }

  // No receipt but durable rows already exist: something wrote subscriptions
  // outside the importer, so neither side can be shown to be newer. Refuse
  // rather than guess which ownership survives.
  const existing = options.repositories.eventSourceOwners.list();
  if (existing.length > 0) {
    throw new Error(
      `Legacy event-subscription import: ${filePath} is present but ${existing.length} durable ` +
        "subscription(s) were written without an import receipt; refusing to overwrite them"
    );
  }

  return {
    plan: { kind: "import", subscriptions: document.subscriptions },
    hasFile,
    filePath,
    plannedSubscriptions: document.subscriptions.length,
  };
}

/**
 * Apply a {@link LegacyEventSubscriptionImportPlan} produced by
 * {@link planLegacyEventSubscriptionImport} for the same home: write the durable
 * rows and the import receipt in one transaction, then archive the legacy file.
 *
 * The two steps split the failure modes cleanly. An interruption before commit
 * leaves no rows and no receipt, so the next boot re-plans against the intact
 * file and gets the complete legacy view. An interruption after commit leaves
 * rows and a receipt, so the next boot sees the receipt, archives the file
 * unread, and gets the complete database view. There is no ordering that yields
 * a mixture.
 */
export function applyLegacyEventSubscriptionImport(
  planResult: LegacyEventSubscriptionImportPlanResult,
  options: { db: Database.Database; repositories: Repositories; now?: () => string }
): LegacyEventSubscriptionImportResult {
  const { plan, filePath } = planResult;
  const now = options.now ?? (() => new Date().toISOString());

  switch (plan.kind) {
    case "noop":
      return { importedSubscriptions: 0, backupFiles: [] };

    case "already-imported":
      return { importedSubscriptions: 0, backupFiles: [archive(filePath)] };

    case "import": {
      const { subscriptions } = plan;
      options.db.transaction(() => {
        // `restore`, not `subscribe`: a tombstone must land as a tombstone.
        // The plan orders tombstones first, so replaying it never trips the
        // one-active-subscriber invariant on its way to the final state.
        for (const subscription of subscriptions) {
          options.repositories.eventSourceOwners.restore(subscription);
        }
        options.repositories.legacyImportReceipts.record(
          EVENT_SUBSCRIPTION_IMPORT_SOURCE,
          now(),
          subscriptions.length
        );
      })();
      return { importedSubscriptions: subscriptions.length, backupFiles: [archive(filePath)] };
    }
  }
}

/**
 * Import the retired `event-subscriptions.json` file exactly once: plan, then
 * apply. See {@link planLegacyEventSubscriptionImport} and
 * {@link applyLegacyEventSubscriptionImport}.
 */
export function importLegacyEventSubscriptionState(options: {
  mcHome: string;
  db: Database.Database;
  repositories: Repositories;
  rootId: string;
}): LegacyEventSubscriptionImportResult {
  const planResult = planLegacyEventSubscriptionImport(options);
  return applyLegacyEventSubscriptionImport(planResult, options);
}
