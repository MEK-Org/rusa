import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Repositories } from "../repositories/index.js";
import { runMigrations } from "./runner.js";

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return row !== undefined;
}

describe("0060_drop_actor_experiments", () => {
  it("upgrades the populated 0059 schema, revokes live grants, and preserves history", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, { throughId: "0059_obligation_completion_matchers" });
    const repositories = new Repositories(db);
    db.exec(`
      INSERT INTO actors (id, charter, parent_id, created_at)
      VALUES
        ('root', 'test root', NULL, '2026-10-06T00:00:00.000Z'),
        ('actor-1', 'test actor', 'root', '2026-10-06T00:00:00.000Z'),
        ('actor-2', 'test actor', 'root', '2026-10-06T00:00:00.000Z');
      INSERT INTO actor_experiments (actor_id, experiment, enrolled_by, enrolled_at)
      VALUES ('actor-1', 'fixture_rollout', 'root', '2026-10-06T00:00:00.000Z');

      INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at, revoked_at)
      VALUES ('actor-1', 'experiment-admin', 'system:bootstrap', '2026-10-06T00:00:00.000Z', NULL);
      INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at, revoked_at)
      VALUES ('actor-2', 'experiment-admin', 'system:bootstrap', '2026-10-06T00:00:00.000Z', '2026-10-06T01:00:00.000Z');
      INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at, revoked_at)
      VALUES ('actor-1', 'model-admin', 'system:bootstrap', '2026-10-06T00:00:00.000Z', NULL);
    `);
    repositories.meshEvents.record({
      kind: "experiment_enrolled",
      actorId: "actor-1",
      detail: "fixture_rollout",
    });
    repositories.meshEvents.record({
      kind: "experiment_unenrolled",
      actorId: "actor-1",
      detail: "fixture_rollout",
    });

    expect(tableExists(db, "actor_experiments")).toBe(true);
    runMigrations(db);

    expect(tableExists(db, "actor_experiments")).toBe(false);
    expect(repositories.capabilityGrants.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorId: "actor-1",
          capability: "experiment-admin",
          revokedAt: expect.any(String),
        }),
        expect.objectContaining({
          actorId: "actor-2",
          capability: "experiment-admin",
          revokedAt: "2026-10-06T01:00:00.000Z",
        }),
        expect.objectContaining({
          actorId: "actor-1",
          capability: "model-admin",
        }),
      ])
    );
    expect(repositories.capabilityGrants.activeFor("actor-1")).toEqual(["model-admin"]);
    expect(
      repositories.meshEvents
        .listByKinds(["experiment_enrolled", "experiment_unenrolled"], { bodyKinds: [] })
        .map((event) => event.kind)
    ).toEqual(["experiment_enrolled", "experiment_unenrolled"]);
    expect(
      db.prepare("SELECT id FROM _migrations WHERE id = '0060_drop_actor_experiments'").get()
    ).toBeDefined();
  });
});
