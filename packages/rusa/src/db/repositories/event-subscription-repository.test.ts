import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR_A,
  ACTOR_B,
  OTHER,
  REPO,
  ROOT,
  sub,
  testEventSubscriptionStoreContract,
} from "../../actor/event-subscription-store.contract.js";
import { reconcileEventSources } from "../../actor/event-subscriptions.js";
import { runMigrations } from "../migrations/runner.js";
import { widenToWal } from "../wal.js";
import { DbEventSubscriptionStore } from "./event-subscription-repository.js";

/**
 * Seeds the actors this suite subscribes — event_subscriptions.actor_id is
 * FK-owned. `actors` caps parentless rows to one (root topology), so the
 * first id seeds as root and every subsequent id is parented under it.
 */
function seedActors(db: Database.Database, ...ids: string[]): void {
  const insert = db.prepare(
    "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'test actor', ?, '2026-06-27T00:00:00Z')"
  );
  const [rootId, ...rest] = ids;
  if (rootId === undefined) return;
  insert.run(rootId, null);
  for (const id of rest) insert.run(id, rootId);
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  db.pragma("foreign_keys = ON");
  seedActors(db, ROOT, ACTOR_A, ACTOR_B);
  return db;
}

testEventSubscriptionStoreContract(
  "DbEventSubscriptionStore",
  () => new DbEventSubscriptionStore(makeDb())
);

describe("DbEventSubscriptionStore (DB-specific)", () => {
  let db: Database.Database;
  let store: DbEventSubscriptionStore;

  beforeEach(() => {
    db = makeDb();
    store = new DbEventSubscriptionStore(db);
  });

  it("refuses to subscribe an actor id with no actors row", () => {
    expect(() => store.subscribe(sub({ actorId: "no-such-actor" }))).toThrow();
  });

  it("cannot hold two rows for the same (resource, actor_id) even via a raw insert", () => {
    store.subscribe(sub());
    expect(() =>
      db
        .prepare(
          "INSERT INTO event_subscriptions (resource, actor_id, subscribed_by, subscribed_at) VALUES (?, ?, ?, ?)"
        )
        .run(REPO, ACTOR_A, ROOT, "2026-06-30T00:00:00Z")
    ).toThrow();
  });

  it("cannot hold two active owners of one resource even via a raw insert", () => {
    store.subscribe(sub({ actorId: ACTOR_A }));
    expect(() =>
      db
        .prepare(
          "INSERT INTO event_subscriptions (resource, actor_id, subscribed_by, subscribed_at) VALUES (?, ?, ?, ?)"
        )
        .run(REPO, ACTOR_B, ROOT, "2026-06-30T00:00:00Z")
    ).toThrow();
  });

  it("admits any number of tombstones for one resource", () => {
    store.subscribe(sub({ actorId: ACTOR_A }));
    store.unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
    store.subscribe(sub({ actorId: ACTOR_B, subscribedAt: "2026-06-29T00:00:00Z" }));
    store.unsubscribe(REPO, ACTOR_B, "2026-06-30T00:00:00Z");

    expect(store.list()).toHaveLength(2);
    expect(store.activeForResource(REPO)).toEqual([]);
  });

  it("restricts deleting an actor while its subscription history (active or tombstoned) exists", () => {
    store.subscribe(sub({ actorId: ACTOR_A }));
    expect(() => db.prepare("DELETE FROM actors WHERE id = ?").run(ACTOR_A)).toThrow();

    store.unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
    expect(() => db.prepare("DELETE FROM actors WHERE id = ?").run(ACTOR_A)).toThrow();
  });

  it("restore() hydrates a tombstone without reactivating it", () => {
    store.restore(sub({ actorId: ACTOR_A, unsubscribedAt: "2026-06-28T00:00:00Z" }));
    expect(store.activeForResource(REPO)).toEqual([]);
    expect(store.list()[0]?.unsubscribedAt).toBe("2026-06-28T00:00:00Z");
    // A tombstone never contends for ownership, so a live subscriber still fits.
    expect(() =>
      store.restore(sub({ actorId: ACTOR_B, subscribedAt: "2026-06-29T00:00:00Z" }))
    ).not.toThrow();
    expect(store.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_B]);
  });

  it("leaves no partial row behind when the conflict guard refuses", () => {
    store.subscribe(sub({ actorId: ACTOR_A }));
    expect(() => store.subscribe(sub({ actorId: ACTOR_B }))).toThrow();
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.actorId).toBe(ACTOR_A);
  });
});

