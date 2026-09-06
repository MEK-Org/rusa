import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  grant,
  IU,
  OTHER,
  ROOT,
  testCapabilityGrantStoreContract,
} from "../../actor/capability-grant-store.contract.js";
import { migrations } from "../migrations/index.js";
import { runMigrations } from "../migrations/runner.js";
import { DbCapabilityGrantStore } from "./capability-grant-repository.js";

/**
 * Seeds the actors this suite grants to/from — capability_grants.actor_id is
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
  seedActors(db, ROOT, IU, OTHER);
  return db;
}

testCapabilityGrantStoreContract(
  "DbCapabilityGrantStore",
  () => new DbCapabilityGrantStore(makeDb())
);

describe("DbCapabilityGrantStore (DB-specific)", () => {
  let db: Database.Database;
  let store: DbCapabilityGrantStore;

  beforeEach(() => {
    db = makeDb();
    store = new DbCapabilityGrantStore(db);
  });

  it("refuses to grant to an actor id with no actors row", () => {
    expect(() => store.grant(grant({ actorId: "no-such-actor" }))).toThrow();
  });

  it("cannot hold two rows for the same (actor_id, capability) even via a raw insert", () => {
    store.grant(grant());
    expect(() =>
      db
        .prepare(
          "INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at) VALUES (?, ?, ?, ?)"
        )
        .run(IU, "understanding-write", ROOT, "2026-06-30T00:00:00Z")
    ).toThrow();
  });

  it("restricts deleting an actor while its grant history (active or revoked) exists", () => {
    store.grant(grant());
    expect(() => db.prepare("DELETE FROM actors WHERE id = ?").run(IU)).toThrow();

    store.revoke(IU, "understanding-write", "2026-06-28T00:00:00Z");
    expect(() => db.prepare("DELETE FROM actors WHERE id = ?").run(IU)).toThrow();
  });

  it("persists normalized grants across a file-backed database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "rusa-capability-grants-"));
    const file = join(directory, "mesh.db");
    try {
      const first = new Database(file);
      runMigrations(first);
      first.pragma("foreign_keys = ON");
      seedActors(first, ROOT, IU);
      new DbCapabilityGrantStore(first).grant(grant());
      first.close();

      const reopened = new Database(file);
      reopened.pragma("foreign_keys = ON");
      expect(new DbCapabilityGrantStore(reopened).activeFor(IU)).toEqual(["understanding-write"]);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("makes a committed write visible to a second, already-open connection on the same file", () => {
    const directory = mkdtempSync(join(tmpdir(), "rusa-capability-grants-xconn-"));
    const file = join(directory, "mesh.db");
    try {
      const writerConn = new Database(file);
      runMigrations(writerConn);
      writerConn.pragma("foreign_keys = ON");
      seedActors(writerConn, ROOT, IU);
      const writer = new DbCapabilityGrantStore(writerConn);

      // Opened before the grant below is written — no re-read/re-construction,
      // proving the read isn't served from an instance-local cache.
      const readerConn = new Database(file);
      readerConn.pragma("foreign_keys = ON");
      const reader = new DbCapabilityGrantStore(readerConn);
      expect(reader.activeFor(IU)).toEqual([]);

      writer.grant(grant());
      expect(reader.activeFor(IU)).toEqual(["understanding-write"]);

      writer.revoke(IU, "understanding-write", "2026-06-28T00:00:00Z");
      expect(reader.activeFor(IU)).toEqual([]);
      expect(reader.list()[0]?.revokedAt).toBe("2026-06-28T00:00:00Z");

      writerConn.close();
      readerConn.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies 0036_capability_grants cleanly on top of an already-migrated 0001-0035 chain", () => {
    const directory = mkdtempSync(join(tmpdir(), "rusa-capability-grants-upgrade-"));
    const file = join(directory, "mesh.db");
    try {
      // Bring a fresh database to the pre-existing chain only, exactly as a
      // staging deploy predating this migration would already be.
      const upgrading = new Database(file);
      upgrading.pragma("foreign_keys = ON");
      const boundary = migrations.findIndex((m) => m.id === "0036_capability_grants");
      expect(boundary).toBeGreaterThan(-1);
      const priorMigrations = migrations.slice(0, boundary);
      upgrading.exec(
        "CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
      );
      for (const migration of priorMigrations) {
        if (migration.noTransaction) {
          migration.up(upgrading);
        } else {
          upgrading.transaction(() => migration.up(upgrading))();
        }
        upgrading.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
      }
      // Actors predate this migration (0034 already applied above), so a row
      // seeded on the pre-0036 chain must still be there once the store exists.
      seedActors(upgrading, ROOT, IU);

      // Now bring the same database the rest of the way forward: only
      // 0036_capability_grants should apply, and it must create a usable table
      // without disturbing the actors seeded on the pre-existing chain.
      runMigrations(upgrading);
      const applied = upgrading
        .prepare("SELECT id FROM _migrations WHERE id = '0036_capability_grants'")
        .get();
      expect(applied).toBeDefined();

      const store = new DbCapabilityGrantStore(upgrading);
      store.grant(grant({ capability: "post-upgrade" }));
      expect(store.activeFor(IU)).toEqual(["post-upgrade"]);
      upgrading.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
