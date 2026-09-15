import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backupQuotaDatabase,
  DEFAULT_QUOTA_BACKUP_RETENTION,
  listQuotaBackups,
  pruneQuotaBackups,
  QUOTA_BACKUP_INTERVAL_MS,
  QuotaBackupScheduler,
  restoreQuotaDatabase,
} from "./coordinator-backup.js";
import { QUOTA_SCHEMA_VERSION } from "./schema-guard.js";
import { SharedQuotaStore } from "./shared-store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "quota-backup-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A live WAL-mode quota database with one scrape committed. */
function seedDatabase(path: string, rawOutput = "seed"): SharedQuotaStore {
  const store = new SharedQuotaStore(path);
  store.recordRaw({ provider: "claude", scrapedAt: new Date().toISOString(), rawOutput });
  return store;
}

function countScrapes(path: string): number {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM quota_scrapes").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe("backupQuotaDatabase", () => {
  it("captures rows still in the write-ahead log, which a file copy would lose", () => {
    const databasePath = join(root, "quota.db");
    const store = seedDatabase(databasePath);
    // Do not close the store: an open WAL connection is exactly the state the
    // coordinator is in when the daily backup fires, and the whole reason the
    // design forbids a file copy.
    expect(existsSync(`${databasePath}-wal`)).toBe(true);

    const result = backupQuotaDatabase({ databasePath, backupDir: join(root, "backups") });

    expect(countScrapes(result.path)).toBe(1);
    // The naive alternative, for contrast: the bare .db without its -wal. Here
    // it does not merely lose the row — the table itself is still in the log,
    // so the copy is a database with no quota schema in it at all.
    const naiveCopy = join(root, "naive.db");
    execFileSync("cp", [databasePath, naiveCopy]);
    expect(() => countScrapes(naiveCopy)).toThrow(/no such table/);
    store.close();
  });

  it("writes a single self-contained file that preserves the schema version", () => {
    const databasePath = join(root, "quota.db");
    const store = seedDatabase(databasePath);
    const result = backupQuotaDatabase({ databasePath, backupDir: join(root, "backups") });
    store.close();

    expect(existsSync(`${result.path}-wal`)).toBe(false);
    expect(result.bytes).toBeGreaterThan(0);
    const db = new Database(result.path, { readonly: true, fileMustExist: true });
    try {
      expect(db.pragma("user_version", { simple: true })).toBe(QUOTA_SCHEMA_VERSION);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      db.close();
    }
  });

  it("leaves no partial file behind for retention to count", () => {
    const databasePath = join(root, "quota.db");
    const backupDir = join(root, "backups");
    const store = seedDatabase(databasePath);
    backupQuotaDatabase({ databasePath, backupDir });
    store.close();
    expect(listQuotaBackups(backupDir)).toHaveLength(1);
    expect(listQuotaBackups(backupDir)[0].endsWith(".partial")).toBe(false);
  });

  it("refuses a database that is not there", () => {
    expect(() =>
      backupQuotaDatabase({ databasePath: join(root, "missing.db"), backupDir: root })
    ).toThrow(/not found/);
  });
});

describe("retention", () => {
  it("keeps the newest N and deletes the rest", () => {
    const backupDir = join(root, "backups");
    mkdirSync(backupDir, { recursive: true });
    const names = Array.from(
      { length: 20 },
      (_, i) => `quota-2026010${Math.floor(i / 10)}T00${String(i % 10).padStart(2, "0")}00Z.db`
    );
    for (const name of names) writeFileSync(join(backupDir, name), "x");

    const pruned = pruneQuotaBackups(backupDir, 14);

    expect(pruned).toHaveLength(6);
    const kept = listQuotaBackups(backupDir).map((p) => p.split("/").pop());
    expect(kept).toHaveLength(14);
    expect(kept).toEqual(names.slice(6));
  });

  it("defaults to fourteen daily copies", () => {
    expect(DEFAULT_QUOTA_BACKUP_RETENTION).toBe(14);
  });

  it("ignores files it did not write, so an operator's own copy survives", () => {
    const backupDir = join(root, "backups");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "quota-20260101T000000Z.db"), "x");
    writeFileSync(join(backupDir, "before-the-incident.db"), "x");

    pruneQuotaBackups(backupDir, 1);

    expect(existsSync(join(backupDir, "before-the-incident.db"))).toBe(true);
  });

  it("refuses a retention that would delete the backup just taken", () => {
    expect(() => pruneQuotaBackups(root, 0)).toThrow(/positive integer/);
  });
});

