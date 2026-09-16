import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { assertQuotaSchemaVersion, QUOTA_SCHEMA_VERSION } from "./schema-guard.js";

/** Daily cadence, as the coordinator design's backup section states it. */
export const QUOTA_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How many daily copies are kept. Older ones are pruned after each backup. */
export const DEFAULT_QUOTA_BACKUP_RETENTION = 14;

/**
 * Backup file names are `quota-<compact ISO instant>.db`, which sorts
 * lexicographically in time order — so retention can rank copies by name
 * without stat'ing them, and a directory listing reads chronologically.
 */
const BACKUP_NAME_RE = /^quota-(\d{8}T\d{6}Z)\.db$/;

/** The suffix a backup carries while it is still being written. */
const PARTIAL_SUFFIX = ".partial";

export interface QuotaBackupResult {
  /** Absolute path of the finished backup. */
  path: string;
  /** Size of the backup file in bytes. */
  bytes: number;
  /** How long `VACUUM INTO` took, in milliseconds. */
  durationMs: number;
  /** The instant the backup was taken, ISO-8601. */
  createdAt: string;
  /** Absolute paths pruned by retention as part of this backup. */
  pruned: string[];
}

function backupFileName(nowMs: number): string {
  // `2026-09-15T18:24:03.318Z` → `20260915T182403Z`: the same instant without
  // the colons, which are legal on this filesystem but not on every one a
  // backup directory might later be synced to.
  const iso = new Date(nowMs).toISOString();
  return `quota-${iso.slice(0, 19).replace(/[-:]/g, "")}Z.db`;
}

/** Existing backups, oldest first. Files this module did not write are ignored. */
export function listQuotaBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  return readdirSync(backupDir)
    .filter((name) => BACKUP_NAME_RE.test(name))
    .sort()
    .map((name) => join(backupDir, name));
}

/**
 * Keep the newest `retain` backups and delete the rest.
 *
 * Only files matching the backup naming pattern are considered, so an operator
 * who parks an ad-hoc copy or a restore archive in the same directory does not
 * have it deleted out from under them by the next scheduled backup.
 */
export function pruneQuotaBackups(
  backupDir: string,
  retain: number = DEFAULT_QUOTA_BACKUP_RETENTION
): string[] {
  if (!Number.isInteger(retain) || retain < 1) {
    throw new Error(`Backup retention must be a positive integer, got ${retain}`);
  }
  const backups = listQuotaBackups(backupDir);
  const excess = backups.slice(0, Math.max(0, backups.length - retain));
  for (const path of excess) rmSync(path, { force: true });
  return excess;
}

/**
 * Take one backup of the quota database with `VACUUM INTO`, then apply
 * retention.
 *
 * **Never a file copy.** The live database is WAL-mode, so copying the `.db`
 * without its `-wal` produces a silently truncated database — one that opens,
 * answers queries, and is missing every committed transaction still in the log.
 * `VACUUM INTO` reads through the same snapshot the connection sees and writes
 * a single self-contained file, which is also why the result carries no `-wal`
 * of its own and can be moved around as one file.
 *
 * The source connection is read-only. The service is the database's only
 * writer, and a backup has no business being the exception — read-only also
 * means a backup taken while the coordinator is running cannot block its
 * collection tick behind a write lock.
 *
 * The vacuum writes to `<name>.partial` and the finished file is renamed into
 * place, so a backup interrupted part-way leaves nothing that retention would
 * count as one of the 14 copies.
 *
 * **It runs on the coordinator's event loop, and that is deliberate.** better-
 * sqlite3 is synchronous, so for the vacuum's duration the listener answers
 * nothing and the collection tick cannot advance. A worker thread or child
 * process was considered and rejected: `VACUUM INTO` needs its own connection
 * either way, so the alternative is a second process holding the database open
 * to hide a pause that happens once a day and is bounded by the database's
 * retention-bound size — 205–390 ms across three samples against a 30-day,
 * 81,498,112-byte database in the rollback drill (see the operations runbook
 * for the transcript). A client whose read lands inside that pause sees a slow
 * response, not a failure: the client's request timeout is 5 s, an order of
 * magnitude above the observed pause, and a read that did miss is governed by
 * `hardStaleAfterMs`, a multiple of the tick. The on-demand `rusa quota-backup`
 * opens its own read-only connection in its own process and does not pause the
 * service at all.
 */
