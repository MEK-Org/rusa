import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ActorRecord } from "../../actor/actor-record.js";
import { SqliteActorRepository } from "../repositories/sqlite-actor-repository.js";
import { principals } from "./0039_principals.js";
import { runMigrations } from "./runner.js";

const ROOT_CREATED_AT = "2026-09-03T13:00:00.000Z";
const WORKER_CREATED_AT = "2026-09-03T13:01:00.000Z";

type PrincipalRow = { id: string; kind: string; actor_id: string | null; created_at: string };

/**
 * A database migrated to the head *before* this migration, so the backfill can
 * be exercised against actors it did not create. Recording the id up front is
 * how the shared runner is told to stop short of it, rather than replaying the
 * chain by hand and diverging from what a real upgrade does.
 */
function databaseWithoutPrincipals(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    `CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));`
  );
  db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(principals.id);
  runMigrations(db);
  db.pragma("foreign_keys = ON");
  return db;
}

function seedActors(db: Database.Database): void {
  const insert = db.prepare(
    "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'test actor', ?, ?)"
  );
  insert.run("root", null, ROOT_CREATED_AT);
  insert.run("worker", "root", WORKER_CREATED_AT);
}

function migratedWithActors(): Database.Database {
  const db = databaseWithoutPrincipals();
  seedActors(db);
  principals.up(db);
  return db;
}

function principalRows(db: Database.Database): PrincipalRow[] {
  return db.prepare("SELECT * FROM principals ORDER BY id").all() as PrincipalRow[];
}

function insertUser(
  db: Database.Database,
  principalId: string,
  overrides: Partial<{
    email: string;
    issuer: string | null;
    subject: string | null;
    rootActorId: string | null;
  }> = {}
): void {
  db.prepare(
    `INSERT INTO principals (id, kind, actor_id, created_at)
     VALUES (?, 'user', NULL, '2026-09-05T00:00:00.000Z')`
  ).run(principalId);
  db.prepare(
    `INSERT INTO users (
       principal_id, email, firebase_issuer, firebase_subject, root_actor_id, created_at
     ) VALUES (?, ?, ?, ?, ?, '2026-09-05T00:00:00.000Z')`
  ).run(
    principalId,
    overrides.email ?? `${principalId}@example.com`,
    overrides.issuer ?? null,
    overrides.subject ?? null,
    overrides.rootActorId ?? null
  );
}

describe("0039_principals (schema, application bypassed)", () => {
  it("creates the principal supertype and the user subtype", () => {
    const db = migratedWithActors();

    const columns = (
      db.prepare("PRAGMA table_info(users)").all() as Array<{ name: string; type: string }>
    ).map((column) => column.name);
    expect(columns).toEqual([
      "principal_id",
      "email",
      "firebase_issuer",
      "firebase_subject",
      "root_actor_id",
      "disabled_at",
      "last_authenticated_at",
      "created_at",
    ]);

    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'principals'").get() as { sql: string }
    ).sql;
    expect(sql).not.toContain("json_valid");
    expect(sql).not.toContain("json_extract");

    db.close();
  });

  it("seeds one principal per existing actor, carrying that actor's creation time", () => {
    const db = migratedWithActors();

    expect(principalRows(db)).toEqual([
      { id: "root", kind: "actor", actor_id: "root", created_at: ROOT_CREATED_AT },
      { id: "system:mesh", kind: "system", actor_id: null, created_at: expect.any(String) },
      { id: "worker", kind: "actor", actor_id: "worker", created_at: WORKER_CREATED_AT },
    ]);

    db.close();
  });

  it("converges a populated upgrade with a fresh install of the same actors", () => {
    const upgraded = migratedWithActors();

    const fresh = new Database(":memory:");
    runMigrations(fresh);
    fresh.pragma("foreign_keys = ON");
    const repository = new SqliteActorRepository(fresh);
    const root: ActorRecord = {
      id: "root",
      charter: "test actor",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: ROOT_CREATED_AT,
    };
    const worker: ActorRecord = {
      id: "worker",
      charter: "test actor",
      parentId: "root",
      status: "active",
      createdAt: WORKER_CREATED_AT,
    };
    repository.upsert(root);
    repository.upsert(worker);

    // created_at is compared for the actor principals, where both paths must
    // reproduce the actor's own timestamp. The system principal is recorded when
    // the instance first migrates, so only its identity is expected to converge.
    expect(principalRows(fresh)).toEqual(
      principalRows(upgraded).map((row) =>
        row.kind === "system" ? { ...row, created_at: expect.any(String) } : row
      )
    );

    fresh.close();
    upgraded.close();
  });

  it("refuses an actor principal that names no actor, or that renames one", () => {
    const db = migratedWithActors();
    const insert = db.prepare(
      "INSERT INTO principals (id, kind, actor_id, created_at) VALUES (?, ?, ?, '2026-09-05T00:00:00.000Z')"
    );

    expect(() => insert.run("ghost", "actor", "ghost")).toThrow();
    expect(() => insert.run("worker-alias", "actor", "worker")).toThrow();
    expect(() => insert.run("worker", "actor", null)).toThrow();
    expect(() => insert.run("impostor", "user", "worker")).toThrow();
    expect(() => insert.run("nonsense", "robot", null)).toThrow();

    db.close();
  });

  it("restricts deleting an actor that carries an identity or holds a user's root", () => {
    const db = migratedWithActors();
    expect(() => db.prepare("DELETE FROM actors WHERE id = ?").run("worker")).toThrow();

    db.prepare("DELETE FROM principals WHERE id = ?").run("worker");
    insertUser(db, "owner", { rootActorId: "worker" });
    expect(() => db.prepare("DELETE FROM actors WHERE id = ?").run("worker")).toThrow();

    db.close();
  });

  it("admits many unbound users while refusing a duplicate bound identity", () => {
    const db = migratedWithActors();

    insertUser(db, "pending-one");
    insertUser(db, "pending-two");
    insertUser(db, "bound", { issuer: "https://issuer", subject: "sub-1" });
    expect(() =>
      insertUser(db, "duplicate", { issuer: "https://issuer", subject: "sub-1" })
    ).toThrow();

    expect(() => insertUser(db, "half-bound", { issuer: "https://issuer" })).toThrow();
    expect(() => insertUser(db, "other-half", { subject: "sub-2" })).toThrow();

    db.close();
  });

  it("refuses a second user on one root, a duplicate email, and an unnormalized one", () => {
    const db = migratedWithActors();

    insertUser(db, "first", { rootActorId: "root" });
    expect(() => insertUser(db, "second", { rootActorId: "root" })).toThrow();
    expect(() => insertUser(db, "third", { email: "first@example.com" })).toThrow();
    expect(() => insertUser(db, "fourth", { email: "Mixed@Example.com" })).toThrow();
    expect(() => insertUser(db, "fifth", { email: "" })).toThrow();

    db.close();
  });

  it("refuses a user row whose principal does not exist, and keeps it from vanishing", () => {
    const db = migratedWithActors();

    expect(() =>
      db
        .prepare(
          `INSERT INTO users (principal_id, email, created_at)
           VALUES ('unknown', 'nobody@example.com', '2026-09-05T00:00:00.000Z')`
        )
        .run()
    ).toThrow();

    insertUser(db, "owner");
    expect(() => db.prepare("DELETE FROM principals WHERE id = 'owner'").run()).toThrow();

    db.close();
  });
});
