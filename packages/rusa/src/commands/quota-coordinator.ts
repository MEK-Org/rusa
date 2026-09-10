import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { loadConfig, resolveHome } from "../config/index.js";
import { createLogger } from "../observability/logger.js";
import { providerThrottleKey } from "../providers/registry.js";
import {
  DEFAULT_MAX_INTERVAL_SECONDS,
  DEFAULT_STALE_AFTER_MS,
} from "../quota/coordinator-protocol.js";
import { QuotaCoordinatorService } from "../quota/coordinator-service.js";
import {
  assertQuotaSchemaVersion,
  QUOTA_SCHEMA_VERSION,
  SchemaVersionRefusalError,
} from "../quota/schema-guard.js";
import { resolveQuotaDatabasePath, SharedQuotaStore } from "../quota/shared-store.js";

export interface RunQuotaCoordinatorOptions {
  home?: string;
  socketPath?: string;
  databasePath?: string;
}

export function defaultQuotaCoordinatorSocketPath(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  if (runtimeDir && runtimeDir.trim().length > 0) {
    return join(runtimeDir.trim(), "rusa-quota", "coordinator.sock");
  }
  return join(tmpdir(), "rusa-quota", "coordinator.sock");
}

export async function runQuotaCoordinator(opts: RunQuotaCoordinatorOptions = {}): Promise<void> {
  const log = createLogger({ context: { component: "quota-coordinator" } });
  const mcHome = opts.home ?? resolveHome();
  const config = loadConfig(mcHome);

  const socketPath =
    opts.socketPath?.trim() ||
    config.quota?.coordinator?.socketPath?.trim() ||
    defaultQuotaCoordinatorSocketPath();

  const configuredDb =
    opts.databasePath?.trim() ||
    config.quota?.coordinator?.databasePath?.trim() ||
    config.quota?.databasePath?.trim();

  if (!configuredDb) {
    throw new Error(
      "Database path is required to run quota coordinator: configure quota.coordinator.databasePath (or quota.databasePath) or specify --database"
    );
  }

  const databasePath = resolveQuotaDatabasePath(configuredDb, mcHome);

  try {
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
    if (config.quota?.throttle) {
      store.configureController({
        maxIntervalSeconds,
      });
    }

    // Collapse config aliases onto canonical provider throttle lanes
    const providerKeys = Object.keys(config.providers ?? {});
    const configuredLanes = Array.from(
      new Set(providerKeys.map((name) => providerThrottleKey(name, config)))
    );
    const configuredProviders = configuredLanes.length > 0 ? configuredLanes : undefined;

    const service = new QuotaCoordinatorService({
      socketPath,
      store,
      configuredProviders,
      maxIntervalSeconds,
      staleAfterMs,
    });

    log.info("Starting quota-coordinator service", { socketPath, databasePath });

    await service.start();
    log.info("Quota coordinator ready and listening for requests");

    const shutdown = async () => {
      log.info("Stopping quota-coordinator service...");
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
