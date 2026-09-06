import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACTOR_A,
  ACTOR_B,
  job,
  testHostJobStoreContract,
} from "../../actor/host-job-store.contract.js";
import { runMigrations } from "../migrations/runner.js";
import { widenToWal } from "../wal.js";
import { DbHostJobStore, HOST_JOB_MANIFEST_SCHEMA_VERSION } from "./host-job-repository.js";

const ROOT = "root-thread";

/**
 * Seeds the actors this suite submits jobs for — host_jobs.actor_id is
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

testHostJobStoreContract("DbHostJobStore", () => new DbHostJobStore(makeDb()));

describe("DbHostJobStore (DB-specific)", () => {
  let db: Database.Database;
  let store: DbHostJobStore;

  beforeEach(() => {
    db = makeDb();
    store = new DbHostJobStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("refuses to submit a job for an actor id with no actors row", () => {
    expect(() => store.submit(job({ actorId: "no-such-actor" }))).toThrow();
  });

  it("refuses a second job claiming a unit name another job already holds", () => {
    store.submit(job({ id: "job-1", unitName: "unit-1" }));
    expect(() =>
      store.submit(job({ id: "job-2", actorId: ACTOR_B, unitName: "unit-1" }))
    ).toThrow();
    expect(store.list()).toHaveLength(1);
  });

  it("stores the manifest as its versioned document", () => {
    store.submit(job({ manifest: { readPaths: ["/srv/data"] } }));
    const stored = db.prepare("SELECT manifest FROM host_jobs WHERE id = 'job-1'").get() as {
      manifest: string;
    };
    expect(JSON.parse(stored.manifest)).toEqual({
      schemaVersion: HOST_JOB_MANIFEST_SCHEMA_VERSION,
      readPaths: ["/srv/data"],
    });
  });

  // The column carries no database-level shape constraint by design, so the
  // repository is the only thing standing between a hand-edited row and a job
  // record claiming a read scope nobody validated.
  it("names the job when a manifest document does not match the schema", () => {
    store.submit(job());
    db.prepare(
      "UPDATE host_jobs SET manifest = '{\"readPaths\":\"/etc\"}' WHERE id = 'job-1'"
    ).run();
    expect(() => store.get("job-1")).toThrow(/invalid manifest for host job 'job-1'/);
  });

  // The primary key, not application code, is what refuses this — the contract
  // test pins the same refusal from the store side for both implementations.
  it("leaves the first row intact when an id is submitted twice", () => {
    store.submit(job({ scriptLabel: "first", unitName: "unit-1" }));
    expect(() => store.submit(job({ scriptLabel: "second", unitName: "unit-2" }))).toThrow();
    expect(store.list()).toHaveLength(1);
    expect(store.get("job-1")?.scriptLabel).toBe("first");
  });
});

describe("DbHostJobStore (file-backed database)", () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "rusa-host-jobs-"));
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

  it("persists ownership and terminal state across a database reopen", () => {
    const first = open();
    const writer = new DbHostJobStore(first);
    writer.submit(job({ id: "job-1", unitName: "unit-1" }));
    writer.submit(job({ id: "job-2", actorId: ACTOR_B, unitName: "unit-2" }));
    writer.recordStopRequested("job-2", "2026-07-01T01:00:00.000Z");
    writer.recordExit("job-2", "2026-07-01T02:00:00.000Z", "signal", "15");
    first.close();

    const reopened = open();
    const reloaded = new DbHostJobStore(reopened);
    expect(reloaded.listFor(ACTOR_A).map((j) => j.id)).toEqual(["job-1"]);
    expect(reloaded.activeCountFor(ACTOR_A)).toBe(1);
    expect(reloaded.activeCountFor(ACTOR_B)).toBe(0);
    expect(reloaded.get("job-2")).toEqual(
      job({
        id: "job-2",
        actorId: ACTOR_B,
        unitName: "unit-2",
        stopRequestedAt: "2026-07-01T01:00:00.000Z",
        completedAt: "2026-07-01T02:00:00.000Z",
        exitStatus: "signal",
        exitCode: "15",
      })
    );
    reopened.close();
  });

  it("a second connection observes a committed submit and exit without reopening", () => {
    const service = open();
    const dashboard = open();
    const reader = new DbHostJobStore(dashboard);
    expect(reader.list()).toEqual([]);

    new DbHostJobStore(service).submit(job());
    expect(reader.activeCountFor(ACTOR_A)).toBe(1);

    new DbHostJobStore(service).recordExit("job-1", "2026-07-01T02:00:00.000Z", "success", "0");
    expect(reader.activeCountFor(ACTOR_A)).toBe(0);
    expect(reader.get("job-1")?.exitStatus).toBe("success");

    service.close();
    dashboard.close();
  });

  // The exit endpoint runs in the HTTP handler while the mesh lists and counts
  // the same rows; neither side may hold a process-local snapshot to go stale.
  it("observes an exit recorded by a separate process", () => {
    const service = open();
    const reader = new DbHostJobStore(service);
    reader.submit(job());
    expect(reader.activeCountFor(ACTOR_A)).toBe(1);

    execFileSync(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "-e",
        `import Database from "better-sqlite3";
         const db = new Database(process.argv[1]);
         db.prepare(
           "UPDATE host_jobs SET completed_at = ?, exit_status = ?, exit_code = ? WHERE id = ?"
         ).run("2026-07-01T02:00:00.000Z", "exit-code", "1", process.argv[2]);
         db.close();`,
        file,
        "job-1",
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }
    );

    expect(reader.activeCountFor(ACTOR_A)).toBe(0);
    expect(reader.get("job-1")?.exitStatus).toBe("exit-code");
    service.close();
  });
});
