import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { hostJobs } from "./0040_host_jobs.js";

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

const submit = (
  db: Database.Database,
  over: { id?: string; actorId?: string; unitName?: string; completedAt?: string | null } = {}
): void => {
  db.prepare(
    `INSERT INTO host_jobs (
       id, actor_id, unit_name, script_label, manifest,
       audit_artifact_path, audit_artifact_sha256, runtime_max_sec, submitted_at, completed_at
     ) VALUES (?, ?, ?, 'echo hi', '{"schemaVersion":1,"readPaths":[]}',
       '/tmp/audit.json', 'a', 3600, '2026-07-01T00:00:00.000Z', ?)`
  ).run(
    over.id ?? "job-1",
    over.actorId ?? "actor-a",
    over.unitName ?? "job-handle-a-12345678",
    over.completedAt ?? null
  );
};

/**
 * The schema half of the cutover. Behavior through the repository is covered in
 * `host-job-repository.test.ts`; what is pinned here is what the database
 * itself guarantees when application code is bypassed, because that is the part
 * a reviewer is being asked to approve.
 */
describe("0040_host_jobs", () => {
  it("creates the table on a fresh database", () => {
    const db = seedDb();
    hostJobs.up(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'host_jobs'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["host_jobs"]);
  });

  it("keys one row per job id", () => {
    const db = seedDb();
    hostJobs.up(db);
    submit(db);
    expect(() => submit(db, { unitName: "job-handle-a-87654321" })).toThrow();
  });

  // The exit endpoint resolves a job by unit name alone when systemd fires
  // without a job id, and that lookup picks which actor gets woken.
  it("admits only one job per unit name, across actors", () => {
    const db = seedDb();
    hostJobs.up(db);
    submit(db);
    expect(() => submit(db, { id: "job-2", actorId: "actor-b" })).toThrow();
  });

  it("requires a real actor", () => {
    const db = seedDb();
    hostJobs.up(db);
    expect(() => submit(db, { actorId: "no-such-actor" })).toThrow();
  });

  // RESTRICT, because a job row is the durable record of who ran what on the
  // host plane and the audit-artifact hash it points at. Verified against the
  // repository layer as it stands: `ActorRepository` exposes no delete —
  // retirement sets `retired_at` — so no production path is blocked by this.
  it("RESTRICTs deleting an actor that has host-job history", () => {
    const db = seedDb();
    hostJobs.up(db);
    submit(db, { completedAt: "2026-07-01T01:00:00.000Z" });
    expect(() => db.prepare("DELETE FROM actors WHERE id = 'actor-a'").run()).toThrow();
  });

  it("leaves terminal state unconstrained so an unexited job is simply completed_at IS NULL", () => {
    const db = seedDb();
    hostJobs.up(db);
    submit(db, { id: "job-1", unitName: "unit-1" });
    submit(db, { id: "job-2", unitName: "unit-2", completedAt: "2026-07-01T01:00:00.000Z" });
    const active = db
      .prepare("SELECT id FROM host_jobs WHERE actor_id = 'actor-a' AND completed_at IS NULL")
      .all();
    expect(active).toEqual([{ id: "job-1" }]);
  });
});
