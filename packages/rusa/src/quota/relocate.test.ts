import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderQuotaSnapshot, QuotaWindowKind } from "../mcp/quota-mcp.js";
import {
  assertBlockingDirectory,
  BLOCKING_DIRECTORY_MODE,
  DEFAULT_OLD_QUOTA_DB_NAME,
  DEFAULT_RELOCATED_QUOTA_DB_NAME,
  relocateQuotaDatabase,
} from "./relocate.js";
import { QUOTA_SCHEMA_VERSION } from "./schema-guard.js";
import { SharedQuotaStore } from "./shared-store.js";

const testDirs: string[] = [];

function makeTestDir(prefix = "rusa-quota-relocate-"): string {
  const dir = join(tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  testDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function recordObservation(
  store: SharedQuotaStore,
  provider: string,
  scrapedAt: string,
  percentLeft: number,
  resetAtIso: string,
  kind: QuotaWindowKind = "weekly",
  label = `${kind} limit`
): string {
  const state: ProviderQuotaSnapshot = {
    provider,
    status: percentLeft <= 0 ? "exhausted" : "available",
    scrapedAt,
    limits: [
      {
        label,
        kind,
        scope: "provider",
        percentLeft,
        resetAtIso,
      },
    ],
  };
  const id = store.recordRaw({ provider, scrapedAt, rawOutput: "raw evidence" });
  store.recordParsed(id, state, state);
  return id;
}

describe("Quota database relocation (§8.1, §8.2, §8.3)", () => {
  it("renames quota.db to quota-coordinator.db and fences the old path with an empty 0o700 directory", () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);

    // A pre-service file: a build older than #363 never stamped user_version.
    const initialStore = new SharedQuotaStore(oldDbPath);
    recordObservation(
      initialStore,
      "claude",
      "2030-01-01T00:00:00.000Z",
      90,
      "2030-01-08T00:00:00.000Z"
    );
    initialStore.db.pragma("user_version = 0");
    initialStore.close();

    const result = relocateQuotaDatabase({
      oldDatabasePath: oldDbPath,
      newDatabasePath: newDbPath,
    });
    expect(result).toEqual({ renamed: true, placeholderCreated: true });

    // The rename is the only state transfer; relocation itself stamps nothing.
    expect(statSync(newDbPath).isFile()).toBe(true);
    const newDb = new Database(newDbPath, { readonly: true });
    expect(newDb.pragma("user_version", { simple: true })).toBe(0);
    newDb.close();

    const oldStat = statSync(oldDbPath);
    expect(oldStat.isDirectory()).toBe(true);
    expect(oldStat.mode & 0o777).toBe(BLOCKING_DIRECTORY_MODE);
    expect(() => assertBlockingDirectory(oldDbPath)).not.toThrow();

    // The service opens the relocated file, finds every row, and is the one
    // that stamps the header (§8.1).
    const relocatedStore = new SharedQuotaStore(newDbPath);
    expect(relocatedStore.getLatestSnapshot("claude")?.provider).toBe("claude");
    expect(relocatedStore.db.pragma("user_version", { simple: true })).toBe(QUOTA_SCHEMA_VERSION);
    relocatedStore.close();
  });

  it("refuses an active WAL, then checkpoints it before the atomic main-file rename", () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);

    // Keep a real read transaction open over WAL-backed state. A stage-3 flip
    // must fail before changing any paths rather than rename the main file and
    // strand committed WAL state at the old name.
    const db = new Database(oldDbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.prepare("CREATE TABLE dummy (id INTEGER PRIMARY KEY, val TEXT)").run();
    db.prepare("INSERT INTO dummy VALUES (1, 'active')").run();
    const reader = new Database(oldDbPath);
    reader.exec("BEGIN");
    reader.prepare("SELECT val FROM dummy").get();

    expect(existsSync(`${oldDbPath}-wal`)).toBe(true);
    expect(existsSync(`${oldDbPath}-shm`)).toBe(true);

    expect(() =>
      relocateQuotaDatabase({ oldDatabasePath: oldDbPath, newDatabasePath: newDbPath })
    ).toThrow(/active readers or writers/);
    expect(statSync(oldDbPath).isFile()).toBe(true);
    expect(existsSync(newDbPath)).toBe(false);

    reader.exec("COMMIT");
    reader.close();
    relocateQuotaDatabase({ oldDatabasePath: oldDbPath, newDatabasePath: newDbPath });
    db.close();

    const relocated = new Database(newDbPath, { readonly: true });
    expect(relocated.prepare("SELECT val FROM dummy WHERE id = 1").get()).toEqual({
      val: "active",
    });
    relocated.close();
    expect(statSync(oldDbPath).isDirectory()).toBe(true);
  });

  it("is idempotent when called repeatedly on an already-relocated database", () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);

    const store = new SharedQuotaStore(oldDbPath);
    recordObservation(store, "claude", "2030-01-01T00:00:00.000Z", 95, "2030-01-08T00:00:00.000Z");
    store.close();

    const first = relocateQuotaDatabase({ oldDatabasePath: oldDbPath, newDatabasePath: newDbPath });
    expect(first).toEqual({ renamed: true, placeholderCreated: true });

    const second = relocateQuotaDatabase({
      oldDatabasePath: oldDbPath,
      newDatabasePath: newDbPath,
    });
    expect(second).toEqual({ renamed: false, placeholderCreated: false });
    expect(statSync(oldDbPath).isDirectory()).toBe(true);
    expect(statSync(newDbPath).isFile()).toBe(true);
  });

  it("refuses to choose when both the legacy and the relocated file exist", () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);
    for (const path of [oldDbPath, newDbPath]) {
      const db = new Database(path);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      db.close();
    }

    // Stage 0–2 run the service against a copy beside the live file. A flip
    // that finds both must not guess which one is authoritative.
    expect(() =>
      relocateQuotaDatabase({ oldDatabasePath: oldDbPath, newDatabasePath: newDbPath })
    ).toThrow(/both .* exist/);
    expect(statSync(oldDbPath).isFile()).toBe(true);
    expect(statSync(newDbPath).isFile()).toBe(true);
  });

  it("refuses a flip with nothing at either path instead of fencing a fresh install", () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);

    expect(() =>
      relocateQuotaDatabase({ oldDatabasePath: oldDbPath, newDatabasePath: newDbPath })
    ).toThrow(/Nothing to relocate/);
    expect(existsSync(oldDbPath)).toBe(false);
    expect(existsSync(newDbPath)).toBe(false);
  });

  it("only fences the old path when the operator already renamed the file by hand", () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);
    const store = new SharedQuotaStore(oldDbPath);
    recordObservation(store, "claude", "2030-01-01T00:00:00.000Z", 95, "2030-01-08T00:00:00.000Z");
    store.close();
    renameSync(oldDbPath, newDbPath);

    const result = relocateQuotaDatabase({
      oldDatabasePath: oldDbPath,
      newDatabasePath: newDbPath,
    });
    expect(result).toEqual({ renamed: false, placeholderCreated: true });
    expect(statSync(oldDbPath).isDirectory()).toBe(true);
    expect(statSync(newDbPath).isFile()).toBe(true);
  });

  it("rolls back by hand per §8.3 and leaves only the header stamp behind (§8.1)", () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);

    const store = new SharedQuotaStore(oldDbPath);
    recordObservation(store, "claude", "2030-01-01T00:00:00.000Z", 85, "2030-01-08T00:00:00.000Z");
    store.close();
    relocateQuotaDatabase({ oldDatabasePath: oldDbPath, newDatabasePath: newDbPath });

    // The service ran against the relocated file and stamped it.
    const served = new SharedQuotaStore(newDbPath);
    served.close();

    // §8.3 rollback: stop the service, remove the directory, rename back. The
    // placeholder is empty by construction, so a non-recursive rmdir is enough
    // and anything else at the old path makes the rollback refuse.
    assertBlockingDirectory(oldDbPath);
    rmdirSync(oldDbPath);
    renameSync(newDbPath, oldDbPath);

    expect(statSync(oldDbPath).isFile()).toBe(true);
    expect(existsSync(newDbPath)).toBe(false);
    const restored = new Database(oldDbPath, { readonly: true });
    expect(restored.pragma("user_version", { simple: true })).toBe(QUOTA_SCHEMA_VERSION);
    expect(restored.prepare("SELECT COUNT(*) AS n FROM quota_observations").get()).toEqual({
      n: 1,
    });
    restored.close();
  });

  it("does not mistake a populated or differently-moded directory for its placeholder", () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);
    const store = new SharedQuotaStore(oldDbPath);
    recordObservation(store, "claude", "2030-01-01T00:00:00.000Z", 85, "2030-01-08T00:00:00.000Z");
    store.close();
    relocateQuotaDatabase({ oldDatabasePath: oldDbPath, newDatabasePath: newDbPath });

    writeFileSync(join(oldDbPath, "must-not-delete"), "operator data");
    expect(() => assertBlockingDirectory(oldDbPath)).toThrow(/non-empty directory/);
    expect(() =>
      relocateQuotaDatabase({ oldDatabasePath: oldDbPath, newDatabasePath: newDbPath })
    ).toThrow(/non-empty directory/);
    expect(existsSync(join(oldDbPath, "must-not-delete"))).toBe(true);
    expect(statSync(newDbPath).isFile()).toBe(true);
  });
});

