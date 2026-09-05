import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Repositories } from "../db/repositories/index.js";
import { runDbCheck, runDbCheckAgainstHome } from "./db-check.js";

interface LegacyGrant {
  actorId: string;
  capability: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string;
}

describe("db-check", () => {
  let home: string;
  let originalExit: typeof process.exit;
  let originalRusaHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "db-check-"));
    mkdirSync(join(home, "root-agent"), { recursive: true });
    originalExit = process.exit;
    // @ts-expect-error test double
    process.exit = vi.fn();
    originalRusaHome = process.env.RUSA_HOME;
  });

  afterEach(() => {
    process.exit = originalExit;
    if (originalRusaHome === undefined) delete process.env.RUSA_HOME;
    else process.env.RUSA_HOME = originalRusaHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses to run without an explicit home", () => {
    expect(() => runDbCheckAgainstHome("")).toThrow(/--home is required/);
    expect(() => runDbCheckAgainstHome("   ")).toThrow(/--home is required/);
  });

  it("refuses a nonexistent home path without creating it", () => {
    const missing = join(home, "typo-nonexistent");
    expect(existsSync(missing)).toBe(false);
    expect(() => runDbCheckAgainstHome(missing)).toThrow(/does not exist as a directory/);
    expect(existsSync(missing)).toBe(false);
  });

  it("refuses a home path that is a file, not a directory", () => {
    const filePath = join(home, "not-a-dir");
    writeFileSync(filePath, "not a home");
    expect(() => runDbCheckAgainstHome(filePath)).toThrow(/does not exist as a directory/);
  });

  it("refuses to run directly against the configured live home", () => {
    const liveHome = mkdtempSync(join(tmpdir(), "db-check-live-"));
    process.env.RUSA_HOME = liveHome;
    try {
      expect(() => runDbCheckAgainstHome(liveHome)).toThrow(/resolves to the live Rusa home/);
    } finally {
      rmSync(liveHome, { recursive: true, force: true });
    }
  });

  it("refuses to run against a symlink alias of the configured live home", () => {
    const liveHome = mkdtempSync(join(tmpdir(), "db-check-live-"));
    const alias = join(tmpdir(), `db-check-live-alias-${process.pid}-${Date.now()}`);
    symlinkSync(liveHome, alias);
    process.env.RUSA_HOME = liveHome;
    try {
      expect(() => runDbCheckAgainstHome(alias)).toThrow(/resolves to the live Rusa home/);
    } finally {
      rmSync(alias, { force: true });
      rmSync(liveHome, { recursive: true, force: true });
    }
  });

  it("applies pending migrations to the copied home's mesh.db and reports them", () => {
    const first = runDbCheckAgainstHome(home);
    expect(first.pendingMigrationIds.length).toBeGreaterThan(0);

    const dbPath = join(home, "data", "mesh.db");
    expect(existsSync(dbPath)).toBe(true);
    const db = new Database(dbPath);
    const migrationsTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'`)
      .get();
    expect(migrationsTable).toBeDefined();
    db.close();

    // A second run against the same copy has nothing left pending.
    const second = runDbCheckAgainstHome(home);
    expect(second.pendingMigrationIds).toEqual([]);
  });

  it("plans a legacy import with an ISO-8601 UTC offset timestamp without writing or archiving", () => {
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify({
        threads: [
          {
            id: "root",
            charter: "root charter",
            parentId: null,
            status: "active",
            createdAt: "2026-01-02T03:04:05.123456+00:00",
            pendingDeliveries: [
              {
                id: "scheduled-offset",
                fromId: "root",
                body: "check back later",
                deliverAt: "2026-01-03T03:04:05.123456+00:00",
              },
            ],
          },
        ],
      })
    );
    writeFileSync(
      join(home, "root-agent", "session.json"),
      JSON.stringify({ sessionId: "root-session" })
    );

    // No scheduler is configured or required for a plan — db-check must not
    // need a real host scheduler to report the pending delivery.
    const result = runDbCheckAgainstHome(home);

    expect(result.plannedActors).toBe(1);
    expect(result.plannedScheduledMessages).toBe(1);

    // Plan mode never archives, renames, or deletes the legacy files.
    expect(existsSync(join(home, "threads.json"))).toBe(true);
    expect(existsSync(join(home, "root-agent", "session.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "threads.json"), "utf8")).threads).toHaveLength(1);

    // Plan mode never writes actor rows, mesh chat, or mesh events either.
    const db = new Database(join(home, "data", "mesh.db"));
    const actorCount = (db.prepare("SELECT COUNT(*) as n FROM actors").get() as { n: number }).n;
    const meshChatCount = (db.prepare("SELECT COUNT(*) as n FROM mesh_chat").get() as { n: number })
      .n;
    const meshEventsCount = (
      db.prepare("SELECT COUNT(*) as n FROM mesh_events").get() as { n: number }
    ).n;
    expect(actorCount).toBe(0);
    expect(meshChatCount).toBe(0);
    expect(meshEventsCount).toBe(0);
    db.close();
  });

  it("plans adopting an existing root's session without threads.json, mutating nothing", () => {
    // First run applies migrations and gives us a real mesh.db to seed.
    runDbCheckAgainstHome(home);

    const dbPath = join(home, "data", "mesh.db");
    const db = new Database(dbPath);
    const repositories = new Repositories(db);
    repositories.actors.upsert({
      id: "root",
      charter: "root charter",
      parentId: null,
      isRoot: true,
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.close();

    writeFileSync(
      join(home, "root-agent", "session.json"),
      JSON.stringify({ sessionId: "root-session" })
    );

    const result = runDbCheckAgainstHome(home);

    expect(result.plannedActors).toBe(1);
    expect(result.plannedScheduledMessages).toBe(0);

    // Plan mode never patches the actor row or touches the session source.
    const verifyDb = new Database(dbPath);
    const root = new Repositories(verifyDb).actors.get("root");
    expect(root?.sessionId).toBeUndefined();
    verifyDb.close();
    expect(
      JSON.parse(readFileSync(join(home, "root-agent", "session.json"), "utf8")).sessionId
    ).toBe("root-session");
  });

  it("plans the event-subscription import against actors the same run has only planned", () => {
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify({
        threads: [
          {
            id: "root",
            charter: "root charter",
            parentId: null,
            status: "active",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "worker",
            charter: "worker charter",
            parentId: "root",
            status: "active",
            createdAt: "2026-01-01T00:00:01Z",
          },
        ],
      })
    );
    const subscriptions = JSON.stringify({
      version: 3,
      subscriptions: [
        {
          resource: "github:dummy-org/dummy-repo",
          actorId: "worker",
          subscribedBy: "root",
          subscribedAt: "2026-01-02T00:00:00Z",
        },
      ],
    });
    writeFileSync(join(home, "event-subscriptions.json"), subscriptions);

    const result = runDbCheckAgainstHome(home);

    expect(result.plannedActors).toBe(2);
    expect(result.plannedEventSourceOwnerships).toBe(1);

    // Plan mode never archives the source or writes durable subscription rows.
    expect(readFileSync(join(home, "event-subscriptions.json"), "utf8")).toBe(subscriptions);
    const db = new Database(join(home, "data", "mesh.db"));
    expect(new Repositories(db).eventSourceOwners.list()).toEqual([]);
    db.close();
  });

  it("reports no planned subscriptions on a fresh home and creates no subscription file", () => {
    const result = runDbCheckAgainstHome(home);

    expect(result.plannedEventSourceOwnerships).toBe(0);
    expect(existsSync(join(home, "event-subscriptions.json"))).toBe(false);
  });

  it("exits non-zero when the legacy subscription file holds unresolved ownership", () => {
    writeFileSync(
      join(home, "event-subscriptions.json"),
      JSON.stringify({
        version: 3,
        subscriptions: [{ resource: "github:dummy-org/dummy-repo", actorId: "" }],
      })
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    runDbCheck({ home });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("unresolved row(s)"));
    consoleError.mockRestore();
  });

  it("plans the host-job import against actors the same run has only planned", () => {
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify({
        threads: [
          {
            id: "root",
            charter: "root charter",
            parentId: null,
            status: "active",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "worker",
            charter: "worker charter",
            parentId: "root",
            status: "active",
            createdAt: "2026-01-01T00:00:01Z",
          },
        ],
      })
    );
    const jobs = JSON.stringify({
      jobs: [
        {
          id: "job-1",
          actorId: "worker",
          unitName: "job-worker-12345678",
          scriptLabel: "echo hi",
          manifest: { readPaths: [] },
          auditArtifactPath: "/tmp/audit/job-1.json",
          auditArtifactSha256: "a".repeat(64),
          runtimeMaxSec: 3600,
          submittedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    });
    writeFileSync(join(home, "host-jobs.json"), jobs);

    const result = runDbCheckAgainstHome(home);

    expect(result.plannedActors).toBe(2);
    expect(result.plannedHostJobs).toBe(1);

    // Plan mode never archives the source or writes durable job rows.
    expect(readFileSync(join(home, "host-jobs.json"), "utf8")).toBe(jobs);
    const db = new Database(join(home, "data", "mesh.db"));
    expect(new Repositories(db).hostJobs.list()).toEqual([]);
    db.close();
  });

  it("reports no planned host jobs on a fresh home and creates no host-jobs file", () => {
    const result = runDbCheckAgainstHome(home);

    expect(result.plannedHostJobs).toBe(0);
    expect(existsSync(join(home, "host-jobs.json"))).toBe(false);
  });

  it("exits non-zero when the legacy host-job file holds unresolved rows", () => {
    writeFileSync(
      join(home, "host-jobs.json"),
      JSON.stringify({ jobs: [{ id: "job-1", actorId: "worker" }] })
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    runDbCheck({ home });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("unresolved row(s)"));
    consoleError.mockRestore();
  });
  function writeThreads(
    threads: Array<{ id: string; parentId: string | null; createdAt: string }>
  ): void {
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify({
        threads: threads.map((thread) => ({
          ...thread,
          charter: "test actor",
          status: "active",
        })),
      })
    );
  }

  function writeGrants(grants: LegacyGrant[]): void {
    writeFileSync(join(home, "capability-grants.json"), JSON.stringify({ grants }));
  }

  /** Open the preflighted copy's database; `runDbCheckAgainstHome` must have created it. */
  function withDb<T>(read: (repositories: Repositories, db: Database.Database) => T): T {
    const db = new Database(join(home, "data", "mesh.db"));
    try {
      db.pragma("foreign_keys = ON");
      return read(new Repositories(db), db);
    } finally {
      db.close();
    }
  }

  function countRows(table: string): number {
    return withDb(
      (_repositories, db) =>
        (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n
    );
  }

  /** Every legacy source an import would archive is still exactly where it was. */
  function expectNothingArchived(sources: string[]): void {
    for (const source of sources) expect(existsSync(join(home, source))).toBe(true);
    expect(readdirSync(home).filter((entry) => entry.endsWith(".bak"))).toEqual([]);
  }

  it("counts grants that name actors the same preflight only plans to import", () => {
    // Boot imports legacy actors before legacy grants, so at boot these actors
    // exist by the time the grant import validates them. Preflight writes
    // neither, so the grant plan has to see the planned actors to agree.
    writeThreads([
      { id: "root", parentId: null, createdAt: "2026-01-01T00:00:00Z" },
      { id: "worker", parentId: "root", createdAt: "2026-01-01T00:00:01Z" },
    ]);
    writeGrants([
      {
        actorId: "worker",
        capability: "secret:gemini-api-key",
        grantedBy: "root",
        grantedAt: "2026-02-01T00:00:00Z",
      },
      {
        actorId: "worker",
        capability: "secret:mistral-api-key",
        grantedBy: "root",
        grantedAt: "2026-02-01T00:00:00Z",
        revokedAt: "2026-02-02T00:00:00Z",
      },
    ]);

    const result = runDbCheckAgainstHome(home);

    expect(result.plannedActors).toBe(2);
    expect(result.plannedCapabilityGrants).toBe(2);

    expect(countRows("actors")).toBe(0);
    expect(countRows("capability_grants")).toBe(0);
    expectNothingArchived(["threads.json", "capability-grants.json"]);
    expect(
      JSON.parse(readFileSync(join(home, "capability-grants.json"), "utf8")).grants
    ).toHaveLength(2);
  });

  it("counts grants against actors already committed to the copy", () => {
    runDbCheckAgainstHome(home);
    withDb((repositories) => {
      repositories.actors.upsert({
        id: "root",
        charter: "root charter",
        parentId: null,
        isRoot: true,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    });
    writeGrants([
      {
        actorId: "root",
        capability: "secret:gemini-api-key",
        grantedBy: "root",
        grantedAt: "2026-02-01T00:00:00Z",
      },
    ]);

    const result = runDbCheckAgainstHome(home);

    expect(result.plannedActors).toBe(0);
    expect(result.plannedCapabilityGrants).toBe(1);
    expect(countRows("capability_grants")).toBe(0);
    expectNothingArchived(["capability-grants.json"]);
  });

  it("plans no grants when the copy has no legacy grant file", () => {
    const result = runDbCheckAgainstHome(home);

    expect(result.plannedCapabilityGrants).toBe(0);
    // Preflight must not conjure the retired file it is checking for.
    expect(existsSync(join(home, "capability-grants.json"))).toBe(false);
  });

  it("plans no grants when durable rows already match the file, and archives nothing", () => {
    runDbCheckAgainstHome(home);
    withDb((repositories) => {
      repositories.actors.upsert({
        id: "root",
        charter: "root charter",
        parentId: null,
        isRoot: true,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      repositories.capabilityGrants.grant({
        actorId: "root",
        capability: "secret:gemini-api-key",
        grantedBy: "root",
        // The importer normalizes the file's timestamps to millisecond-Z form,
        // so a committed row only matches when it is already canonical.
        grantedAt: "2026-02-01T00:00:00.000Z",
      });
      repositories.capabilityGrants.revoke(
        "root",
        "secret:gemini-api-key",
        "2026-02-02T00:00:00.000Z"
      );
    });
    writeGrants([
      {
        actorId: "root",
        capability: "secret:gemini-api-key",
        grantedBy: "root",
        grantedAt: "2026-02-01T00:00:00Z",
        revokedAt: "2026-02-02T00:00:00Z",
      },
    ]);

    const result = runDbCheckAgainstHome(home);

    // Boot would archive the matched file; preflight reports the import is
    // already done and leaves the file for boot to archive.
    expect(result.plannedCapabilityGrants).toBe(0);
    expect(countRows("capability_grants")).toBe(1);
    expectNothingArchived(["capability-grants.json"]);
  });

  it("exits non-zero when the grant file diverges from durable grants", () => {
    runDbCheckAgainstHome(home);
    withDb((repositories) => {
      repositories.actors.upsert({
        id: "root",
        charter: "root charter",
        parentId: null,
        isRoot: true,
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      repositories.capabilityGrants.grant({
        actorId: "root",
        capability: "secret:gemini-api-key",
        grantedBy: "root",
        grantedAt: "2026-02-01T00:00:00.000Z",
      });
    });
    writeGrants([
      {
        actorId: "root",
        capability: "secret:mistral-api-key",
        grantedBy: "root",
        grantedAt: "2026-02-01T00:00:00Z",
      },
    ]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    runDbCheck({ home });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("refusing to overwrite durable grants")
    );
    expect(countRows("capability_grants")).toBe(1);
    expectNothingArchived(["capability-grants.json"]);
    consoleError.mockRestore();
  });

  it("exits non-zero when a grant names an actor no import would create", () => {
    writeThreads([{ id: "root", parentId: null, createdAt: "2026-01-01T00:00:00Z" }]);
    writeGrants([
      {
        actorId: "ghost",
        capability: "secret:gemini-api-key",
        grantedBy: "root",
        grantedAt: "2026-02-01T00:00:00Z",
      },
    ]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    runDbCheck({ home });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("unknown actor 'ghost'"));
    expectNothingArchived(["threads.json", "capability-grants.json"]);
    consoleError.mockRestore();
  });

  it("exits non-zero on a malformed grant file rather than passing preflight", () => {
    writeFileSync(join(home, "capability-grants.json"), "{ not json");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    runDbCheck({ home });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("cannot parse"));
    expectNothingArchived(["capability-grants.json"]);
    consoleError.mockRestore();
  });

  it("exits non-zero on a structurally invalid grant entry", () => {
    writeThreads([{ id: "root", parentId: null, createdAt: "2026-01-01T00:00:00Z" }]);
    writeGrants([
      {
        actorId: "root",
        capability: "secret:gemini-api-key",
        grantedBy: "root",
        grantedAt: "yesterday",
      },
    ]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    runDbCheck({ home });

    expect(process.exit).toHaveBeenCalledWith(1);
    expectNothingArchived(["threads.json", "capability-grants.json"]);
    consoleError.mockRestore();
  });

  it("exits non-zero with the actionable underlying failure on invalid legacy state", () => {
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify({
        threads: [
          {
            id: "root",
            charter: "c",
            parentId: null,
            status: "active",
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: "orphan",
            charter: "c",
            parentId: "missing-parent",
            status: "active",
            createdAt: "2026-01-01T00:00:01Z",
          },
        ],
      })
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    runDbCheck({ home });

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("missing parent"));
    consoleError.mockRestore();
  });

  it("prints the pending migration and legacy import plan on success", () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    runDbCheck({ home });

    expect(process.exit).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "Legacy import plan: 0 actor(s), 0 scheduled message(s), 0 capability grant(s), " +
          "0 event source ownership(s), 0 host job(s)"
      )
    );
    expect(consoleLog).toHaveBeenCalledWith("✓ db-check passed");
    consoleLog.mockRestore();
  });
});
