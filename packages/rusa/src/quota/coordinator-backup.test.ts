import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  /** Captures the delays the scheduler asks for instead of arming real timers. */
  function timerSeam() {
    const delays: number[] = [];
    let pending: (() => void) | null = null;
    return {
      delays,
      fire: () => {
        const fn = pending;
        pending = null;
        fn?.();
      },
      seam: {
        setTimeoutFn: (fn: () => void, ms: number) => {
          delays.push(ms);
          pending = fn;
          return delays.length;
        },
        clearTimeoutFn: () => {
          pending = null;
        },
      },
    };
  }

  /** A seeded database with one backup, aged to `ageMs` old. */
  function seedWithAgedBackup(ageMs: number) {
    const databasePath = join(root, "quota.db");
    const backupDir = join(root, "backups");
    const store = seedDatabase(databasePath);
    const first = backupQuotaDatabase({ databasePath, backupDir });
    store.close();
    const aged = (Date.now() - ageMs) / 1000;
    utimesSync(first.path, aged, aged);
    return { databasePath, backupDir, first };
  }

  it("does not back up on start when a backup is younger than the cadence", () => {
    const { databasePath, backupDir } = seedWithAgedBackup(0);
    const timers = timerSeam();

    const scheduler = new QuotaBackupScheduler({ databasePath, backupDir, ...timers.seam });
    scheduler.start();
    scheduler.stop();

    // A restart loop must not be able to evict the retention window with copies
    // of the same minute.
    expect(listQuotaBackups(backupDir)).toHaveLength(1);
  });

  it("schedules the first backup for the age remaining, not a whole cadence", () => {
    // 23 hours old: the next backup is due in one hour. Arming a fresh 24-hour
    // timer here is what would turn a restart into a 47-hour gap.
    const hourMs = 60 * 60 * 1000;
    const { databasePath, backupDir } = seedWithAgedBackup(23 * hourMs);
    const timers = timerSeam();

    const scheduler = new QuotaBackupScheduler({ databasePath, backupDir, ...timers.seam });
    scheduler.start();
    scheduler.stop();

    expect(timers.delays).toHaveLength(1);
    expect(timers.delays[0]).toBeGreaterThan(hourMs - 60_000);
    expect(timers.delays[0]).toBeLessThanOrEqual(hourMs);
  });

  it("cannot be postponed by restarting, because the deadline is the file's", () => {
    const hourMs = 60 * 60 * 1000;
    const { databasePath, backupDir } = seedWithAgedBackup(20 * hourMs);
    const startedMs = Date.now();

    // Three restarts spread across the window. Each one recomputes the deadline
    // from the same backup file, so the wait shrinks as the file ages instead
    // of resetting.
    const delays = [0, 1 * hourMs, 3 * hourMs].map((elapsedMs) => {
      const timers = timerSeam();
      const scheduler = new QuotaBackupScheduler({
        databasePath,
        backupDir,
        now: () => startedMs + elapsedMs,
        ...timers.seam,
      });
      scheduler.start();
      scheduler.stop();
      return timers.delays[0];
    });

    expect(delays[0]).toBeGreaterThan(delays[1]);
    expect(delays[1]).toBeGreaterThan(delays[2]);
    // Still one backup — none of the restarts took one — and the last restart
    // is waiting an hour, not a day.
    expect(listQuotaBackups(backupDir)).toHaveLength(1);
    expect(delays[2]).toBeLessThanOrEqual(hourMs);
  });

  it("backs up on start once the newest backup is a cadence old", () => {
    const { databasePath, backupDir } = seedWithAgedBackup(QUOTA_BACKUP_INTERVAL_MS + 1000);
    const timers = timerSeam();

    const scheduler = new QuotaBackupScheduler({
      databasePath,
      backupDir,
      // A day later, so the new backup carries its own timestamped name rather
      // than colliding with the one taken a moment ago in this test.
      now: () => Date.now() + QUOTA_BACKUP_INTERVAL_MS,
      ...timers.seam,
    });
    expect(scheduler.isDue()).toBe(true);
    scheduler.start();
    scheduler.stop();

    expect(listQuotaBackups(backupDir)).toHaveLength(2);
    // And then settles into the daily cadence.
    expect(timers.delays).toEqual([QUOTA_BACKUP_INTERVAL_MS]);
  });

  it("settles into the daily cadence after the first backup fires", () => {
    const hourMs = 60 * 60 * 1000;
    const { databasePath, backupDir } = seedWithAgedBackup(23 * hourMs);
    const timers = timerSeam();

    const scheduler = new QuotaBackupScheduler({
      databasePath,
      backupDir,
      now: () => Date.now() + QUOTA_BACKUP_INTERVAL_MS,
      ...timers.seam,
    });
    scheduler.start();
    timers.fire();
    scheduler.stop();

    expect(listQuotaBackups(backupDir)).toHaveLength(2);
    expect(timers.delays[1]).toBe(QUOTA_BACKUP_INTERVAL_MS);
  });

  it("reports a failed backup instead of throwing into the coordinator", () => {
    const errors: unknown[] = [];
    const timers = timerSeam();
    const scheduler = new QuotaBackupScheduler({
      databasePath: join(root, "missing.db"),
      backupDir: join(root, "backups"),
      onError: (error) => errors.push(error),
      ...timers.seam,
    });

    expect(() => scheduler.start()).not.toThrow();
    scheduler.stop();
    expect(errors).toHaveLength(1);
    // The failure does not become a retry loop.
    expect(timers.delays).toEqual([QUOTA_BACKUP_INTERVAL_MS]);
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
    expect(result.archivedBy).toBe("vacuum");
    // The archive is what makes the drill reversible: it still has both rows.
    expect(countScrapes(result.archivedTo as string)).toBe(2);
    // No stale write-ahead log for a file that no longer exists.
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
  });

  it("never leaves the configured path without a database on the way through", async () => {
    const databasePath = join(root, "quota.db");
    const store = seedDatabase(databasePath);
    const backup = backupQuotaDatabase({ databasePath, backupDir: join(root, "backups") });
    store.close();

    const result = await restoreQuotaDatabase({ backupPath: backup.path, databasePath });

    // The restored copy is built beside the live file and installed with one
    // rename, so the scratch file is gone and nothing of it is left to find.
    expect(existsSync(`${databasePath}.restore-partial`)).toBe(false);
    expect(countScrapes(result.databasePath)).toBe(1);
  });

  it("preserves a live database it cannot open, rather than refusing to restore", async () => {
    // The live file being unreadable is the likeliest reason anyone restores.
    // Archiving it by vacuum is impossible; losing it is not acceptable either.
    const databasePath = join(root, "quota.db");
    const store = seedDatabase(databasePath);
    const backup = backupQuotaDatabase({ databasePath, backupDir: join(root, "backups") });
    store.close();
    writeFileSync(databasePath, "corrupted beyond opening");
    writeFileSync(`${databasePath}-wal`, "stale log");

    const result = await restoreQuotaDatabase({ backupPath: backup.path, databasePath });

    expect(result.archivedBy).toBe("rename");
    expect(countScrapes(databasePath)).toBe(1);
    // The corrupt bytes survive under the archive name, with their log beside
    // them and nothing left to replay into the restored database.
    expect(readFileSync(result.archivedTo as string, "utf8")).toBe("corrupted beyond opening");
    expect(readFileSync(`${result.archivedTo}-wal`, "utf8")).toBe("stale log");
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
  });

  it("leaves the live database untouched when the restored copy cannot be written", async () => {
    // Stands in for a full disk: the copy fails part-way through being
    // materialized, after the backup has already validated.
    const dbDir = join(root, "db");
    mkdirSync(dbDir, { recursive: true });
    const databasePath = join(dbDir, "quota.db");
    const store = seedDatabase(databasePath, "still-here");
    const backup = backupQuotaDatabase({ databasePath, backupDir: join(root, "backups") });
    store.close();

    chmodSync(dbDir, 0o555);
    try {
      await expect(
        restoreQuotaDatabase({ backupPath: backup.path, databasePath })
      ).rejects.toThrow();
    } finally {
      chmodSync(dbDir, 0o755);
    }

    // The configured path still holds the original database — not a truncated
    // copy, not nothing.
    expect(existsSync(databasePath)).toBe(true);
    expect(countScrapes(databasePath)).toBe(1);
    expect(existsSync(`${databasePath}.restore-partial`)).toBe(false);
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
