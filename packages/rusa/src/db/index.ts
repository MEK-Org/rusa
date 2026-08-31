import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";
import { widenToWal } from "./wal.js";

let db: Database.Database | null = null;
let repositories: Repositories | null = null;

export type TaskStatus = "queued" | "in_progress" | "done" | "blocked";

/**
 * Row shape returned by `tasks` queries. After the legacy cleanup  the only
 * remaining task kind is the distillation work item (persona = 'distiller');
 * the v2 orchestrator-model columns `title`/`orchestrator_notes` were dropped.
 */
export interface TaskRow {
  id: string;
  repo: string;
  source: string;
  status: TaskStatus | string;
  outcome: string | null;
  assigned_agent_id: string | null;
  parent_task_id: string | null;
  persona: string | null;
  provider_preference: string | null;
  context: string | null;
  not_before: string | null;
  created_at: string;
  updated_at: string;
  result: string | null;
}

/**
 * Open (and migrate) the SQLite database under `<mcHome>/data/rusa.db`.
 * Idempotent: returns the existing handle if already open.
 */
export function initDb(mcHome: string): Database.Database {
  if (db) return db;

  const dataDir = join(mcHome, "data");
  mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, "rusa.db");
  db = new Database(dbPath);

  // WAL for better concurrent read performance; enforce relational constraints.
  // The conversion goes through `widenToWal` rather than the bare pragma: a
  // second process opening this same instance's still-legacy database at the
  // same instant holds RESERVED, and the bare pragma fails against that
  // immediately instead of waiting.
  widenToWal(db);
  db.pragma("foreign_keys = ON");

  runMigrations(db);

  return db;
}

/**
 * Get the current database instance. Throws if {@link initDb} hasn't been called.
 */
export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

/**
 * Accessor for the repository layer (mesh events, raw inputs, distillation queue).
 */
export function getRepositories(): Repositories {
  if (!repositories) {
    repositories = new Repositories(getDb());
  }
  return repositories;
}

/**
 * Close the database connection.
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  repositories = null;
}

const SQLITE_UTC_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?$/;

export function parseTimestampAsUtcMillis(value: string): number | null {
  const sqliteMatch = SQLITE_UTC_DATETIME_RE.exec(value);
  if (sqliteMatch) {
    const [, year, month, day, hour, minute, second, msStr] = sqliteMatch;
    const ms = msStr ? Number(msStr.padEnd(3, "0").slice(0, 3)) : 0;
    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      ms
    );
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/** Normalize an ISO/SQLite timestamp to SQLite's `YYYY-MM-DD HH:MM:SS` UTC form. */
function toSqliteDatetime(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = parseTimestampAsUtcMillis(value);
  if (timestamp === null) return null;
  return new Date(timestamp)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

/**
 * Create a single task. The actor mesh uses this only for the understanding
 * distillation queue (`persona = 'distiller'`), which the understanding
 * subsystem drains.
 *
 * `reasoning` is accepted for call-site compatibility but ignored — the v2
 * orchestrator-event audit trail it used to write was removed with the v2
 * orchestrator .
 */
export function createTask(opts: {
  repo: string;
  source: string;
  persona: string;
  context: Record<string, unknown>;
  notBefore?: string | null;
  reasoning?: string;
}): string {
  const d = getDb();
  const taskId = randomUUID();
  const contextJson = JSON.stringify(opts.context);

  d.prepare(
    `INSERT INTO tasks (id, repo, source, status, persona, context, not_before)
     VALUES (?, ?, ?, 'queued', ?, ?, ?)`
  ).run(
    taskId,
    opts.repo,
    opts.source,
    opts.persona,
    contextJson,
    toSqliteDatetime(opts.notBefore)
  );

  return taskId;
}
