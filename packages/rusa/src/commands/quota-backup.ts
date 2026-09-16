import { isAbsolute, resolve } from "node:path";
import { loadConfig, resolveHome } from "../config/index.js";
import type { RusaConfig } from "../config/types.js";
import { createLogger } from "../observability/logger.js";
import {
  backupQuotaDatabase,
  DEFAULT_QUOTA_BACKUP_RETENTION,
  listQuotaBackups,
  restoreQuotaDatabase,
} from "../quota/coordinator-backup.js";
import { resolveQuotaDatabasePath } from "../quota/shared-store.js";
import { defaultQuotaBackupDir, defaultQuotaCoordinatorSocketPath } from "./quota-coordinator.js";

export interface QuotaBackupCommandOptions {
  home?: string;
  databasePath?: string;
  backupDir?: string;
  retain?: number;
}

export interface QuotaRestoreCommandOptions extends QuotaBackupCommandOptions {
  /** Which backup to restore; defaults to the newest one in the backup dir. */
  from?: string;
  socketPath?: string;
}

function resolvePaths(
  opts: QuotaBackupCommandOptions,
  config: RusaConfig,
  mcHome: string
): { databasePath: string; backupDir: string; retain: number } {
  const configuredDb =
    opts.databasePath?.trim() ||
    config.quota?.coordinator?.databasePath?.trim() ||
    config.quota?.databasePath?.trim();
  if (!configuredDb) {
    throw new Error(
      "No quota database configured: set quota.coordinator.databasePath (or quota.databasePath), or pass --database"
    );
  }
  const databasePath = resolveQuotaDatabasePath(configuredDb, mcHome);

  const configuredBackupDir =
    opts.backupDir?.trim() || config.quota?.coordinator?.backupDir?.trim();
  const backupDir = configuredBackupDir
    ? isAbsolute(configuredBackupDir)
      ? configuredBackupDir
      : resolve(mcHome, configuredBackupDir)
    : defaultQuotaBackupDir(databasePath);

  const retain =
    opts.retain ?? config.quota?.coordinator?.backupRetention ?? DEFAULT_QUOTA_BACKUP_RETENTION;

  return { databasePath, backupDir, retain };
}

/**
 * Take one backup now.
 *
 * This is the same code path the coordinator's daily timer runs, exposed as a
 * command because the design requires one mandatory backup immediately before
 * the stage-3 canary — a step an operator performs on demand, not one that can
 * wait for the next scheduled tick.
 *
 * It is safe to run against a live coordinator: the connection it opens is
 * read-only and `VACUUM INTO` reads a consistent snapshot.
 */
export function runQuotaBackup(opts: QuotaBackupCommandOptions = {}): void {
  const log = createLogger({ context: { component: "quota-backup" } });
  const mcHome = opts.home ?? resolveHome();
  const config = loadConfig(mcHome);
  const { databasePath, backupDir, retain } = resolvePaths(opts, config, mcHome);

  const result = backupQuotaDatabase({ databasePath, backupDir, retain });
  log.info("quota_backup_created", {
    path: result.path,
    bytes: result.bytes,
    durationMs: result.durationMs,
    retained: listQuotaBackups(backupDir).length,
    pruned: result.pruned.length,
  });
}

/**
 * Restore a backup over the coordinator database.
 *
 * The restore refuses while a coordinator is listening on the socket, so the
 * operator procedure — stop instances, stop the service, restore, start the
 * service, check `readyz` and the published throttle, start instances — cannot
 * be performed half-way by accident.
 */
export async function runQuotaRestore(opts: QuotaRestoreCommandOptions = {}): Promise<void> {
  const log = createLogger({ context: { component: "quota-restore" } });
  const mcHome = opts.home ?? resolveHome();
  const config = loadConfig(mcHome);
  const { databasePath, backupDir } = resolvePaths(opts, config, mcHome);

  const backupPath = opts.from?.trim() || listQuotaBackups(backupDir).at(-1);
  if (!backupPath) {
    throw new Error(`No quota backups found in ${backupDir}`);
  }

  const socketPath =
    opts.socketPath?.trim() ||
    config.quota?.coordinator?.socketPath?.trim() ||
    defaultQuotaCoordinatorSocketPath();

  const result = await restoreQuotaDatabase({ backupPath, databasePath, socketPath });
  log.info("quota_backup_restored", {
    from: result.from,
    databasePath: result.databasePath,
    archivedTo: result.archivedTo,
    // `rename` says the replaced database could not be opened and its raw bytes
    // were moved aside instead — worth seeing in the record, because it means
    // the archive is a corrupt file rather than a usable rollback target.
    archivedBy: result.archivedBy,
    durationMs: result.durationMs,
  });
}

/** List the backups retention currently holds, newest last. */
export function runQuotaBackupList(opts: QuotaBackupCommandOptions = {}): void {
  const log = createLogger({ context: { component: "quota-backup" } });
  const mcHome = opts.home ?? resolveHome();
  const config = loadConfig(mcHome);
  const { backupDir, retain } = resolvePaths(opts, config, mcHome);
  const backups = listQuotaBackups(backupDir);
  log.info("quota_backup_list", { backupDir, retain, count: backups.length, backups });
}
