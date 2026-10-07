import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { dropActorExperiments } from "./0060_drop_actor_experiments.js";
import { runMigrations } from "./runner.js";

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

describe("0060_drop_actor_experiments", () => {
  it("drops actor_experiments table and deletes experiment-admin capability grants", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE actors (
        id TEXT PRIMARY KEY,
        charter TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE actor_experiments (
        actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        experiment TEXT NOT NULL,
        enrolled_by TEXT NOT NULL,
        enrolled_at TEXT NOT NULL,
        PRIMARY KEY (actor_id, experiment)
      );
      CREATE TABLE capability_grants (
        actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        capability TEXT NOT NULL,
        granted_by TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (actor_id, capability)
      );

      INSERT INTO actors (id, charter, status) VALUES ('actor-1', 'test actor', 'active');
      INSERT INTO actor_experiments (actor_id, experiment, enrolled_by, enrolled_at)
      VALUES ('actor-1', 'fixture_rollout', 'root', '2026-10-06T00:00:00.000Z');

      INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at)
      VALUES ('actor-1', 'experiment-admin', 'system:bootstrap', '2026-10-06T00:00:00.000Z');
      INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at)
      VALUES ('actor-1', 'model-admin', 'system:bootstrap', '2026-10-06T00:00:00.000Z');
    `);

    expect(tableExists(db, "actor_experiments")).toBe(true);
    expect(
      db.prepare("SELECT capability FROM capability_grants WHERE actor_id = 'actor-1'").all()
    ).toEqual([{ capability: "experiment-admin" }, { capability: "model-admin" }]);

    dropActorExperiments.up(db);

    expect(tableExists(db, "actor_experiments")).toBe(false);
    expect(
      db.prepare("SELECT capability FROM capability_grants WHERE actor_id = 'actor-1'").all()
    ).toEqual([{ capability: "model-admin" }]);
  });

  it("is safe when actor_experiments does not exist", () => {
    const db = new Database(":memory:");
    expect(tableExists(db, "actor_experiments")).toBe(false);
    expect(() => dropActorExperiments.up(db)).not.toThrow();
    expect(tableExists(db, "actor_experiments")).toBe(false);
  });

  it("runs cleanly in the full migration chain", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const applied = (db.prepare("SELECT id FROM _migrations").all() as Array<{ id: string }>).map(
      (m) => m.id
    );
    expect(applied).toContain("0060_drop_actor_experiments");
    expect(tableExists(db, "actor_experiments")).toBe(false);
  });
});
