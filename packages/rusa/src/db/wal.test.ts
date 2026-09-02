import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { SharedQuotaStore } from "../quota/shared-store.js";
import { closeDb, initDb } from "./index.js";
import { widenToWal } from "./wal.js";

const roots: string[] = [];

afterEach(() => {
  closeDb();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A rollback-journal database, which is what makes an open have to convert. */
function writeLegacyDatabase(path: string): void {
  const legacy = new Database(path);
  // Any table will do: the marker also gives the SHARED lock holder below
  // something to read, since a shared lock needs a statement to hold it open.
  legacy.exec("CREATE TABLE legacy_marker (a INTEGER)");
  legacy.close();
}

interface LockHolder {
  holding: Promise<void>;
  completed: Promise<void>;
}

/**
 * Holds a lock on `databasePath` from another process for `holdMs`.
 *
 * The two states differ in exactly the way the conversion cares about.
 * RESERVED is what a second opener holds partway through its own legacy->WAL
 * conversion, and it is the one state where SQLite skips the busy handler
 * entirely — the concurrent-conversion race in deterministic form, without
 * depending on scheduler luck. SHARED is the state the handler *does* cover,
 * so a peer holding it makes a single pragma sit for the connection's whole
 * `busy_timeout`; that is what the budget-boundary test needs.
 */
function startLockHolder(
  databasePath: string,
  holdMs: number,
  lock: "reserved" | "shared"
): LockHolder {
  const begin =
    lock === "reserved" ? "BEGIN IMMEDIATE" : "BEGIN; SELECT count(*) FROM legacy_marker;";
  const script = `
    import Database from "better-sqlite3";
    const db = new Database(process.argv[1]);
    db.exec(process.argv[3]);
    process.stdout.write("holding\\n");
    setTimeout(() => {
      db.exec("COMMIT");
      db.close();
    }, Number(process.argv[2]));
  `;
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-transform-types",
      "--input-type=module",
      "-e",
      script,
      databasePath,
      String(holdMs),
      begin,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  let output = "";
  let errorOutput = "";
  let holdingResolve: (() => void) | undefined;
  let holdingReject: ((error: Error) => void) | undefined;
  const holding = new Promise<void>((resolve, reject) => {
    holdingResolve = resolve;
    holdingReject = reject;
  });
  const completed = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => {
      holdingReject?.(error);
      reject(error);
    });
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        const error = new Error(`${lock} holder exited ${code}: ${errorOutput || output}`);
        holdingReject?.(error);
        reject(error);
      }
    });
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes("holding\n")) holdingResolve?.();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errorOutput += chunk.toString();
  });
  return { holding, completed };
}

describe("legacy to WAL conversion", () => {
  it("waits out an opener that is already mid-conversion instead of failing the open", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-wal-race-"));
    roots.push(root);
    const path = join(root, "shared.db");
    writeLegacyDatabase(path);

    // `busy_timeout` cannot cover this: against a peer holding RESERVED,
    // SQLite returns SQLITE_BUSY in about a millisecond rather than waiting,
    // so the opener has to come back on its own.
    const peer = startLockHolder(path, 500, "reserved");
    await peer.holding;

    const store = new SharedQuotaStore(path);
    try {
      expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    } finally {
      store.close();
    }
    await peer.completed;
  }, 20_000);

  it("waits out the same contention when the instance database opens", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-instance-db-wal-race-"));
    roots.push(root);
    mkdirSync(join(root, "data"), { recursive: true });
    const path = join(root, "data", "mesh.db");
    // No marker table here, unlike the shared database above: the migration
    // runner reads "any table already exists" as "this database predates the
    // migration system" and skips the initial schema, so a marker would fail
    // the migrations rather than the conversion. A file with no tables is
    // still a rollback-journal file, which is all the conversion needs.
    new Database(path).close();

    // The instance database is raced by a narrower population than the shared
    // one — two processes opening the same instance's still-legacy file at the
    // same instant — but the failure is identical, so the site gets the same
    // deterministic peer. With the bare pragma this open throws SQLITE_BUSY.
    const peer = startLockHolder(path, 500, "reserved");
    await peer.holding;

    const db = initDb(root);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    await peer.completed;
  }, 20_000);

  it("spends one conversion budget in total, not one per attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-shared-quota-wal-budget-"));
    roots.push(root);
    const path = join(root, "shared.db");
    writeLegacyDatabase(path);

    // SHARED is the state SQLite's busy handler *does* cover, so one pragma
    // against this peer sits for the connection's whole `busy_timeout`.
    const peer = startLockHolder(path, 4_000, "shared");
    await peer.holding;

    const db = new Database(path);
    // A connection that already carries the ordinary budget, as the store's
    // did before the conversion was given a budget of its own. The conversion
    // must not inherit it: uncapped, this single attempt alone would take the
    // full 3s, fifteen times the budget it was asked for.
    db.pragma("busy_timeout = 3000");
    const started = Date.now();
    try {
      expect(() => widenToWal(db, 200)).toThrow(/database is locked/);
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      db.close();
    }
    await peer.completed;
  }, 30_000);

  it("leaves the connection's busy_timeout as it found it", () => {
    const root = mkdtempSync(join(tmpdir(), "rusa-wal-busy-timeout-"));
    roots.push(root);
    const path = join(root, "legacy.db");
    writeLegacyDatabase(path);

    // The conversion drives `busy_timeout` down as its budget is spent, so a
    // caller that never asked for a timeout at all would otherwise inherit
    // whatever was left of one. Both call sites open a connection they keep.
    const db = new Database(path);
    db.pragma("busy_timeout = 1234");
    try {
      widenToWal(db);
      expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(db.pragma("busy_timeout", { simple: true })).toBe(1234);
    } finally {
      db.close();
    }
  });
});