export function backupQuotaDatabase(opts: {
  databasePath: string;
  backupDir: string;
  retain?: number;
  now?: () => number;
}): QuotaBackupResult {
  const nowMs = (opts.now ?? Date.now)();
  if (!existsSync(opts.databasePath)) {
    throw new Error(`Quota database not found at ${opts.databasePath}`);
  }
  mkdirSync(opts.backupDir, { recursive: true });

  const finalPath = join(opts.backupDir, backupFileName(nowMs));
  const partialPath = `${finalPath}${PARTIAL_SUFFIX}`;
  rmSync(partialPath, { force: true });

  const db = new Database(opts.databasePath, { readonly: true, fileMustExist: true });
  const startedMs = Date.now();
  try {
    db.prepare("VACUUM INTO ?").run(partialPath);
  } finally {
    db.close();
  }
  const durationMs = Date.now() - startedMs;
  renameSync(partialPath, finalPath);

  const pruned = pruneQuotaBackups(opts.backupDir, opts.retain ?? DEFAULT_QUOTA_BACKUP_RETENTION);

  return {
    path: finalPath,
    bytes: statSync(finalPath).size,
    durationMs,
    createdAt: new Date(nowMs).toISOString(),
    pruned,
  };
}

/** True when something is accepting connections on `socketPath` right now. */
export function isCoordinatorListening(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const client = net.connect(socketPath);
    client.on("connect", () => {
      client.destroy();
      resolve(true);
    });
    client.on("error", () => {
      client.destroy();
      resolve(false);
    });
  });
}

export interface QuotaRestoreResult {
  /** The backup that was restored. */
  from: string;
  /** The database path now holding the restored data. */
  databasePath: string;
  /** Where the replaced database was archived, when one existed. */
  archivedTo: string | null;
  /**
   * How the replaced database was archived: `vacuum` when it opened and a
   * compact copy was taken, `rename` when it did not open and the raw file
   * (with its `-wal`/`-shm`) was moved aside instead, `null` when there was
   * nothing to archive.
   */
  archivedBy: "vacuum" | "rename" | null;
  /** How long the restore itself took, in milliseconds. */
  durationMs: number;
}

/** The suffix the restored copy carries while it is still being materialized. */
const RESTORE_PARTIAL_SUFFIX = ".restore-partial";

/** `integrity_check` and the schema guard, on a read-only open of `path`. */
function assertRestorableDatabase(path: string, what: string): void {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`${what} ${path} failed integrity_check: ${String(integrity)}`);
    }
    assertQuotaSchemaVersion(db, QUOTA_SCHEMA_VERSION);
  } finally {
    db.close();
  }
}

/**
 * Restore a backup over the coordinator's database.
 *
 * The order of operations is what makes this safe to run in the state an
 * operator actually restores in — a coordinator down, and quite possibly a live
 * database that is the reason for the restore:
 *
 * 1. **The service is down.** Restoring under a live coordinator would leave it
 *    holding a file handle to a database that is no longer the one on disk. A
 *    listener on the socket is the observable form of "still running", so this
 *    refuses on it.
 * 2. **The backup is readable and whole.** `PRAGMA integrity_check` and the
 *    quota schema guard run against the backup *before* anything else, so a
 *    corrupt or newer-schema copy fails while the database it would have
 *    replaced is still in place.
 * 3. **The restored copy is materialized and validated beside the live file,
 *    not over it.** `VACUUM INTO` writes `<db>.restore-partial`, which is then
 *    checked the same way as the backup — a full disk can leave a truncated
 *    file that exists — and only then is it installed with one `rename`. A
 *    failure anywhere up to that point leaves the configured database exactly
 *    as it was.
 * 4. **The replaced database is kept, even when it cannot be opened.** It is
 *    archived to `<db>.pre-restore-<stamp>Z.db` with the same `VACUUM INTO` the
 *    backup path uses; if that open or vacuum fails — the live file being
 *    corrupt is the likeliest reason anyone is restoring — the raw file and its
 *    `-wal`/`-shm` are renamed aside under the same archive name instead, so the
 *    bytes survive and the restore proceeds rather than being blocked by the
 *    very file it exists to replace. A drill that cannot be undone is not a
 *    drill.
 */
