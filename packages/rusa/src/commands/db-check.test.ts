import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDbCheck, runDbCheckAgainstHome } from "./db-check.js";

describe("db-check", () => {
  let home: string;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "db-check-"));
    mkdirSync(join(home, "root-agent"), { recursive: true });
    originalExit = process.exit;
    // @ts-expect-error test double
    process.exit = vi.fn();
  });

  afterEach(() => {
    process.exit = originalExit;
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
          },
        ],
      })
    );
    writeFileSync(
      join(home, "root-agent", "session.json"),
      JSON.stringify({ sessionId: "root-session" })
    );

    const result = runDbCheckAgainstHome(home);

    expect(result.plannedActors).toBe(1);
    expect(result.plannedScheduledMessages).toBe(0);

    // Plan mode never archives, renames, or deletes the legacy files.
    expect(existsSync(join(home, "threads.json"))).toBe(true);
    expect(existsSync(join(home, "root-agent", "session.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, "threads.json"), "utf8")).threads).toHaveLength(1);

    // Plan mode never writes actor rows either.
    const db = new Database(join(home, "data", "mesh.db"));
    const actorCount = (db.prepare("SELECT COUNT(*) as n FROM actors").get() as { n: number }).n;
    expect(actorCount).toBe(0);
    db.close();
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
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("Legacy import plan"));
    expect(consoleLog).toHaveBeenCalledWith("✓ db-check passed");
    consoleLog.mockRestore();
  });
});