describe("DbEventSubscriptionStore (file-backed database)", () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rusa-event-subscriptions-"));
    file = join(directory, "mesh.db");
    const seed = new Database(file);
    widenToWal(seed);
    runMigrations(seed);
    seed.pragma("foreign_keys = ON");
    seedActors(seed, ROOT, ACTOR_A, ACTOR_B);
    seed.close();
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function open(): Database.Database {
    const db = new Database(file);
    db.pragma("foreign_keys = ON");
    return db;
  }

  it("persists active rows and tombstones across a database reopen", () => {
    const first = open();
    const writer = new DbEventSubscriptionStore(first);
    writer.subscribe(sub({ resource: REPO, actorId: ACTOR_A }));
    writer.subscribe(sub({ resource: OTHER, actorId: ACTOR_B }));
    writer.unsubscribe(OTHER, ACTOR_B, "2026-06-28T00:00:00Z");
    first.close();

    const reopened = open();
    const reloaded = new DbEventSubscriptionStore(reopened);
    expect(reloaded.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_A]);
    expect(reloaded.activeForResource(OTHER)).toEqual([]);
    expect(reloaded.list()).toHaveLength(2);
    reopened.close();
  });

  it("a second connection observes a committed subscribe without reopening", () => {
    const service = open();
    const dashboard = open();
    const reader = new DbEventSubscriptionStore(dashboard);
    expect(reader.activeForResource(REPO)).toEqual([]);

    new DbEventSubscriptionStore(service).subscribe(sub({ actorId: ACTOR_A }));
    expect(reader.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_A]);

    new DbEventSubscriptionStore(service).unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
    expect(reader.activeForResource(REPO)).toEqual([]);

    service.close();
    dashboard.close();
  });

  it("observes a subscribe committed by a separate process", () => {
    const service = open();
    const reader = new DbEventSubscriptionStore(service);
    expect(reader.activeForResource(REPO)).toEqual([]);

    // A real second process, as the dashboard and CLI are: the reader holds no
    // process-local snapshot to go stale.
    execFileSync(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "-e",
        `import Database from "better-sqlite3";
         const db = new Database(process.argv[1]);
         db.prepare(
           "INSERT INTO event_subscriptions (resource, actor_id, subscribed_by, subscribed_at) VALUES (?, ?, ?, ?)"
         ).run(process.argv[2], process.argv[3], process.argv[3], "2026-06-27T00:00:00Z");
         db.close();`,
        file,
        REPO,
        ACTOR_A,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );

    expect(reader.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_A]);
    service.close();
  });

  it("keeps a tombstone outranking the config-implied seed across a restart", () => {
    const configured = [REPO];

    // Boot one: the config seeds the root as implied owner, then the root
    // explicitly unsubscribes — which must leave a durable tombstone.
    const first = open();
    const firstBoot = reconcileEventSources(
      new DbEventSubscriptionStore(first),
      configured,
      ROOT,
      () => "2026-06-27T00:00:00Z"
    );
    expect(firstBoot.store.activeForResource(REPO).map((row) => row.actorId)).toEqual([ROOT]);
    firstBoot.store.unsubscribe(REPO, ROOT, "2026-06-28T00:00:00Z");
    expect(firstBoot.store.activeForResource(REPO)).toEqual([]);
    first.close();

    // Boot two: the implied seed is rebuilt from config, but the durable
    // tombstone still suppresses it.
    const second = open();
    const secondBoot = reconcileEventSources(
      new DbEventSubscriptionStore(second),
      configured,
      ROOT,
      () => "2026-06-29T00:00:00Z"
    );
    expect(secondBoot.store.activeForResource(REPO)).toEqual([]);
    expect(secondBoot.store.list()).toEqual([
      expect.objectContaining({ actorId: ROOT, unsubscribedAt: "2026-06-28T00:00:00Z" }),
    ]);
    second.close();
  });

  it("keeps an explicit delegation over the implied seed, and drops it once unanchored", () => {
    const first = open();
    const firstBoot = reconcileEventSources(
      new DbEventSubscriptionStore(first),
      [REPO],
      ROOT,
      () => "2026-06-27T00:00:00Z"
    );
    firstBoot.store.unsubscribe(REPO, ROOT, "2026-06-28T00:00:00Z");
    firstBoot.store.subscribe(sub({ actorId: ACTOR_A, subscribedAt: "2026-06-28T00:00:01Z" }));
    expect(firstBoot.store.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_A]);
    first.close();

    // Restart with the delegation still anchored in config: it survives.
    const second = open();
    const secondBoot = reconcileEventSources(
      new DbEventSubscriptionStore(second),
      [REPO],
      ROOT,
      () => "2026-06-29T00:00:00Z"
    );
    expect(secondBoot.store.activeForResource(REPO).map((row) => row.actorId)).toEqual([ACTOR_A]);
    second.close();

    // Restart after the operator removed the source from config: dropped.
    const third = open();
    const thirdBoot = reconcileEventSources(
      new DbEventSubscriptionStore(third),
      [OTHER],
      ROOT,
      () => "2026-06-30T00:00:00Z"
    );
    expect(thirdBoot.droppedDelegations.map((row) => row.actorId)).toEqual([ACTOR_A]);
    expect(thirdBoot.store.activeForResource(REPO)).toEqual([]);
    expect(new DbEventSubscriptionStore(third).list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: ACTOR_A, unsubscribedAt: "2026-06-30T00:00:00Z" }),
      ])
    );
    third.close();
  });
});

