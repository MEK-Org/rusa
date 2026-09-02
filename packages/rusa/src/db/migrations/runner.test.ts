import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";

describe("Database Migration System", () => {
  let testDbDir: string;
  let dbPath: string;

  beforeEach(() => {
    testDbDir = mkdtempSync(join(tmpdir(), "migration-test-"));
    dbPath = join(testDbDir, "mesh.db");
  });

  afterEach(() => {
    rmSync(testDbDir, { recursive: true, force: true });
  });

  it("initializes a fresh database with the squashed initial schema", () => {
    const db = new Database(dbPath);
    runMigrations(db);

    const migrationsTable = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'`)
      .get();
    expect(migrationsTable).toBeDefined();

    // The retained mesh-era tables exist; v2 tables do not.
    const names = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
    );
    for (const t of [
      "tasks",
      "mesh_events",
      "raw_inputs",
      "understanding_sync_metadata",
      "understanding_sync_ops",
      "actor_inbox_entries",
      "quota_scrapes",
      "model_scrapes",
      "run_token_records",
      "actor_runs",
      "obligations",
    ]) {
      expect(names.has(t)).toBe(true);
    }
    for (const t of ["conversations", "signals", "invocations", "models", "orchestrator_events"]) {
      expect(names.has(t)).toBe(false);
    }

    const applied = db.prepare("SELECT id FROM _migrations ORDER BY id ASC").all() as Array<{
      id: string;
    }>;
    expect(applied.map((a) => a.id)).toEqual([
      "0001_initial_schema",
      "0002_mesh_events_actor_kind_index",
      "0003_actor_inbox",
      "0004_mesh_events_actor_ts_index",
      "0005_mesh_chat_and_events_split",
      "0006_backfill_mesh_chat_from_legacy_events",
      "0007_cleanup_intermediate_mechanical_chat_rows",
      "0008_run_lifecycle_taxonomy",
      "0009_quota_scrape_history",
      "0010_run_token_records",
      "0012_actor_inbox_seen",
      "0013_remove_primary_exhaustion",
      "0014_cleanup_regressed_mechanical_chat_rows",
      "0015_actor_inbox_handled_note",
      "0016_obligations",
      "0017_obligation_priority",
      "0018_drop_mesh_events_created_at",
      "0019_model_scrapes",
      "0020_obligation_capture_receipts",
      "0022_inferred_parsed_state",
      "0023_drop_mesh_events_peer_id",
      "0024_rename_thread_events",
      "0025_obligation_timestamps",
      "0026_obligation_terminal_note",
      "0027_obligation_title",
      "0028_obligation_artifacts",
      "0029_reference_grammar",
      "0030_actor_runs",
      "0031_inbox_run_focus",
      "0032_actor_runs_focus_fold",
      "0033_reference_cache",
    ]);

    const meshEventsColumns = (
      db.prepare("PRAGMA table_info(mesh_events)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(meshEventsColumns).not.toContain("created_at");
    expect(meshEventsColumns).not.toContain("peer_id");

    const modelScrapesColumns = (
      db.prepare("PRAGMA table_info(model_scrapes)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(modelScrapesColumns).not.toContain("created_at");
    expect(modelScrapesColumns).toContain("scraped_at");

    const renameEpoch = db
      .prepare("SELECT applied_at FROM _migrations WHERE id = '0008_run_lifecycle_taxonomy'")
      .get() as { applied_at: string } | undefined;
    expect(renameEpoch?.applied_at).toMatch(/^\d{4}-\d{2}-\d{2} /);

    db.close();
  });

  it("stamps the initial schema as applied for a database with pre-existing tables", () => {
    const db = new Database(dbPath);

    // A database from before this runner: it already has tables but no _migrations.
    db.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      CREATE TABLE raw_inputs (id TEXT PRIMARY KEY);
      CREATE TABLE mesh_events (id TEXT PRIMARY KEY, actor_id TEXT, kind TEXT, ts TEXT, detail TEXT);
    `);

    runMigrations(db);

    // 0001 is recorded without being re-run (which would have failed on the
    // already-existing tables) — the runner's existing-tables special case.
    const applied = db.prepare("SELECT id FROM _migrations WHERE id = '0001_initial_schema'").get();
    expect(applied).toBeDefined();

    db.close();
  });

  it("is idempotent and does not re-run migrations", () => {
    const db = new Database(dbPath);
    runMigrations(db);

    const countBefore = (
      db.prepare("SELECT COUNT(*) as cnt FROM _migrations").get() as { cnt: number }
    ).cnt;

    runMigrations(db);

    const countAfter = (
      db.prepare("SELECT COUNT(*) as cnt FROM _migrations").get() as { cnt: number }
    ).cnt;
    expect(countAfter).toBe(countBefore);

    db.close();
  });
});
