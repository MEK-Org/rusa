import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { loadConfig, resolveHome } from "../config/index.js";
import type { RusaConfig } from "../config/types.js";
import { ModelScrapeRepository } from "../db/repositories/model-scrape-repository.js";
import { createQuotaService } from "../mcp/quota-mcp.js";
import { createLogger } from "../observability/logger.js";
import { ingestKimiHostModels, populateModelCatalogsFromDb } from "../providers/model-catalog.js";
import { providerThrottleKey, QUOTA_THROTTLE_PROVIDERS } from "../providers/registry.js";
import {
  DEFAULT_QUOTA_BACKUP_RETENTION,
  QuotaBackupScheduler,
} from "../quota/coordinator-backup.js";
import { QuotaCollectionLoop } from "../quota/coordinator-collection.js";
import { createQuotaMetrics } from "../quota/coordinator-metrics.js";
import {
  DEFAULT_MAX_INTERVAL_SECONDS,
  DEFAULT_STALE_AFTER_MS,
} from "../quota/coordinator-protocol.js";
import { QuotaCoordinatorService } from "../quota/coordinator-service.js";
import { DEFAULT_RELOCATED_QUOTA_DB_NAME, relocateQuotaDatabase } from "../quota/relocate.js";
import {
  assertQuotaSchemaVersion,
  QUOTA_SCHEMA_VERSION,
  SchemaVersionRefusalError,
} from "../quota/schema-guard.js";
import { resolveQuotaDatabasePath, SharedQuotaStore } from "../quota/shared-store.js";

export interface RunQuotaCoordinatorOptions {
  home?: string;
  socketPath?: string;
  /** Service-owned database path (`quota.coordinator.databasePath`). */
  databasePath?: string;
  /** Legacy direct-mode database path (`quota.databasePath`), read only by the stage-3 flip. */
  legacyDatabasePath?: string;
  /** Perform the scheduled stage-3 flip (§8.3) before opening the service-owned database. */
  relocate?: boolean;
}

/**
 * Where daily backups live when the configuration does not say.
 *
 * Beside the database, not under `$RUSA_HOME`: `VACUUM INTO` writes the backup
 * directly and the finished file is renamed into place, and both are only cheap
 * and atomic when source and destination share a filesystem. An operator who
 * wants backups on other storage sets `quota.coordinator.backupDir` and accepts
 * the copy.
 */
export function defaultQuotaBackupDir(databasePath: string): string {
  return join(dirname(databasePath), "backups");
}

export function defaultQuotaCoordinatorSocketPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir && runtimeDir.trim().length > 0) {
    return join(runtimeDir.trim(), "rusa-quota", "coordinator.sock");
  }
  return join(tmpdir(), "rusa-quota", "coordinator.sock");
}

export interface CoordinatorDatabasePaths {
  /** The file the service opens and owns. */
  databasePath: string;
  /** The pre-service file the flip renames away; only present when relocating. */
  legacyDatabasePath?: string;
}

/**
 * Decide which file the coordinator opens.
 *
 * `quota.coordinator.databasePath` is the service-owned file and the only path
 * an ordinary start accepts. `quota.databasePath` is the pre-service file the
 * instances used to open directly; it is read here only by the explicit
 * stage-3 flip (§8.3), which renames it to the service-owned path and fences
 * the old name. A configuration that still names only the legacy key is
 * refused rather than opened in place, because opening it in place is exactly
 * the concurrent old-and-new-writer state §8.2 rules out — the refusal is the
 * misconfiguration guard a service-aware build can give.
 */
export function resolveCoordinatorDatabasePaths(
  config: RusaConfig,
  mcHome: string,
  opts: Pick<RunQuotaCoordinatorOptions, "databasePath" | "legacyDatabasePath" | "relocate"> = {}
): CoordinatorDatabasePaths {
  const configuredServiceDb =
    opts.databasePath?.trim() || config.quota?.coordinator?.databasePath?.trim();
  const configuredLegacyDb = opts.legacyDatabasePath?.trim() || config.quota?.databasePath?.trim();

  if (opts.relocate) {
    if (!configuredLegacyDb) {
      throw new Error(
        "Legacy database path is required for --relocate: configure quota.databasePath or specify --legacy-database"
      );
    }
    const legacyDatabasePath = resolveQuotaDatabasePath(configuredLegacyDb, mcHome);
    const databasePath = configuredServiceDb
      ? resolveQuotaDatabasePath(configuredServiceDb, mcHome)
      : join(dirname(legacyDatabasePath), DEFAULT_RELOCATED_QUOTA_DB_NAME);
    if (databasePath === legacyDatabasePath) {
      throw new Error(
        "--relocate requires a distinct service-owned database path; set quota.coordinator.databasePath or --database"
      );
    }
    return { databasePath, legacyDatabasePath };
  }

  if (!configuredServiceDb) {
    if (configuredLegacyDb) {
      throw new Error(
        "quota.databasePath is the pre-service database; run the scheduled stage-3 flip with `rusa quota-coordinator --relocate`, then configure quota.coordinator.databasePath"
      );
    }
    throw new Error(
      "Service-owned database path is required: configure quota.coordinator.databasePath or specify --database"
    );
  }
  return { databasePath: resolveQuotaDatabasePath(configuredServiceDb, mcHome) };
}

