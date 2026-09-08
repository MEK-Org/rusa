import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveHome } from "../config/index.js";
import { createLogger } from "../observability/logger.js";
import { QuotaCoordinatorService } from "../quota/coordinator-service.js";
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

  const databasePath = configuredDb
    ? resolveQuotaDatabasePath(configuredDb, mcHome)
    : join(mcHome, "quota.db");

  const store = new SharedQuotaStore(databasePath);
  if (config.quota?.throttle) {
    store.configureController({
      maxIntervalSeconds: config.quota.throttle.maxIntervalSeconds ?? 3600,
    });
  }

  const configuredProviders = Object.keys(config.providers ?? {});
  const service = new QuotaCoordinatorService({
    socketPath,
    store,
    configuredProviders: configuredProviders.length > 0 ? configuredProviders : undefined,
    maxIntervalSeconds: config.quota?.throttle?.maxIntervalSeconds ?? 3600,
    staleAfterMs: config.quota?.throttle?.tickSeconds
      ? config.quota.throttle.tickSeconds * 3 * 1000
      : undefined,
  });

  const log = createLogger({ context: { component: "quota-coordinator" } });
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
}