export async function restoreQuotaDatabase(opts: {
  backupPath: string;
  databasePath: string;
  socketPath?: string;
  now?: () => number;
}): Promise<QuotaRestoreResult> {
  const nowMs = (opts.now ?? Date.now)();
  if (!existsSync(opts.backupPath)) {
    throw new Error(`Backup not found at ${opts.backupPath}`);
  }
  if (opts.socketPath && (await isCoordinatorListening(opts.socketPath))) {
    throw new Error(
      `A quota coordinator is still listening at ${opts.socketPath}; stop it before restoring`
    );
  }
  assertRestorableDatabase(opts.backupPath, "Backup");

  const startedMs = Date.now();
  mkdirSync(dirname(opts.databasePath), { recursive: true });
  const partialPath = `${opts.databasePath}${RESTORE_PARTIAL_SUFFIX}`;
  rmSync(partialPath, { force: true });

  let archivedTo: string | null = null;
  let archivedBy: QuotaRestoreResult["archivedBy"] = null;
  try {
    // 3. Materialize beside the live file, then validate what was written.
    const source = new Database(opts.backupPath, { readonly: true, fileMustExist: true });
    try {
      source.prepare("VACUUM INTO ?").run(partialPath);
    } finally {
      source.close();
    }
    assertRestorableDatabase(partialPath, "Restored copy");

    // 4. Archive the live database, by vacuum when it opens and by rename
    //    when it does not.
    if (existsSync(opts.databasePath)) {
      const stamp = new Date(nowMs).toISOString().slice(0, 19).replace(/[-:]/g, "");
      archivedTo = `${opts.databasePath}.pre-restore-${stamp}Z.db`;
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${archivedTo}${suffix}`, { force: true });
      try {
        const live = new Database(opts.databasePath, { readonly: true, fileMustExist: true });
        try {
          live.prepare("VACUUM INTO ?").run(archivedTo);
        } finally {
          live.close();
        }
        archivedBy = "vacuum";
        // The archive above holds everything, so these can go: a `-wal` left
        // beside a replaced database is a log for a file that no longer
        // exists, and SQLite would try to recover it into the restored one.
        for (const suffix of ["", "-wal", "-shm"]) {
          rmSync(`${opts.databasePath}${suffix}`, { force: true });
        }
      } catch {
        // Unreadable live database: keep the raw bytes. The `-wal`/`-shm` move
        // with it under the archive name, so whatever SQLite can still
        // recover from them stays recoverable there — and nothing is left
        // beside the restored file for it to replay into.
        rmSync(archivedTo, { force: true });
        for (const suffix of ["", "-wal", "-shm"]) {
          const livePart = `${opts.databasePath}${suffix}`;
          if (existsSync(livePart)) renameSync(livePart, `${archivedTo}${suffix}`);
        }
        archivedBy = "rename";
      }
    }

    // Atomic install: the configured path goes from the old file to the
    // validated new one in one step, never through "absent".
    renameSync(partialPath, opts.databasePath);
  } finally {
    rmSync(partialPath, { force: true });
  }

  return {
    from: opts.backupPath,
    databasePath: opts.databasePath,
    archivedTo,
    archivedBy,
    durationMs: Date.now() - startedMs,
  };
}

export interface QuotaBackupSchedulerOptions {
  databasePath: string;
  backupDir: string;
  retain?: number;
  intervalMs?: number;
  now?: () => number;
  onBackup?: (result: QuotaBackupResult) => void;
  onError?: (error: unknown) => void;
  /** Timer seams for tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/**
 * The coordinator's daily backup timer.
 *
 * The deadline is a property of the backup directory, not of the process: the
 * next backup is due one cadence after the newest existing one, and a restart
 * neither resets that deadline nor brings it forward.
 *
 * - On start it backs up immediately only when the newest backup is already a
 *   cadence old (or there is none). Backing up unconditionally at boot would
 *   mean a service that restarts five times in five minutes — which the unit's
 *   start limit explicitly tolerates — evicting five of the fourteen daily
 *   copies with five copies of the same minute.
 * - Otherwise the first timer is set for the *remaining* age, not a full
 *   cadence: a 23-hour-old backup at start means a backup in one hour, not in
 *   twenty-five, and repeated restarts inside the window cannot postpone the
 *   deadline because every one of them computes it from the same file.
 *
 * After that first backup the timer settles into the daily cadence.
 */
export class QuotaBackupScheduler {
  private readonly intervalMs: number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private timer: unknown = null;

  constructor(readonly options: QuotaBackupSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? QUOTA_BACKUP_INTERVAL_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  }

  /** Milliseconds until the next backup is due; zero or less when it is due now. */
  msUntilDue(): number {
    const backups = listQuotaBackups(this.options.backupDir);
    const newest = backups.at(-1);
    if (!newest) return 0;
    const nowMs = (this.options.now ?? Date.now)();
    return statSync(newest).mtimeMs + this.intervalMs - nowMs;
  }

  /** True when no backup exists yet, or the newest one is a cadence old. */
  isDue(): boolean {
    return this.msUntilDue() <= 0;
  }

  /** Take a backup now, reporting rather than throwing on failure. */
  runOnce(): QuotaBackupResult | null {
    try {
      const result = backupQuotaDatabase({
        databasePath: this.options.databasePath,
        backupDir: this.options.backupDir,
        retain: this.options.retain,
        now: this.options.now,
      });
      this.options.onBackup?.(result);
      return result;
    } catch (error) {
      // A failed backup must not take the coordinator down with it: the service
      // is still able to publish, and the operator needs the record more than
      // the process needs to exit.
      this.options.onError?.(error);
      return null;
    }
  }

  start(): void {
    const remainingMs = this.msUntilDue();
    if (remainingMs <= 0) {
      this.runOnce();
      this.schedule(this.intervalMs);
    } else {
      this.schedule(remainingMs);
    }
  }

  private schedule(delayMs: number): void {
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.runOnce();
      // A failed backup leaves the newest file where it was, so the next
      // attempt is a cadence from now rather than immediately: a full disk is
      // not improved by retrying it every tick.
      this.schedule(this.intervalMs);
    }, delayMs);
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }
}
