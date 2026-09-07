import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOST_JOBS_FILENAME, type HostJobRecord } from "../actor/host-job-store.js";
import {
  applyLegacyHostJobImport,
  HOST_JOB_IMPORT_SOURCE,
  importLegacyHostJobState,
  planLegacyHostJobImport,
} from "./legacy-host-job-import.js";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";

const ROOT = "root-thread";
const ACTOR_A = "actor-thread-a";
const ACTOR_B = "actor-thread-b";

const job = (over: Partial<HostJobRecord> = {}): HostJobRecord => ({
  id: "job-1",
  actorId: ACTOR_A,
  unitName: "job-handle-a-12345678",
  scriptLabel: "echo hi",
  manifest: { readPaths: [] },
  auditArtifactPath: "/tmp/mc-home/host-jobs/audit/job-1.json",
  auditArtifactSha256: "a".repeat(64),
  runtimeMaxSec: 3600,
  submittedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

describe("legacy host-job import", () => {
  let home: string;
  let filePath: string;
  let db: Database.Database;
  let repositories: Repositories;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rusa-host-job-import-"));
    filePath = join(home, HOST_JOBS_FILENAME);
    db = new Database(join(home, "mesh.db"));
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    const insert = db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'test actor', ?, '2026-06-27T00:00:00Z')"
    );
    insert.run(ROOT, null);
    insert.run(ACTOR_A, ROOT);
    insert.run(ACTOR_B, ROOT);
    repositories = new Repositories(db);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const writeLegacy = (jobs: unknown[]): void => {
    writeFileSync(filePath, JSON.stringify({ jobs }, null, 2));
  };

  const backups = (): string[] => readdirSync(home).filter((name) => name.endsWith(".bak"));

  const runImport = (): ReturnType<typeof importLegacyHostJobState> =>
    importLegacyHostJobState({ mcHome: home, db, repositories });

  it("is a no-op when no legacy file is present, and creates none", () => {
    const result = runImport();
    expect(result).toEqual({ importedJobs: 0, backupFiles: [] });
    expect(repositories.hostJobs.list()).toEqual([]);
    expect(existsSync(filePath)).toBe(false);
  });

  it("imports active and completed jobs, then archives the source recoverably", () => {
    const active = job({ id: "job-1", unitName: "unit-1" });
    const finished = job({
      id: "job-2",
      actorId: ACTOR_B,
      unitName: "unit-2",
      manifest: { readPaths: ["/srv/data"] },
      stopRequestedAt: "2026-07-01T01:00:00.000Z",
      completedAt: "2026-07-01T02:00:00.000Z",
      exitStatus: "signal",
      exitCode: "15",
    });
    writeLegacy([active, finished]);

    const result = runImport();

    expect(result.importedJobs).toBe(2);
    expect(repositories.hostJobs.get("job-1")).toEqual(active);
    expect(repositories.hostJobs.get("job-2")).toEqual(finished);
    // A job that had already exited must not come back occupying a slot.
    expect(repositories.hostJobs.activeCountFor(ACTOR_A)).toBe(1);
    expect(repositories.hostJobs.activeCountFor(ACTOR_B)).toBe(0);
    expect(repositories.hostJobs.findByUnitName("unit-2")?.id).toBe("job-2");

    // The source is renamed, never deleted: its bytes stay recoverable.
    expect(existsSync(filePath)).toBe(false);
    expect(result.backupFiles).toHaveLength(1);
    const restored = JSON.parse(readFileSync(result.backupFiles[0] as string, "utf8"));
    expect(restored.jobs).toHaveLength(2);
  });

  it("resolves a repeated job id the way the retired store did — last entry wins", () => {
    writeLegacy([job({ scriptLabel: "first" }), job({ scriptLabel: "second" })]);
    expect(runImport().importedJobs).toBe(1);
    expect(repositories.hostJobs.get("job-1")?.scriptLabel).toBe("second");
  });

  it("re-running after a completed import is a no-op", () => {
    writeLegacy([job()]);
    runImport();
    const before = repositories.hostJobs.list();

    const second = runImport();
    expect(second).toEqual({ importedJobs: 0, backupFiles: [] });
    expect(repositories.hostJobs.list()).toEqual(before);
  });

  describe("refuses rather than importing a partial host-job view", () => {
    const expectRefusal = (pattern: RegExp): void => {
      expect(() => runImport()).toThrow(pattern);
      expect(repositories.hostJobs.list()).toEqual([]);
      expect(repositories.legacyImportReceipts.has(HOST_JOB_IMPORT_SOURCE)).toBe(false);
      expect(existsSync(filePath)).toBe(true);
      expect(backups()).toEqual([]);
    };

    it("refuses a malformed row instead of dropping it", () => {
      writeLegacy([job(), { id: "job-2", actorId: ACTOR_B }]);
      expectRefusal(/unresolved row/);
    });

    it("refuses a row with an unrecognized field rather than discarding it", () => {
      writeLegacy([{ ...job(), somethingNew: true }]);
      expectRefusal(/unresolved row/);
    });

    it("refuses two jobs claiming one unit name instead of routing exits to the first", () => {
      writeLegacy([
        job({ id: "job-1", unitName: "shared-unit" }),
        job({ id: "job-2", actorId: ACTOR_B, unitName: "shared-unit" }),
      ]);
      expectRefusal(/unit name 'shared-unit' is claimed by both job 'job-1' and job 'job-2'/);
    });

    it("refuses a job owned by an actor with no actors row", () => {
      writeLegacy([job({ actorId: "no-such-actor" })]);
      expectRefusal(/references unknown actor 'no-such-actor'/);
    });

    it("refuses unparseable JSON", () => {
      writeFileSync(filePath, "{ not json");
      expectRefusal(/cannot parse/);
    });

    it("refuses when durable rows exist with no import receipt", () => {
      repositories.hostJobs.submit(job({ id: "job-9", unitName: "unit-9" }));
      writeLegacy([job()]);
      expect(() => runImport()).toThrow(/written without an import receipt/);
      // The pre-existing durable row is untouched and the source is still there.
      expect(repositories.hostJobs.list().map((j) => j.id)).toEqual(["job-9"]);
      expect(existsSync(filePath)).toBe(true);
      expect(backups()).toEqual([]);
    });

    // Preflight plans both imports against one un-mutated copy, so a job's
    // owner may legitimately be planned rather than committed.
    it("accepts an actor a legacy actor import has planned but not committed", () => {
      writeLegacy([job({ actorId: "pending-actor" })]);
      const planned = planLegacyHostJobImport({
        mcHome: home,
        repositories,
        pendingActorIds: ["pending-actor"],
      });
      expect(planned.plannedJobs).toBe(1);
      // Planning performs no write of its own.
      expect(repositories.hostJobs.list()).toEqual([]);
      expect(existsSync(filePath)).toBe(true);
    });
  });

  describe("interruption precedence", () => {
    it("interrupted before commit leaves the complete legacy view, and a retry imports it", () => {
      writeLegacy([
        job({ id: "job-1", unitName: "unit-1" }),
        job({ id: "job-2", unitName: "unit-2" }),
      ]);

      // Planning is the whole pre-commit half; losing the process here writes
      // nothing at all, so the file is still the complete view.
      planLegacyHostJobImport({ mcHome: home, repositories });
      expect(repositories.hostJobs.list()).toEqual([]);
      expect(repositories.legacyImportReceipts.has(HOST_JOB_IMPORT_SOURCE)).toBe(false);
      expect(existsSync(filePath)).toBe(true);

      expect(runImport().importedJobs).toBe(2);
      expect(repositories.hostJobs.list().map((j) => j.id)).toEqual(["job-1", "job-2"]);
    });

    it("a failure inside the transaction commits nothing", () => {
      writeLegacy([
        job({ id: "job-1", unitName: "unit-1" }),
        job({ id: "job-2", unitName: "unit-2" }),
      ]);
      const planResult = planLegacyHostJobImport({ mcHome: home, repositories });

      expect(() =>
        applyLegacyHostJobImport(planResult, {
          db,
          repositories,
          now: () => {
            throw new Error("interrupted after the rows, before the receipt");
          },
        })
      ).toThrow(/interrupted/);

      expect(repositories.hostJobs.list()).toEqual([]);
      expect(repositories.legacyImportReceipts.has(HOST_JOB_IMPORT_SOURCE)).toBe(false);
      expect(existsSync(filePath)).toBe(true);
      expect(backups()).toEqual([]);

      // And the retry gets the complete legacy view.
      expect(runImport().importedJobs).toBe(2);
    });

    it("a source file surviving the commit is archived unread, never replayed over newer rows", () => {
      writeLegacy([job()]);
      runImport();

      // The mesh moves on: the imported job exits.
      repositories.hostJobs.recordExit("job-1", "2026-07-01T02:00:00.000Z", "success", "0");

      // Someone restores the pre-import file — an older view of the same job.
      writeLegacy([job()]);
      const result = runImport();

      expect(result.importedJobs).toBe(0);
      expect(result.backupFiles).toHaveLength(1);
      expect(existsSync(filePath)).toBe(false);
      // The durable terminal state stands; the stale file did not resurrect it.
      expect(repositories.hostJobs.get("job-1")?.completedAt).toBe("2026-07-01T02:00:00.000Z");
      expect(repositories.hostJobs.activeCountFor(ACTOR_A)).toBe(0);
    });
  });

  // Rollback story for the release that performs the import: a downgraded build
  // has no `host_jobs` reader and goes back to reading `host-jobs.json`, so the
  // archive has to be a faithful copy an operator can simply rename back.
  it("leaves a byte-identical backup a downgraded build can be rolled back onto", () => {
    writeLegacy([
      job({ id: "job-1", unitName: "unit-1" }),
      job({
        id: "job-2",
        actorId: ACTOR_B,
        unitName: "unit-2",
        completedAt: "2026-07-01T02:00:00.000Z",
        exitStatus: "success",
        exitCode: "0",
      }),
    ]);
    const before = readFileSync(filePath, "utf8");

    const result = runImport();

    expect(result.backupFiles).toHaveLength(1);
    expect(readFileSync(result.backupFiles[0] as string, "utf8")).toBe(before);
  });

  it("survives a restart with the database authoritative and no JSON source recreated", () => {
    writeLegacy([job()]);
    runImport();
    repositories.hostJobs.recordStopRequested("job-1", "2026-07-01T01:00:00.000Z");
    db.close();

    const reopened = new Database(join(home, "mesh.db"));
    reopened.pragma("foreign_keys = ON");
    const afterRestart = new Repositories(reopened);
    const rerun = importLegacyHostJobState({
      mcHome: home,
      db: reopened,
      repositories: afterRestart,
    });

    expect(rerun).toEqual({ importedJobs: 0, backupFiles: [] });
    expect(afterRestart.hostJobs.get("job-1")?.stopRequestedAt).toBe("2026-07-01T01:00:00.000Z");
    expect(existsSync(filePath)).toBe(false);
    reopened.close();

    // Reassigned so afterEach's close() is not a double close of `db`.
    db = new Database(join(home, "mesh.db"));
  });
});