function seedLegacyDatabase(path: string): void {
  const store = new SharedQuotaStore(path);
  recordObservation(store, "claude", "2030-01-01T00:00:00.000Z", 90, "2030-01-08T00:00:00.000Z");
  store.close();
}

describe("Design §10 Criterion 8: Old-writer exclusion is mechanical", () => {
  it("fails at open with SQLITE_CANTOPEN, writes nothing, and returns early without probing", async () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);

    // 1. Flip a real legacy file so the fence stands at oldDbPath
    seedLegacyDatabase(oldDbPath);
    relocateQuotaDatabase({
      oldDatabasePath: oldDbPath,
      newDatabasePath: newDbPath,
    });

    expect(existsSync(oldDbPath)).toBe(true);
    expect(statSync(oldDbPath).isDirectory()).toBe(true);

    // 2. An old build contains NO service awareness and attempts to open oldDbPath as SQLite db:
    // Better-SQLite3 throws SqliteError with code SQLITE_CANTOPEN
    let caughtError: unknown = null;
    let oldStore: Database.Database | null = null;
    try {
      oldStore = new Database(oldDbPath);
    } catch (err) {
      caughtError = err;
    }

    expect(oldStore).toBeNull();
    expect(caughtError).toBeDefined();
    expect((caughtError as { code?: string })?.code).toBe("SQLITE_CANTOPEN");
    expect((caughtError as Error).message).toContain("unable to open database file");

    // 3. Assert nothing was written to the directory placeholder
    const dirContents = readdirSync(oldDbPath);
    expect(dirContents).toHaveLength(0);

    // 4. Assert early return in old build's throttle tick:
    // In start.ts (the early-return region prior to coordinator):
    // if (!quotaThrottleEnabled || !sharedQuotaStore) return;
    // Because open failed, sharedQuotaStore is null, so tickQuotaThrottle returns early
    // without executing any probe.
    const probeMock = vi.fn().mockResolvedValue({ status: "available" });
    const simulatedOldTickQuotaThrottle = async (
      quotaThrottleEnabled: boolean,
      store: Database.Database | null
    ) => {
      // Direct early-return region from start.ts
      if (!quotaThrottleEnabled || !store) return;
      await probeMock();
    };

    await simulatedOldTickQuotaThrottle(true, oldStore);
    expect(probeMock).toHaveBeenCalledTimes(0);
  });

  // This spawns a script with the shape of the pre-#482 instance — open the
  // file, and skip the tick when there is no store — not a real prior build.
  // What it proves is that the fence needs no cooperation from the code behind
  // it: an unrelated process with its own better-sqlite3 handle gets
  // SQLITE_CANTOPEN and leaves nothing behind. Running an actual pre-service
  // checkout would need a second install and build inside the test.
  it("excludes a separate process that opens the old path with no service awareness", () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);

    seedLegacyDatabase(oldDbPath);
    relocateQuotaDatabase({
      oldDatabasePath: oldDbPath,
      newDatabasePath: newDbPath,
    });

    const script = `
      const Database = require("better-sqlite3");
      const fs = require("node:fs");

      let probeExecuted = false;
      let store = null;
      let sqliteCantOpen = false;

      try {
        store = new Database(${JSON.stringify(oldDbPath)});
      } catch (err) {
        if (err.code === "SQLITE_CANTOPEN") {
          sqliteCantOpen = true;
        }
      }

      if (!sqliteCantOpen) {
        console.error("Expected SQLITE_CANTOPEN error");
        process.exit(1);
      }

      // Old start.ts early-return: if (!quotaThrottleEnabled || !sharedQuotaStore) return;
      const quotaThrottleEnabled = true;
      if (!quotaThrottleEnabled || !store) {
        // Returned early!
      } else {
        probeExecuted = true;
      }

      if (probeExecuted) {
        console.error("Probe was unexpectedly executed!");
        process.exit(2);
      }

      const files = fs.readdirSync(${JSON.stringify(oldDbPath)});
      if (files.length > 0) {
        console.error("Files were written into placeholder directory: " + files.join(", "));
        process.exit(3);
      }

      process.exit(0);
    `;

    const res = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
  });
});

