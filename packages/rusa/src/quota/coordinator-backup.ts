import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
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
  /** How long the restore itself took, in milliseconds. */
  durationMs: number;
}

/**
 * Restore a backup over the coordinator's database.
 *
 * Three things have to be true before anything is replaced, and each is checked
 * rather than assumed:
 *
 * 1. **The service is down.** Restoring under a live coordinator would leave it
 *    holding a file handle to a database that is no longer the one on disk. A
 *    listener on the socket is the observable form of "still running", so this
 *    refuses on it.
 * 2. **The backup is readable and whole.** `PRAGMA integrity_check` and the
 *    quota schema guard run against the backup *before* the live file is
 *    touched, so a corrupt or newer-schema copy fails while the database it
 *    would have replaced is still in place.
 * 3. **The replaced database is kept.** It is archived with the same
 *    `VACUUM INTO` the backup path uses — a drill that cannot be undone is not
 *    a drill.
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

  const source = new Database(opts.backupPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = source.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      throw new Error(`Backup ${opts.backupPath} failed integrity_check: ${String(integrity)}`);
    }
    assertQuotaSchemaVersion(source, QUOTA_SCHEMA_VERSION);
  } catch (err) {
    source.close();
    throw err;
  }

  const startedMs = Date.now();
  let archivedTo: string | null = null;
  try {
    if (existsSync(opts.databasePath)) {
      const stamp = new Date(nowMs).toISOString().slice(0, 19).replace(/[-:]/g, "");
      archivedTo = `${opts.databasePath}.pre-restore-${stamp}Z.db`;
      rmSync(archivedTo, { force: true });
      const live = new Database(opts.databasePath, { readonly: true, fileMustExist: true });
      try {
        live.prepare("VACUUM INTO ?").run(archivedTo);
      } finally {
        live.close();
      }
      // The whole point of the archive above is that these can go: a `-wal`
      // left beside a replaced database is a log for a file that no longer
      // exists, and SQLite would try to recover it into the restored one.
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${opts.databasePath}${suffix}`, { force: true });
      }
    }
    mkdirSync(join(opts.databasePath, ".."), { recursive: true });
    source.prepare("VACUUM INTO ?").run(opts.databasePath);
  } finally {
    source.close();
  }

  return {
    from: opts.backupPath,
    databasePath: opts.databasePath,
    archivedTo,
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
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/**
 * The coordinator's daily backup timer.
 *
 * On start it backs up only when the newest existing backup is already older
 * than the cadence. Backing up unconditionally at boot would mean a service
 * that restarts five times in five minutes — which the unit's start limit
 * explicitly tolerates — evicting five of the fourteen daily copies with five
 * copies of the same minute, turning the retention window from two weeks into
 * an afternoon.
 */
export class QuotaBackupScheduler {
  private readonly intervalMs: number;
  private readonly setIntervalFn: (fn: () => void, ms: number) => unknown;
  private readonly clearIntervalFn: (handle: unknown) => void;
  private timer: unknown = null;

  constructor(readonly options: QuotaBackupSchedulerOptions) {
    this.intervalMs = options.intervalMs ?? QUOTA_BACKUP_INTERVAL_MS;
    this.setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => clearInterval(handle as Parameters<typeof clearInterval>[0]));
  }

  /** True when no backup exists yet, or the newest one is a cadence old. */
  isDue(): boolean {
    const backups = listQuotaBackups(this.options.backupDir);
    const newest = backups.at(-1);
    if (!newest) return true;
    const nowMs = (this.options.now ?? Date.now)();
    return nowMs - statSync(newest).mtimeMs >= this.intervalMs;
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
    if (this.isDue()) this.runOnce();
    this.timer = this.setIntervalFn(() => {
      this.runOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
  }
}
