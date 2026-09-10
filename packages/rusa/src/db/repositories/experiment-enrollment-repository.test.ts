import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EXPERIMENT,
  enrollment,
  OTHER,
  ROOT,
  testExperimentEnrollmentStoreContract,
  WORKER,
} from "../../actor/experiment-enrollment-store.contract.js";
import { migrations } from "../migrations/index.js";
import { runMigrations } from "../migrations/runner.js";
import { DbExperimentEnrollmentStore } from "./experiment-enrollment-repository.js";

/**
 * Seeds the actors this suite enrolls — `actor_experiments.actor_id` is
 * FK-owned. `actors` caps parentless rows to one (root topology), so the first
 * id seeds as root and every subsequent id is parented under it.
 */
function seedActors(db: Database.Database, ...ids: string[]): void {
  const insert = db.prepare(
    "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'test actor', ?, '2026-09-10T00:00:00Z')"
  );
  const [rootId, ...rest] = ids;
  if (rootId === undefined) return;
  insert.run(rootId, null);
  for (const id of rest) insert.run(id, rootId);
}

function makeDb(file = ":memory:"): Database.Database {
  const db = new Database(file);
  runMigrations(db);
  db.pragma("foreign_keys = ON");
  seedActors(db, ROOT, WORKER, OTHER);
  return db;
}

testExperimentEnrollmentStoreContract(
  "DbExperimentEnrollmentStore",
  () => new DbExperimentEnrollmentStore(makeDb())
);

describe("DbExperimentEnrollmentStore (DB-specific)", () => {
  let db: Database.Database;
  let store: DbExperimentEnrollmentStore;

  beforeEach(() => {
    db = makeDb();
    store = new DbExperimentEnrollmentStore(db);
  });

  it("registers its migration exactly once, at the documented id", () => {
    const ids = migrations.map((migration) => migration.id);
    expect(ids.filter((id) => id === "0047_actor_experiments")).toHaveLength(1);
    expect(ids.indexOf("0047_actor_experiments")).toBe(ids.length - 1);
  });

  it("refuses to enroll an actor id with no actors row", () => {
    expect(() => store.enroll(enrollment({ actorId: "no-such-actor" }))).toThrow();
  });

  it("cannot hold two rows for the same (actor_id, experiment) even via a raw insert", () => {
    store.enroll(enrollment());
    expect(() =>
      db
        .prepare(
          "INSERT INTO actor_experiments (actor_id, experiment, enrolled_by, enrolled_at) VALUES (?, ?, ?, ?)"
        )
        .run(WORKER, EXPERIMENT, ROOT, "2026-09-11T00:00:00Z")
    ).toThrow();
  });

  it("restricts deleting an actor while it still holds an enrollment", () => {
    store.enroll(enrollment());
    expect(() => db.prepare("DELETE FROM actors WHERE id = ?").run(WORKER)).toThrow();
    // Unenrolling releases the actor row again — the enrollment leaves no
    // tombstone to keep it pinned.
    store.unenroll(WORKER, EXPERIMENT);
    expect(() => db.prepare("DELETE FROM actors WHERE id = ?").run(WORKER)).not.toThrow();
  });

  it("keeps an enrollment effective and an unenrollment absent across a restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "rusa-actor-experiments-"));
    const file = join(directory, "mesh.db");
    try {
      const before = makeDb(file);
      const beforeStore = new DbExperimentEnrollmentStore(before);
      beforeStore.enroll(enrollment({ actorId: WORKER }));
      beforeStore.enroll(enrollment({ actorId: OTHER }));
      beforeStore.unenroll(OTHER, EXPERIMENT);
      before.close();

      // A fresh process: new connection, migrations re-run, nothing in memory.
      const after = new Database(file);
      runMigrations(after);
      const afterStore = new DbExperimentEnrollmentStore(after);
      expect(afterStore.isEnrolled(WORKER, EXPERIMENT)).toBe(true);
      expect(afterStore.isEnrolled(OTHER, EXPERIMENT)).toBe(false);
      expect(afterStore.list()).toEqual([enrollment({ actorId: WORKER })]);
      after.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("sees an enrollment written on another connection without a restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "rusa-actor-experiments-live-"));
    const file = join(directory, "mesh.db");
    try {
      const writerDb = makeDb(file);
      const readerDb = new Database(file);
      const reader = new DbExperimentEnrollmentStore(readerDb);
      expect(reader.isEnrolled(WORKER, EXPERIMENT)).toBe(false);

      new DbExperimentEnrollmentStore(writerDb).enroll(enrollment({ actorId: WORKER }));
      expect(reader.isEnrolled(WORKER, EXPERIMENT)).toBe(true);

      writerDb.close();
      readerDb.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
