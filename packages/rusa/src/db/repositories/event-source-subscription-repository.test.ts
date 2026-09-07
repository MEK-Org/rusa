import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  directSub,
  SUB_ACTOR_A,
  SUB_ACTOR_B,
  SUB_OTHER,
  SUB_REPO,
  SUB_ROOT,
  testEventSourceSubscriptionStoreContract,
} from "../../actor/event-source-subscription-store.contract.js";
import { reconcileEventSourceSubscriptions } from "../../actor/event-subscriptions.js";
import { runMigrations } from "../migrations/runner.js";
import { widenToWal } from "../wal.js";
import { DbEventSourceSubscriptionStore } from "./event-source-subscription-repository.js";

/**
 * Seeds the actors this suite subscribes — event_source_subscriptions.actor_id
 * is FK-owned. `actors` caps parentless rows to one (root topology), so the
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
  seedActors(db, SUB_ROOT, SUB_ACTOR_A, SUB_ACTOR_B);
  return db;
}

testEventSourceSubscriptionStoreContract(
  "DbEventSourceSubscriptionStore",
  () => new DbEventSourceSubscriptionStore(makeDb())
);

describe("DbEventSourceSubscriptionStore (DB-specific)", () => {
  let db: Database.Database;
  let store: DbEventSourceSubscriptionStore;

  beforeEach(() => {
    db = makeDb();
    store = new DbEventSourceSubscriptionStore(db);
  });

  afterEach(() => db.close());

  it("refuses to subscribe an actor id with no actors row", () => {
    expect(() => store.subscribe(directSub({ actorId: "no-such-actor" }))).toThrow();
  });

  it("cannot hold two rows for the same (resource, actor_id) even via a raw insert", () => {
    store.subscribe(directSub());
    expect(() =>
      db
        .prepare(
          "INSERT INTO event_source_subscriptions (resource, actor_id, subscribed_by, subscribed_at) VALUES (?, ?, ?, ?)"
        )
        .run(SUB_REPO, SUB_ACTOR_A, SUB_ROOT, "2026-06-28T00:00:00Z")
    ).toThrow();
  });

  it("admits several actors on one resource via a raw insert — no one-active index here", () => {
    store.subscribe(directSub({ actorId: SUB_ACTOR_A }));
    expect(() =>
      db
        .prepare(
          "INSERT INTO event_source_subscriptions (resource, actor_id, subscribed_by, subscribed_at) VALUES (?, ?, ?, ?)"
        )
        .run(SUB_REPO, SUB_ACTOR_B, SUB_ACTOR_B, "2026-06-28T00:00:00Z")
    ).not.toThrow();
    expect(store.subscribersOf(SUB_REPO)).toHaveLength(2);
  });

  // The asymmetry with event_source_owners is deliberate and this is where it
  // is pinned: an owner row is a durable audit record of who held a source, so
  // deleting its actor is RESTRICTed; a subscription row is live routing
  // config with no audit role, so it follows its actor out.
  it("cascades away with its actor, unlike an ownership row", () => {
    store.subscribe(directSub({ actorId: SUB_ACTOR_A }));
    store.subscribe(directSub({ actorId: SUB_ACTOR_B }));
    db.prepare("DELETE FROM actors WHERE id = ?").run(SUB_ACTOR_A);
    expect(store.list().map((s) => s.actorId)).toEqual([SUB_ACTOR_B]);
  });
});

describe("DbEventSourceSubscriptionStore (file-backed database)", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "event-source-subscriptions-"));
    dbPath = join(dir, "mesh.db");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function open(): Database.Database {
    const db = new Database(dbPath);
    widenToWal(db);
    db.pragma("foreign_keys = ON");
    return db;
  }

  it("persists subscriptions across a database reopen", () => {
    const first = open();
    runMigrations(first);
    seedActors(first, SUB_ROOT, SUB_ACTOR_A, SUB_ACTOR_B);
    const store = new DbEventSourceSubscriptionStore(first);
    store.subscribe(directSub({ actorId: SUB_ACTOR_A }));
    store.subscribe(directSub({ actorId: SUB_ACTOR_B }));
    store.unsubscribe(SUB_REPO, SUB_ACTOR_A);
    first.close();

    const second = open();
    const reopened = new DbEventSourceSubscriptionStore(second);
    expect(reopened.subscribersOf(SUB_REPO).map((s) => s.actorId)).toEqual([SUB_ACTOR_B]);
    second.close();
  });

  it("a second connection observes a committed subscribe without reopening", () => {
    const writer = open();
    runMigrations(writer);
    seedActors(writer, SUB_ROOT, SUB_ACTOR_A);
    const reader = open();
    const readerStore = new DbEventSourceSubscriptionStore(reader);
    expect(readerStore.subscribersOf(SUB_REPO)).toEqual([]);

    new DbEventSourceSubscriptionStore(writer).subscribe(directSub());

    // No cache to invalidate: the reader's next call is a fresh SELECT.
    expect(readerStore.subscribersOf(SUB_REPO).map((s) => s.actorId)).toEqual([SUB_ACTOR_A]);
    reader.close();
    writer.close();
  });

  it("observes a subscribe committed by a separate process", () => {
    const setup = open();
    runMigrations(setup);
    seedActors(setup, SUB_ROOT, SUB_ACTOR_A);
    setup.close();

    const reader = open();
    const readerStore = new DbEventSourceSubscriptionStore(reader);
    expect(readerStore.list()).toEqual([]);

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
           "INSERT INTO event_source_subscriptions (resource, actor_id, subscribed_by, subscribed_at) VALUES (?, ?, ?, ?)"
         ).run(process.argv[2], process.argv[3], process.argv[3], "2026-06-29T00:00:00Z");
         db.close();`,
        dbPath,
        SUB_REPO,
        SUB_ACTOR_A,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );

    expect(readerStore.subscribersOf(SUB_REPO).map((s) => s.actorId)).toEqual([SUB_ACTOR_A]);
    reader.close();
  });

  it("drops durably subscribed rows the config no longer covers, across a restart", () => {
    const first = open();
    runMigrations(first);
    seedActors(first, SUB_ROOT, SUB_ACTOR_A, SUB_ACTOR_B);
    const store = new DbEventSourceSubscriptionStore(first);
    store.subscribe(directSub({ resource: SUB_REPO, actorId: SUB_ACTOR_A }));
    store.subscribe(directSub({ resource: SUB_OTHER, actorId: SUB_ACTOR_B }));
    first.close();

    // The operator narrows config.yaml to just SUB_REPO between runs.
    const second = open();
    const rebooted = new DbEventSourceSubscriptionStore(second);
    const dropped = reconcileEventSourceSubscriptions(rebooted, [SUB_REPO]);
    expect(dropped.map((s) => s.resource)).toEqual([SUB_OTHER]);
    expect(rebooted.list().map((s) => s.resource)).toEqual([SUB_REPO]);
    second.close();

    // And the drop is durable, not just an in-memory view of this boot.
    const third = open();
    expect(new DbEventSourceSubscriptionStore(third).list().map((s) => s.resource)).toEqual([
      SUB_REPO,
    ]);
    third.close();
  });
});