/**
 * `event_subscriptions.actor_id` is FK-owned, which the JSON store had no
 * equivalent of. On a fresh install `resolveRootActorId` mints a root id
 * whose `actors` row only lands later, when `mesh.adopt` upserts it — after
 * the boot wiring that reconciles event sources. These lock the property that
 * makes that ordering safe: reconciliation's only durable write is an UPDATE
 * of an existing row, so nothing is ever INSERTed against an id the `actors`
 * table has not seen yet.
 */
describe("DbEventSubscriptionStore (boot before root adoption)", () => {
  it("seeds the config-implied subscriptions for a root that has no actors row yet", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    const store = new DbEventSubscriptionStore(db);
    const unadoptedRoot = "root-not-yet-adopted";

    const boot = reconcileEventSources(store, [REPO], unadoptedRoot, () => "2026-06-27T00:00:00Z");

    // The implied seed lives in the in-memory half of the union, so the
    // durable half stays empty and the foreign key is never exercised.
    expect(boot.store.activeForResource(REPO).map((row) => row.actorId)).toEqual([unadoptedRoot]);
    expect(boot.droppedDelegations).toEqual([]);
    expect(store.list()).toEqual([]);
    db.close();
  });

  it("tombstones an unanchored delegation without inserting a row for the unadopted root", () => {
    const db = makeDb();
    const store = new DbEventSubscriptionStore(db);
    store.subscribe(sub({ actorId: ACTOR_A }));
    const unadoptedRoot = "root-not-yet-adopted";

    const boot = reconcileEventSources(store, [OTHER], unadoptedRoot, () => "2026-06-30T00:00:00Z");

    expect(boot.droppedDelegations.map((row) => row.actorId)).toEqual([ACTOR_A]);
    expect(store.list()).toEqual([
      expect.objectContaining({ actorId: ACTOR_A, unsubscribedAt: "2026-06-30T00:00:00Z" }),
    ]);
    db.close();
  });
});