describe("QuotaBackupScheduler", () => {
  it("does not back up on start when a backup is younger than the cadence", () => {
    const databasePath = join(root, "quota.db");
    const backupDir = join(root, "backups");
    const store = seedDatabase(databasePath);
    backupQuotaDatabase({ databasePath, backupDir });
    store.close();

    const scheduler = new QuotaBackupScheduler({
      databasePath,
      backupDir,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    });
    scheduler.start();
    scheduler.stop();

    // A restart loop must not be able to evict the retention window with copies
    // of the same minute.
    expect(listQuotaBackups(backupDir)).toHaveLength(1);
  });

  it("backs up on start once the newest backup is a cadence old", () => {
    const databasePath = join(root, "quota.db");
    const backupDir = join(root, "backups");
    const store = seedDatabase(databasePath);
    const first = backupQuotaDatabase({ databasePath, backupDir });
    store.close();
    const aged = (Date.now() - QUOTA_BACKUP_INTERVAL_MS - 1000) / 1000;
    utimesSync(first.path, aged, aged);

    const scheduler = new QuotaBackupScheduler({
      databasePath,
      backupDir,
      // A day later, so the new backup carries its own timestamped name rather
      // than colliding with the one taken a moment ago in this test.
      now: () => Date.now() + QUOTA_BACKUP_INTERVAL_MS,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    });
    expect(scheduler.isDue()).toBe(true);
    scheduler.start();
    scheduler.stop();

    expect(listQuotaBackups(backupDir)).toHaveLength(2);
  });

  it("reports a failed backup instead of throwing into the coordinator", () => {
    const errors: unknown[] = [];
    const scheduler = new QuotaBackupScheduler({
      databasePath: join(root, "missing.db"),
      backupDir: join(root, "backups"),
      onError: (error) => errors.push(error),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
    });

    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
    expect(errors).toHaveLength(1);
  });
});

describe("restoreQuotaDatabase", () => {
  it("replaces the database and archives what it replaced", async () => {
    const databasePath = join(root, "quota.db");
    const backupDir = join(root, "backups");
    const store = seedDatabase(databasePath, "before-backup");
    const backup = backupQuotaDatabase({ databasePath, backupDir });
    // A second scrape lands after the backup: restoring must lose exactly this.
    store.recordRaw({
      provider: "claude",
      scrapedAt: new Date().toISOString(),
      rawOutput: "after-backup",
    });
    store.close();
    expect(countScrapes(databasePath)).toBe(2);

    const result = await restoreQuotaDatabase({ backupPath: backup.path, databasePath });

    expect(countScrapes(databasePath)).toBe(1);
    expect(result.archivedTo).not.toBeNull();
    // The archive is what makes the drill reversible: it still has both rows.
    expect(countScrapes(result.archivedTo as string)).toBe(2);
    // No stale write-ahead log for a file that no longer exists.
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
  });

  it("leaves the live database in place when the backup is corrupt", async () => {
    const databasePath = join(root, "quota.db");
    const store = seedDatabase(databasePath);
    store.close();
    const corrupt = join(root, "corrupt.db");
    writeFileSync(corrupt, "not a database");

    await expect(restoreQuotaDatabase({ backupPath: corrupt, databasePath })).rejects.toThrow();
    expect(countScrapes(databasePath)).toBe(1);
  });

  it("refuses a backup whose schema is newer than this build supports", async () => {
    const databasePath = join(root, "quota.db");
    const store = seedDatabase(databasePath);
    const backup = backupQuotaDatabase({ databasePath, backupDir: join(root, "backups") });
    store.close();
    const future = new Database(backup.path);
    future.pragma(`user_version = ${QUOTA_SCHEMA_VERSION + 1}`);
    future.close();

    await expect(restoreQuotaDatabase({ backupPath: backup.path, databasePath })).rejects.toThrow(
      /newer than supported/
    );
  });

  it("refuses while a coordinator is still listening on the socket", async () => {
    const { createServer } = await import("node:net");
    const databasePath = join(root, "quota.db");
    const store = seedDatabase(databasePath);
    const backup = backupQuotaDatabase({ databasePath, backupDir: join(root, "backups") });
    store.close();

    const socketPath = join(root, "coordinator.sock");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
    try {
      await expect(
        restoreQuotaDatabase({ backupPath: backup.path, databasePath, socketPath })
      ).rejects.toThrow(/still listening/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("restores onto a host where the database is gone entirely", async () => {
    const databasePath = join(root, "quota.db");
    const store = seedDatabase(databasePath);
    const backup = backupQuotaDatabase({ databasePath, backupDir: join(root, "backups") });
    store.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }

    const result = await restoreQuotaDatabase({ backupPath: backup.path, databasePath });

    expect(result.archivedTo).toBeNull();
    expect(countScrapes(databasePath)).toBe(1);
  });
});
