import { loadConfig, resolveHome } from "../config/index.js";
import { createLogger } from "../observability/logger.js";
import { normalizeProviderThrottleKey, QUOTA_THROTTLE_PROVIDERS } from "../providers/registry.js";
import { type QuotaControllerResetResult, SharedQuotaStore } from "../quota/shared-store.js";
import { resolveOperatorQuotaDatabasePath } from "./quota-coordinator.js";

export interface QuotaPacingResetCommandOptions {
  home?: string;
  databasePath?: string;
  /** The provider lane to reset; any spelling the throttle alias table accepts. */
  provider: string;
}

export interface QuotaPacingResetResult extends QuotaControllerResetResult {
  databasePath: string;
}

/**
 * Hard-reset one provider's quota pacing controller.
 *
 * Exists for the moment an operator knows the controller's memory is wrong —
 * typically after the provider's usage was reset out of band, so the standing
 * error the integral accumulated and the period it commanded no longer
 * describe anything real. Proportional gain is a constant and is untouched;
 * the derivative and integral history and the current period are cleared, and
 * the controller paces forward from zero on the next observation.
 *
 * It resets pacing policy only. An exhausted observation is quota evidence and
 * is preserved, so a lane that is currently gated stays gated until a fresh
 * scrape reports headroom — this command cannot and does not assert that the
 * budget refilled.
 *
 * Like `rusa quota-backup`, this runs in its own process against the shared
 * file and is safe against a running coordinator. The reset is a single
 * `BEGIN IMMEDIATE` transaction, so it takes its write lock up front instead
 * of upgrading mid-transaction and cannot deadlock against the collection
 * loop's own immediate transaction; in WAL mode with the connection's
 * `busy_timeout`, whichever writer arrives second waits the other out rather
 * than failing, so ordinary contention does not surface `SQLITE_BUSY` in
 * either process. The coordinator reads the published throttle from the file
 * on every request, so the next instance poll picks the reset up without a
 * restart. The row update is durable, so a coordinator restart cannot
 * resurrect the cleared memory.
 *
 * The outcome is reported through the application logger, which is the
 * operator-facing output: it renders as a readable line on a terminal and as
 * JSON when redirected, so there is deliberately no separate printed prose
 * duplicating the same record. That is the same contract as `quota-backup`
 * and `quota-restore`, and the console budget holds every command to it. The
 * record is at `info`, so a shell that has raised the level (`RUSA_LOG_LEVEL`
 * or `logging.level` at `warn`/`error`/`silent`) sees only the exit code; the
 * result is also the return value for anything that calls this in-process.
 */
export function runQuotaPacingReset(opts: QuotaPacingResetCommandOptions): QuotaPacingResetResult {
  const raw = opts.provider?.trim() ?? "";
  if (!raw) {
    throw new Error("--provider is required: name the provider lane to reset");
  }
  const provider = normalizeProviderThrottleKey(raw);
  if (!(QUOTA_THROTTLE_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(
      `"${raw}" is not a quota-paced provider; expected one of ${QUOTA_THROTTLE_PROVIDERS.join(", ")}`
    );
  }

  const log = createLogger({ context: { component: "quota-pacing-reset" } });
  const mcHome = opts.home ?? resolveHome();
  const config = loadConfig(mcHome);
  const databasePath = resolveOperatorQuotaDatabasePath(opts, config, mcHome);

  const store = new SharedQuotaStore(databasePath);
  try {
    const result = store.resetController(provider);
    log.info("quota_pacing_reset", { databasePath, ...result });
    return { databasePath, ...result };
  } finally {
    store.close();
  }
}
