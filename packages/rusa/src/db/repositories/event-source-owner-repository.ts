import type Database from "better-sqlite3";
import {
  activeOwnerConflictMessage,
  type EventResource,
  type EventSourceOwnerStore,
  type EventSourceOwnership,
  type EventSourceOwnershipAuditEvent,
  isSubResourceOf,
  missingAuditedEventSourceOwnerships,
  resourceKey,
} from "../../actor/event-subscriptions.js";
import { CONFIGURED_ACTOR_IMPORT_SOURCE } from "../configured-actor-import.js";

type SubscriptionRow = {
  resource: string;
  actor_id: string;
  subscribed_by: string;
  subscribed_at: string;
  unsubscribed_at: string | null;
  config: string | null;
};

function fromRow(row: SubscriptionRow): EventSourceOwnership {
  return {
    resource: row.resource,
    actorId: row.actor_id,
    subscribedBy: row.subscribed_by,
    subscribedAt: row.subscribed_at,
    ...(row.unsubscribed_at !== null ? { unsubscribedAt: row.unsubscribed_at } : {}),
  };
}

const SELECT_COLUMNS = "resource, actor_id, subscribed_by, subscribed_at, unsubscribed_at, config";
const ROUTE_MATERIALIZATION_VERSION = 1;
const ROUTE_DISPOSITIONS = new Set<RouteMaterializationSnapshot["routes"][number]["disposition"]>([
  "materialized",
  "existing_active",
  "unrouted_tombstone",
  "unrouted_missing_audit",
  "no_actor",
]);

type ConfiguredActorReceiptRow = {
  row_count: number;
  actor_id: string | null;
};

type RouteMaterializationReceiptRow = { input_snapshot_json: string };

type RouteMaterializationSnapshot = {
  version: 1;
  configuredActorImport: { source: string; rowCount: number; actorId: string | null };
  configuredRoots: string[];
  routes: Array<{
    resource: string;
    disposition:
      | "materialized"
      | "existing_active"
      | "unrouted_tombstone"
      | "unrouted_missing_audit"
      | "no_actor";
  }>;
};

export type ConfiguredRouteMaterializationResult = {
  store: DbEventSourceOwnerStore;
  droppedDelegations: EventSourceOwnership[];
  unroutedMissingOwnerships: Array<{ resource: EventResource; actorId: string }>;
  routeCount: number;
};

function parseRouteMaterializationSnapshot(raw: string): RouteMaterializationSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("event-source route materialization receipt has invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("event-source route materialization receipt must be an object");
  }
  const snapshot = parsed as Partial<RouteMaterializationSnapshot>;
  if (snapshot.version !== ROUTE_MATERIALIZATION_VERSION) {
    throw new Error("event-source route materialization receipt has an unsupported version");
  }
  if (
    !snapshot.configuredActorImport ||
    typeof snapshot.configuredActorImport !== "object" ||
    snapshot.configuredActorImport.source !== CONFIGURED_ACTOR_IMPORT_SOURCE ||
    typeof snapshot.configuredActorImport.rowCount !== "number" ||
    !Number.isInteger(snapshot.configuredActorImport.rowCount) ||
    snapshot.configuredActorImport.rowCount < 0 ||
    !(
      snapshot.configuredActorImport.actorId === null ||
      (typeof snapshot.configuredActorImport.actorId === "string" &&
        snapshot.configuredActorImport.actorId.length > 0)
    ) ||
    !Array.isArray(snapshot.configuredRoots) ||
    !snapshot.configuredRoots.every((resource) => {
      if (typeof resource !== "string") return false;
      try {
        return resourceKey(resource) === resource;
      } catch {
        return false;
      }
    }) ||
    new Set(snapshot.configuredRoots).size !== snapshot.configuredRoots.length ||
    !Array.isArray(snapshot.routes) ||
    !snapshot.routes.every(
      (route) =>
        route &&
        typeof route === "object" &&
        typeof route.resource === "string" &&
        (() => {
          try {
            return resourceKey(route.resource) === route.resource;
          } catch {
            return false;
          }
        })() &&
        typeof route.disposition === "string" &&
        ROUTE_DISPOSITIONS.has(
          route.disposition as RouteMaterializationSnapshot["routes"][number]["disposition"]
        )
    )
  ) {
    throw new Error("event-source route materialization receipt has an invalid snapshot");
  }
  return snapshot as RouteMaterializationSnapshot;
}

function materializedRouteCount(snapshot: RouteMaterializationSnapshot): number {
  return snapshot.routes.filter((route) => route.disposition === "materialized").length;
}

