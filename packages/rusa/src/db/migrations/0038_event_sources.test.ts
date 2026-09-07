import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { eventSources } from "./0038_event_sources.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE actors (
      id        TEXT PRIMARY KEY,
      charter   TEXT NOT NULL
    );
    INSERT INTO actors (id, charter) VALUES ('actor-a', 'a');
    INSERT INTO actors (id, charter) VALUES ('actor-b', 'b');
  `);
  return db;
}

const own = (
  db: Database.Database,
  actorId: string,
  released: string | null = null,
  resource = "github:dummy-org/dummy-repo"
): void => {
  db.prepare(
    `INSERT INTO event_source_owners (resource, actor_id, subscribed_by, subscribed_at, unsubscribed_at)
     VALUES (?, ?, 'root', '2026-06-27T00:00:00Z', ?)`
  ).run(resource, actorId, released);
};

const watch = (
  db: Database.Database,
  actorId: string,
  resource = "github:dummy-org/dummy-repo"
): void => {
  db.prepare(
    `INSERT INTO event_source_subscriptions (resource, actor_id, subscribed_by, subscribed_at)
     VALUES (?, ?, ?, '2026-06-27T00:00:00Z')`
  ).run(resource, actorId, actorId);
};

/**
 * The schema half of the cutover. Behavior through the repositories is covered
 * in `event-source-owner-repository.test.ts` and
 * `event-source-subscription-repository.test.ts`; what is pinned here is what
 * the database itself guarantees when application code is bypassed, because
 * that is the part a reviewer is being asked to approve.
 */
describe("0038_event_sources", () => {
  it("creates both tables on a fresh database", () => {
    const db = seedDb();
    eventSources.up(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table'
           AND name IN ('event_source_owners', 'event_source_subscriptions', 'legacy_import_receipts')
         ORDER BY name`
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual([
      "event_source_owners",
      "event_source_subscriptions",
      "legacy_import_receipts",
    ]);
  });

  describe("event_source_owners", () => {
    it("admits at most one ACTIVE owner per resource", () => {
      const db = seedDb();
      eventSources.up(db);

      own(db, "actor-a");
      expect(() => own(db, "actor-b")).toThrow();

      // Releasing the claim frees the resource for the next owner.
      db.prepare(
        "UPDATE event_source_owners SET unsubscribed_at = '2026-06-28T00:00:00Z' WHERE actor_id = 'actor-a'"
      ).run();
      expect(() => own(db, "actor-b")).not.toThrow();
    });

    it("admits any number of tombstones for one resource", () => {
      const db = seedDb();
      eventSources.up(db);
      own(db, "actor-a", "2026-06-28T00:00:00Z");
      expect(() => own(db, "actor-b", "2026-06-29T00:00:00Z")).not.toThrow();
    });

    it("keys one row per (resource, actor)", () => {
      const db = seedDb();
      eventSources.up(db);
      own(db, "actor-a", "2026-06-28T00:00:00Z");
      expect(() => own(db, "actor-a", "2026-06-29T00:00:00Z")).toThrow();
    });

    // RESTRICT, because a tombstone is the durable record of who held a source
    // and losing it would erase ownership history. Verified against the
    // repository layer as it stands: `ActorRepository` exposes no delete —
    // retirement sets `retired_at` — so no production path is blocked by this.
    it("RESTRICTs deleting an actor that has ownership history", () => {
      const db = seedDb();
      eventSources.up(db);
      own(db, "actor-a", "2026-06-28T00:00:00Z");
      expect(() => db.prepare("DELETE FROM actors WHERE id = 'actor-a'").run()).toThrow();
    });
  });

  describe("event_source_subscriptions", () => {
    it("admits many actors on one resource", () => {
      const db = seedDb();
      eventSources.up(db);
      watch(db, "actor-a");
      expect(() => watch(db, "actor-b")).not.toThrow();
    });

    it("keys one row per (resource, actor)", () => {
      const db = seedDb();
      eventSources.up(db);
      watch(db, "actor-a");
      expect(() => watch(db, "actor-a")).toThrow();
    });

    // CASCADE, not RESTRICT: a subscription is live routing config with no
    // audit role, so following its actor out is the honest answer rather than
    // a question deferred to whoever first tries to delete an actor.
    it("CASCADEs away with its actor", () => {
      const db = seedDb();
      eventSources.up(db);
      watch(db, "actor-a");
      watch(db, "actor-b");
      db.prepare("DELETE FROM actors WHERE id = 'actor-a'").run();
      expect(db.prepare("SELECT actor_id FROM event_source_subscriptions").all()).toEqual([
        { actor_id: "actor-b" },
      ]);
    });

    it("requires a real actor", () => {
      const db = seedDb();
      eventSources.up(db);
      expect(() => watch(db, "no-such-actor")).toThrow();
    });
  });
});