/**
 * The quota database an operator command acts on: an explicit override, else
 * the service-owned file, else the pre-service file an instance still opens
 * directly. Shared by every command that touches the file from its own
 * process (`quota-backup`, `quota-restore`, `quota-pacing-reset`) so they
 * cannot resolve different databases from the same config. It lives beside
 * {@link resolveCoordinatorDatabasePaths} so that no operator command has to
 * import another for a path helper.
 */
export function resolveOperatorQuotaDatabasePath(
  opts: { databasePath?: string },
  config: RusaConfig,
  mcHome: string
): string {
  const configuredDb =
    opts.databasePath?.trim() ||
    config.quota?.coordinator?.databasePath?.trim() ||
    config.quota?.databasePath?.trim();
  if (!configuredDb) {
    throw new Error(
      "No quota database configured: set quota.coordinator.databasePath (or quota.databasePath), or pass --database"
    );
  }
  return resolveQuotaDatabasePath(configuredDb, mcHome);
}

/**
 * Where the coordinator listens: an explicit override, else the configured
 * `quota.coordinator.socketPath`, else the host default. One resolution shared by the
 * service that binds the socket and every client that dials it, so that two callers
 * handing it the same config cannot resolve different paths. Resolving the appropriate
 * config home is the caller's responsibility, with `resolveHome()` being what the service
 * uses.
 */
export function resolveQuotaCoordinatorSocketPath(
  config: RusaConfig | null | undefined,
  override?: string
): string {
  return (
    override?.trim() ||
    config?.quota?.coordinator?.socketPath?.trim() ||
    defaultQuotaCoordinatorSocketPath()
  );
}

/**
 * The coordinator is a separate process, so restore the last durable runtime
 * model catalog before it asks the quota parser to classify model windows.
 * This is intentionally a read-only best-effort input: an absent local catalog
 * database simply leaves the catalog empty, which suppresses model-specific windows
 * while preserving provider-wide readings.
 */
export function loadCoordinatorModelCatalogs(mcHome: string): void {
  const catalogPath = join(mcHome, "data", "mesh.db");
  if (existsSync(catalogPath)) {
    const catalogDb = new Database(catalogPath, { readonly: true, fileMustExist: true });
    try {
      populateModelCatalogsFromDb(new ModelScrapeRepository(catalogDb));
    } finally {
      catalogDb.close();
    }
  }
  // Kimi's runtime catalog is a local configuration file. Reading it here is
  // also read-only and leaves no scrape/history row behind.
  ingestKimiHostModels();
}

/**
 * Keep the coordinator's established read contract separate from the new
 * collector's capability boundary. A configured alias remains readable even
 * when this process has no probe for it; only collection is limited to the
 * supported throttle providers.
 */
export function coordinatorProviderLanes(config: RusaConfig): {
  configuredProviders: readonly string[] | undefined;
  collectionProviders: readonly (typeof QUOTA_THROTTLE_PROVIDERS)[number][];
} {
  const providerKeys = Object.keys(config.providers ?? {});
  const configuredLanes = Array.from(
    new Set(providerKeys.map((name) => providerThrottleKey(name, config)))
  );
  const configuredProviders = configuredLanes.length > 0 ? configuredLanes : undefined;
  const collectionProviders = (configuredProviders ?? QUOTA_THROTTLE_PROVIDERS).filter(
    (provider): provider is (typeof QUOTA_THROTTLE_PROVIDERS)[number] =>
      (QUOTA_THROTTLE_PROVIDERS as readonly string[]).includes(provider)
  );
  return { configuredProviders, collectionProviders };
}