/**
 * SQLite implementation of {@link EventSourceOwnerStore} — every call reads
 * straight from `event_source_owners` with no process-local cache, so a
 * subscribe or unsubscribe committed by another connection is visible to the
 * next call without an orchestrator restart. `actor_id` is owned by the
 * referenced `actors` row (0038_event_source_owners).
 *
 * This holds only *explicit* subscriptions. The config-implied seed lives in an
 * `InMemoryEventSourceOwnerStore` that `reconcileEventSources` rebuilds each
 * boot and unions over this one, so a tombstone written here keeps suppressing
 * its implied counterpart across restarts.
 */
export class DbEventSourceOwnerStore implements EventSourceOwnerStore {
  constructor(private readonly db: Database.Database) {}

  subscribe(
    subscription: Omit<EventSourceOwnership, "resource"> & { resource: EventResource }
  ): void {
    this.write({ ...subscription, unsubscribedAt: undefined });
  }

  /**
   * Hydrate one already-durable row without reactivating a tombstone — the
   * write the legacy importer needs, and the counterpart of
   * `InMemoryEventSourceOwnerStore.restore`. Deliberately off
   * {@link EventSourceOwnerStore}: nothing in the mesh may resurrect a
   * subscription except through `subscribe`.
   */
  restore(subscription: EventSourceOwnership): void {
    this.write(subscription);
  }

  private write(subscription: EventSourceOwnership): void {
    const resource = resourceKey(subscription.resource);
    // One active subscriber per resource. The conflict check and the write are
    // one transaction so a concurrent writer cannot slip between them; the
    // partial unique index still refuses the row if one ever did.
    this.db.transaction(() => {
      if (!subscription.unsubscribedAt) {
        const holder = this.activeForResource(resource).find(
          (active) => active.actorId !== subscription.actorId
        );
        if (holder) {
          throw new Error(
            activeOwnerConflictMessage(resource, holder.actorId, subscription.actorId)
          );
        }
      }
      this.db
        .prepare(
          `INSERT INTO event_source_owners
             (resource, actor_id, subscribed_by, subscribed_at, unsubscribed_at, config)
           VALUES (?, ?, ?, ?, ?, NULL)
           ON CONFLICT(resource, actor_id) DO UPDATE SET
             subscribed_by = excluded.subscribed_by,
             subscribed_at = excluded.subscribed_at,
             unsubscribed_at = excluded.unsubscribed_at,
             config = excluded.config`
        )
        .run(
          resource,
          subscription.actorId,
          subscription.subscribedBy,
          subscription.subscribedAt,
          subscription.unsubscribedAt ?? null
        );
    })();
  }

  unsubscribe(resource: EventResource, actorId: string, at: string): void {
    this.db
      .prepare(
        `UPDATE event_source_owners SET unsubscribed_at = ?
         WHERE resource = ? AND actor_id = ? AND unsubscribed_at IS NULL`
      )
      .run(at, resourceKey(resource), actorId);
  }

  list(): EventSourceOwnership[] {
    return (
      this.db
        .prepare(`SELECT ${SELECT_COLUMNS} FROM event_source_owners`)
        .all() as SubscriptionRow[]
    ).map(fromRow);
  }

