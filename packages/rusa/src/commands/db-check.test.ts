import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
    expect(result.plannedEventSubscriptions).toBe(1);

    // Plan mode never archives the source or writes durable subscription rows.
    expect(readFileSync(join(home, "event-subscriptions.json"), "utf8")).toBe(subscriptions);
    const db = new Database(join(home, "data", "mesh.db"));
    expect(new Repositories(db).eventSubscriptions.list()).toEqual([]);
    db.close();
  });

  it("reports no planned subscriptions on a fresh home and creates no subscription file", () => {
    const result = runDbCheckAgainstHome(home);

    expect(result.plannedEventSubscriptions).toBe(0);
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
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("0 event subscription(s)"));
    expect(consoleLog).toHaveBeenCalledWith("✓ db-check passed");
    consoleLog.mockRestore();
  });
});