describe("Design §10 Criterion 10: Continuity across the flip", () => {
  interface QuotaObservationRecord {
    rowid: number;
    provider: string;
    kind: string;
    observed_slot: number;
    label: string;
    observed_at: string;
    percent_left: number;
    reset_at_iso: string;
    window_ms: number;
    processed: number;
    controller_error: number | null;
    controller_derivative: number | null;
    controller_integral: number | null;
    uncapped_interval_seconds: number | null;
    interval_seconds: number | null;
  }

  it("first post-flip step reads pre-flip controller state and rewrites zero pre-flip observation rows", () => {
    const root = makeTestDir();
    const oldDbPath = join(root, DEFAULT_OLD_QUOTA_DB_NAME);
    const newDbPath = join(root, DEFAULT_RELOCATED_QUOTA_DB_NAME);

    // 1. Populate initial pre-flip store with controller state
    const preFlipStore = new SharedQuotaStore(oldDbPath);
    preFlipStore.configureController({ maxIntervalSeconds: 36000 });

    const resetAt = "2030-01-08T00:00:00.000Z";
    recordObservation(preFlipStore, "claude", "2030-01-01T00:00:00.000Z", 90, resetAt);
    recordObservation(preFlipStore, "claude", "2030-01-01T01:00:00.000Z", 80, resetAt);

    // Inspect pre-flip observations
    const preFlipRows = preFlipStore.db
      .prepare(
        `SELECT rowid, provider, kind, observed_slot, label, observed_at, percent_left,
                reset_at_iso, window_ms, processed, controller_error, controller_derivative,
                controller_integral, uncapped_interval_seconds, interval_seconds
         FROM quota_observations
         ORDER BY rowid ASC`
      )
      .all() as QuotaObservationRecord[];

    expect(preFlipRows.length).toBeGreaterThanOrEqual(2);
    const lastPreFlipRow = preFlipRows[preFlipRows.length - 1];

    // Assert pre-flip controller state is non-zero
    expect(lastPreFlipRow.controller_integral).not.toBeNull();
    expect(lastPreFlipRow.controller_integral).toBeGreaterThan(0);
    expect(lastPreFlipRow.controller_derivative).not.toBeNull();
    expect(lastPreFlipRow.controller_derivative).not.toBe(0);

    preFlipStore.close();

    // Take an immutable deep copy of all pre-flip rows to verify they are never touched
    const preFlipRowsSnapshot = JSON.parse(JSON.stringify(preFlipRows)) as QuotaObservationRecord[];

    // 2. Run the flip: relocate database
    const relocationResult = relocateQuotaDatabase({
      oldDatabasePath: oldDbPath,
      newDatabasePath: newDbPath,
    });
    expect(relocationResult.renamed).toBe(true);

    // 3. Open post-flip database as the service does
    const postFlipStore = new SharedQuotaStore(newDbPath);
    postFlipStore.configureController({ maxIntervalSeconds: 36000 });

    // 4. Run first post-flip controller step
    recordObservation(postFlipStore, "claude", "2030-01-01T02:00:00.000Z", 75, resetAt);

    // 5. Query all observation rows post-flip
    const postFlipRows = postFlipStore.db
      .prepare(
        `SELECT rowid, provider, kind, observed_slot, label, observed_at, percent_left,
                reset_at_iso, window_ms, processed, controller_error, controller_derivative,
                controller_integral, uncapped_interval_seconds, interval_seconds
         FROM quota_observations
         ORDER BY rowid ASC`
      )
      .all() as QuotaObservationRecord[];

    // Exactly one row added for the new observation
    expect(postFlipRows.length).toBe(preFlipRowsSnapshot.length + 1);

    const postFlipNewRow = postFlipRows[postFlipRows.length - 1];
    expect(postFlipNewRow.observed_at).toBe("2030-01-01T02:00:00.000Z");

    expect(lastPreFlipRow.controller_integral).not.toBeNull();
    const lastIntegral = lastPreFlipRow.controller_integral ?? 0;
    expect(postFlipNewRow.controller_integral).not.toBe(0);
    expect(postFlipNewRow.controller_integral).toBeGreaterThan(lastIntegral);
    // Derivative retains filter memory from pre-flip:
    expect(postFlipNewRow.controller_derivative).not.toBe(0);

    // CRITICAL REQUIREMENT: Assert NO pre-flip quota_observations row was rewritten!
    for (let i = 0; i < preFlipRowsSnapshot.length; i++) {
      const original = preFlipRowsSnapshot[i];
      const current = postFlipRows[i];
      expect(current).toEqual(original);
    }

    postFlipStore.close();
  });
});
