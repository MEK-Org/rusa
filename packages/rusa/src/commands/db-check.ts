import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { importLegacyActorState } from "../db/legacy-actor-import.js";
import { pendingMigrationIds, runMigrations } from "../db/migrations/runner.js";
import { Repositories } from "../db/repositories/index.js";
import { widenToWal } from "../db/wal.js";

export interface DbCheckResult {
  pendingMigrationIds: string[];
  plannedActors: number;
  plannedScheduledMessages: number;
}

/**
 * Preflight a copy of an instance home: apply pending migrations to its
 * `data/mesh.db`, then plan (never write) the legacy JSON import against the
 * same copy. Never falls back to the default Rusa home — a caller must supply
 * an explicit path to a copy, since this opens a real database and this
 * function's whole purpose is to be safe to run against a copy before a
 * deploy touches the live instance.
 */
export function runDbCheckAgainstHome(home: string): DbCheckResult {
  if (!home.trim()) {
    throw new Error("rusa db-check: --home is required and has no default fallback");
  }
  if (!existsSync(home) || !statSync(home).isDirectory()) {
    throw new Error(`rusa db-check: --home "${home}" does not exist as a directory`);
  }
  const dataDir = join(home, "data");
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "mesh.db"));
  try {
    widenToWal(db);
    db.pragma("foreign_keys = ON");
    const pending = pendingMigrationIds(db);
    runMigrations(db);

    const repositories = new Repositories(db);
    const plan = importLegacyActorState({ mcHome: home, db, repositories, dryRun: true });

    return {
      pendingMigrationIds: pending,
      plannedActors: plan.importedActors,
      plannedScheduledMessages: plan.importedScheduledMessages,
    };
  } finally {
    db.close();
  }
}

/** CLI entry point for `rusa db-check --home <dir>`. Exits non-zero on any actionable failure. */
export function runDbCheck(opts: { home: string }): void {
  try {
    const result = runDbCheckAgainstHome(opts.home);
    console.log(
      result.pendingMigrationIds.length > 0
        ? `Pending migrations: ${result.pendingMigrationIds.join(", ")}`
        : "Pending migrations: none"
    );
    console.log(
      `Legacy import plan: ${result.plannedActors} actor(s), ${result.plannedScheduledMessages} scheduled message(s)`
    );
    console.log("✓ db-check passed");
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
