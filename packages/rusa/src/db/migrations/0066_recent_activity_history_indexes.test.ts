import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActorRunRepository } from "../repositories/actor-run-repository.js";
import { SqliteInboxRepository } from "../repositories/sqlite-inbox-repository.js";
import { runMigrations } from "./runner.js";

describe("0066_recent_activity_history_indexes", () => {
  let db: Database.Database;
  let inbox: SqliteInboxRepository;
  let runs: ActorRunRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    inbox = new SqliteInboxRepository(db);
    runs = new ActorRunRepository(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  /** Query plan of the exact SQL a store method prepares, so a drifting filter goes red. */
  function planOf(read: () => unknown, ...parameters: unknown[]): string {
    const prepare = vi.spyOn(db, "prepare");
    read();
    const sql = String(prepare.mock.calls[0]?.[0]);
    prepare.mockRestore();
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{
      detail: string;
    }>;
    return plan.map((row) => row.detail).join("\n");
  }

  it("reads the handled feed in index order without scanning or sorting the table", () => {
    const plan = planOf(() => inbox.listRecentHandledEntries(50), 50);
    expect(plan).toContain("USING INDEX idx_actor_inbox_recent_handled");
    expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
  });

  it("reads the completed focus feed in index order without scanning or sorting the table", () => {
    const plan = planOf(() => runs.listRecentCompletedFocuses(100), 100);
    expect(plan).toContain("USING INDEX idx_actor_runs_recent_completed_focus");
    expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
  });
});