  activeForResource(resource: EventResource): EventSourceOwnership[] {
    return (
      this.db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM event_source_owners
           WHERE resource = ? AND unsubscribed_at IS NULL`
        )
        .all(resourceKey(resource)) as SubscriptionRow[]
    ).map(fromRow);
  }

  getConfig(resource: EventResource): string | null | undefined {
    const row = this.db
      .prepare(
        "SELECT config FROM event_source_owners WHERE resource = ? AND unsubscribed_at IS NULL"
      )
      .get(resourceKey(resource)) as { config: string | null } | undefined;
    return row?.config;
  }

  setConfig(resource: EventResource, config: string | null): void {
    const key = resourceKey(resource);
    const result = this.db
      .prepare(
        "UPDATE event_source_owners SET config = ? WHERE resource = ? AND unsubscribed_at IS NULL"
      )
      .run(config, key);
    if (result.changes !== 1) {
      throw new Error(`cannot configure ${key}: no active event-source owner`);
    }
  }

  /**
   * Convert the pre-#1003 config-implied routes into explicit SQLite rows once.
   *
   * A no-row configured source was effective before this conversion only when
   * no retained audit event says another still-active owner has disappeared.
   * That ambiguity is reported and deliberately left unrouted. Existing active
   * owners and tombstones always win. The configured-actor import receipt is
   * read here, in the immediate transaction, rather than trusting a topology
   * or a caller-supplied actor id.
   */
  materializeConfiguredRoutesV1(options: {
    configuredRoots: readonly EventResource[];
    auditEvents: readonly EventSourceOwnershipAuditEvent[];
    at: string;
  }): ConfiguredRouteMaterializationResult {
    const run = () => {
      const configuredRoots = [...new Set(options.configuredRoots.map(resourceKey))].sort();
      const completed = this.db
        .prepare(
          `SELECT input_snapshot_json
           FROM event_source_route_materialization_receipts WHERE version = ?`
        )
        .get(ROUTE_MATERIALIZATION_VERSION) as RouteMaterializationReceiptRow | undefined;
      if (completed) {
        const snapshot = parseRouteMaterializationSnapshot(completed.input_snapshot_json);
        return {
          store: this,
          droppedDelegations: this.dropUnanchoredDelegations(configuredRoots, options.at),
          unroutedMissingOwnerships: [],
          routeCount: materializedRouteCount(snapshot),
        };
      }

      const configuredActor = this.db
        .prepare(`SELECT row_count, actor_id FROM legacy_import_receipts WHERE source = ?`)
        .get(CONFIGURED_ACTOR_IMPORT_SOURCE) as ConfiguredActorReceiptRow | undefined;
      if (!configuredActor) {
        throw new Error("configured-actor import receipt is missing before route materialization");
      }
      if (
        !Number.isInteger(configuredActor.row_count) ||
        configuredActor.row_count < 0 ||
        (configuredActor.row_count === 0) !== (configuredActor.actor_id === null)
      ) {
        throw new Error(
          "configured-actor import receipt is inconsistent before route materialization"
        );
      }

      const droppedDelegations = this.dropUnanchoredDelegations(configuredRoots, options.at);

      const rows = this.list();
      const missingByResource = new Map(
        missingAuditedEventSourceOwnerships(this, options.auditEvents).map((missing) => [
          resourceKey(missing.resource),
          missing,
        ])
      );
      const unroutedMissingOwnerships: Array<{ resource: EventResource; actorId: string }> = [];
      const routes: RouteMaterializationSnapshot["routes"] = [];
      let routeCount = 0;

      for (const resource of configuredRoots) {
        const exactRows = rows.filter((row) => row.resource === resource);
        if (exactRows.some((row) => !row.unsubscribedAt)) {
          routes.push({ resource, disposition: "existing_active" });
          continue;
        }
        if (exactRows.some((row) => row.unsubscribedAt)) {
          routes.push({ resource, disposition: "unrouted_tombstone" });
          continue;
        }
        const missing = missingByResource.get(resource);
        if (missing) {
          unroutedMissingOwnerships.push(missing);
          routes.push({ resource, disposition: "unrouted_missing_audit" });
          continue;
        }
        if (configuredActor.actor_id === null) {
          routes.push({ resource, disposition: "no_actor" });
          continue;
        }
        this.insertMaterializedRoute(resource, configuredActor.actor_id, options.at);
        routeCount += 1;
        routes.push({ resource, disposition: "materialized" });
      }

      const snapshot: RouteMaterializationSnapshot = {
        version: ROUTE_MATERIALIZATION_VERSION,
        configuredActorImport: {
          source: CONFIGURED_ACTOR_IMPORT_SOURCE,
          rowCount: configuredActor.row_count,
          actorId: configuredActor.actor_id,
        },
        configuredRoots,
        routes,
      };
      const inputSnapshot = JSON.stringify(snapshot);
      // Validate what this release wrote before committing it, so future
      // changes cannot accidentally make a malformed row authoritative.
      parseRouteMaterializationSnapshot(inputSnapshot);
      this.db
        .prepare(
          `INSERT INTO event_source_route_materialization_receipts
             (version, completed_at, input_snapshot_json)
           VALUES (?, ?, ?)`
        )
        .run(ROUTE_MATERIALIZATION_VERSION, options.at, inputSnapshot);

      return { store: this, droppedDelegations, unroutedMissingOwnerships, routeCount };
    };

    // `transaction()` is deliberately wrapped in an IMMEDIATE transaction:
    // another connection cannot read the receipt's absence, alter ownership,
    // and then race this one into materializing a different snapshot.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertMaterializedRoute(resource: EventResource, actorId: string, at: string): void {
    this.db
      .prepare(
        `INSERT INTO event_source_owners
           (resource, actor_id, subscribed_by, subscribed_at, unsubscribed_at, config)
         VALUES (?, ?, ?, ?, NULL, NULL)`
      )
      .run(resourceKey(resource), actorId, actorId, at);
  }

  private dropUnanchoredDelegations(
    configuredRoots: readonly EventResource[],
    at: string
  ): EventSourceOwnership[] {
    const dropped: EventSourceOwnership[] = [];
    for (const ownership of this.list()) {
      if (
        !ownership.unsubscribedAt &&
        !configuredRoots.some((configuredRoot) =>
          isSubResourceOf(ownership.resource, configuredRoot)
        )
      ) {
        this.unsubscribe(ownership.resource, ownership.actorId, at);
        dropped.push({ ...ownership, unsubscribedAt: at });
      }
    }
    return dropped;
  }
}
