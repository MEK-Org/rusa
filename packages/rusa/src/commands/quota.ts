import { resolve } from "node:path";
import { SharedQuotaStore } from "../quota/shared-store.js";

export interface RunQuotaMigrateOptions {
  databasePath: string;
  poolId: string;
  sources: string[];
  maxIntervalSeconds?: number;
}

export function parseQuotaMigrationSource(value: string): {
  sourceInstance: string;
  databasePath: string;
} {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`invalid --source '${value}'; expected INSTANCE=/absolute/path/to/rusa.db`);
  }
  const sourceInstance = value.slice(0, separator).trim();
  const databasePath = resolve(value.slice(separator + 1).trim());
  if (!sourceInstance) throw new Error("quota migration source instance must not be blank");
  return { sourceInstance, databasePath };
}

/** Merge legacy instance quota histories into a dedicated shared quota database. */
export async function runQuotaMigrate(opts: RunQuotaMigrateOptions): Promise<void> {
  if (opts.sources.length === 0) throw new Error("at least one --source is required");
  if (!opts.poolId.trim()) throw new Error("quota migration pool id must not be blank");
  const maxIntervalSeconds = opts.maxIntervalSeconds ?? 3600;
  if (!Number.isFinite(maxIntervalSeconds) || maxIntervalSeconds <= 0) {
    throw new Error("quota migration max interval must be a positive number");
  }
  const destination = resolve(opts.databasePath);
  const sources = opts.sources.map(parseQuotaMigrationSource);
  const sourceNames = new Set<string>();
  for (const source of sources) {
    if (source.databasePath === destination) {
      throw new Error("shared quota destination must not also be a migration source");
    }
    if (sourceNames.has(source.sourceInstance)) {
      throw new Error(`duplicate quota migration source instance '${source.sourceInstance}'`);
    }
    sourceNames.add(source.sourceInstance);
  }
  const store = new SharedQuotaStore(destination, opts.poolId.trim(), "quota-migration");
  try {
    for (const source of sources) {
      const report = store.importLegacyDatabase(source.databasePath, source.sourceInstance);
      console.log(
        `${report.sourceInstance}: ${report.insertedRows}/${report.sourceRows} scrapes imported ` +
          `(${report.duplicateRows} already present)`
      );
    }
    store.configureController({ maxIntervalSeconds });
    const summary = store.db
      .prepare(
        `SELECT count(*) AS evidence,
                sum(CASE WHEN selected = 1 THEN 1 ELSE 0 END) AS canonical,
                sum(CASE WHEN anomaly = 1 THEN 1 ELSE 0 END) AS anomalies
         FROM quota_observations`
      )
      .get() as { evidence: number; canonical: number | null; anomalies: number | null };
    console.log(
      `shared quota database ready: ${summary.evidence} observations, ` +
        `${summary.canonical ?? 0} canonical, ${summary.anomalies ?? 0} anomalies retained but rejected`
    );
  } finally {
    store.close();
  }
}