export async function runQuotaCoordinator(opts: RunQuotaCoordinatorOptions = {}): Promise<void> {
  const log = createLogger({ context: { component: "quota-coordinator" } });
  const mcHome = opts.home ?? resolveHome();
  const config = loadConfig(mcHome);

  const socketPath = resolveQuotaCoordinatorSocketPath(config, opts.socketPath);

  const paths = resolveCoordinatorDatabasePaths(config, mcHome, opts);
  const databasePath = paths.databasePath;
  if (paths.legacyDatabasePath) {
    const flip = relocateQuotaDatabase({
      oldDatabasePath: paths.legacyDatabasePath,
      newDatabasePath: databasePath,
    });
    log.info("Quota database relocated to service ownership", {
      legacyDatabasePath: paths.legacyDatabasePath,
      databasePath,
      renamed: flip.renamed,
      placeholderCreated: flip.placeholderCreated,
    });
  }

  try {
    try {
      loadCoordinatorModelCatalogs(mcHome);
    } catch (err) {
      // No catalog is safer than a guessed catalog: parsing then retains only
      // provider-wide windows. Keep service startup available when an old or
      // unavailable local model-history DB cannot be read.
      log.warn("Unable to load durable model catalog; model quota windows will be suppressed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Check schema version on a bare readonly connection before constructing SharedQuotaStore
    // so rollback attempts never execute WAL conversions or ALTER/CREATE statements
    if (existsSync(databasePath)) {
      const probeDb = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        assertQuotaSchemaVersion(probeDb, QUOTA_SCHEMA_VERSION);
      } finally {
        probeDb.close();
      }
    }

    const maxIntervalSeconds =
      config.quota?.throttle?.maxIntervalSeconds ?? DEFAULT_MAX_INTERVAL_SECONDS;
    const staleAfterMs = config.quota?.throttle?.tickSeconds
      ? config.quota.throttle.tickSeconds * 3 * 1000
      : DEFAULT_STALE_AFTER_MS;

    const store = new SharedQuotaStore(databasePath);
    const metrics = createQuotaMetrics(log);
    store.setMetrics(metrics);

    const configuredBackupDir = config.quota?.coordinator?.backupDir?.trim();
    const backupDir = configuredBackupDir
      ? isAbsolute(configuredBackupDir)
        ? configuredBackupDir
        : resolve(mcHome, configuredBackupDir)
      : defaultQuotaBackupDir(databasePath);
    const backupRetention =
      config.quota?.coordinator?.backupRetention ?? DEFAULT_QUOTA_BACKUP_RETENTION;

    const { configuredProviders, collectionProviders } = coordinatorProviderLanes(config);

    const quotaService = createQuotaService({
      config,
      workersDir: join(mcHome, "workers"),
      scrapeStore: store,
    });
    const collection = new QuotaCollectionLoop({
      store,
      quotaService,
      metrics,
      providers: collectionProviders,
      tickMs: (config.quota?.throttle?.tickSeconds ?? 300) * 1000,
      maxIntervalSeconds,
      // The loop publishes the interval and snapshot-age gauges after each
      // controller step, so it needs the same freshness thresholds the service
      // serves with; otherwise the gauge and the response would disagree.
      staleAfterMs,
      onError: (provider, error) =>
        log.warn("Quota collection tick failed", {
          provider,
          error: error instanceof Error ? error.message : String(error),
        }),
    });

    const service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders,
      maxIntervalSeconds,
      staleAfterMs,
      metrics,
      collectionStats: () => collection.getAllStats(),
    });
    const backups = new QuotaBackupScheduler({
      databasePath,
      backupDir,
      retain: backupRetention,
      onBackup: (result) =>
        log.info("Quota database backed up", {
          path: result.path,
          bytes: result.bytes,
          durationMs: result.durationMs,
          pruned: result.pruned.length,
        }),
      onError: (error) =>
        log.error("Quota database backup failed", {
          backupDir,
          error: error instanceof Error ? error.message : String(error),
        }),
    });

    log.info("Starting quota-coordinator service", { socketPath, databasePath, backupDir });

    // Order matters, and it is the reverse of what "start the cheap things
    // first" would suggest. The boot backup runs before the socket is
    // announced as ready, so the copy it takes is of the database as it was
    // *before* this process wrote anything to it — which is the copy an
    // operator restoring after a bad deploy actually wants. Readiness is
    // logged last for the same reason: a coordinator that says it is ready has
    // already taken whatever backup this boot owed.
    await service.start();
    collection.start();
    backups.start();
    log.info("Quota coordinator ready and listening for requests");

    const shutdown = async () => {
      log.info("Stopping quota-coordinator service...");
      backups.stop();
      collection.stop();
      await service.stop();
      store.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (err) {
    if (err instanceof SchemaVersionRefusalError) {
      log.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
