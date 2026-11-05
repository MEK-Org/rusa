import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActorRunModelConfig } from "../repositories/actor-run-model-config.js";
import { ActorRunRepository } from "../repositories/actor-run-repository.js";
import { SqliteInboxRepository } from "../repositories/sqlite-inbox-repository.js";
import { runMigrations } from "./runner.js";

const HANDLED_INDEX = "idx_actor_inbox_recent_handled";
const COMPLETED_INDEX = "idx_actor_runs_recent_completed_focus";
const MODEL_CONFIG = createActorRunModelConfig({ provider: "test", model: "test" });

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

  function seedHandledEntries(): void {
    inbox.append(
      ["tied-a", "tied-b", "tied-c", "older", "other-actor", "unhandled"].map((id) => ({
        id,
        actorId: id === "other-actor" ? "actor-b" : "actor-a",
        source: `mesh:${id}`,
        payload: { type: "mesh.message" },
      }))
    );
    inbox.markHandled("actor-a", ["older"], new Date("2026-11-05T10:00:00.000Z"), "older");
    inbox.markHandled("actor-b", ["other-actor"], new Date("2026-11-05T10:30:00.000Z"), "other");
    // One batch shares a timestamp, so only the id key can order these rows.
    inbox.markHandled(
      "actor-a",
      ["tied-a", "tied-b", "tied-c"],
      new Date("2026-11-05T11:00:00.000Z"),
      "batch"
    );
  }

  function seedCompletedRuns(): void {
    const finish = (id: string, endedAt: string, focus: boolean) => {
      runs.start({
        id,
        actorId: "actor-a",
        startedAt: "2026-11-05T09:00:00.000Z",
        modelConfig: MODEL_CONFIG,
      });
      if (focus) {
        db.prepare("UPDATE actor_runs SET focus_entry_ids_json = ? WHERE id = ?").run(
          JSON.stringify([`entry-${id}`]),
          id
        );
      }
      runs.complete(id, { endedAt, success: true, exitCode: 0, output: id });
    };
    finish("tied-a", "2026-11-05T11:00:00.000Z", true);
    finish("tied-b", "2026-11-05T11:00:00.000Z", true);
    finish("older", "2026-11-05T10:00:00.000Z", true);
    finish("no-focus", "2026-11-05T12:00:00.000Z", false);
    // Excluded by outcome and by having no end, each newer than every match.
    runs.start({
      id: "open",
      actorId: "actor-a",
      startedAt: "2026-11-05T13:00:00.000Z",
      modelConfig: MODEL_CONFIG,
    });
    db.prepare("UPDATE actor_runs SET focus_entry_ids_json = '[]' WHERE id = 'open'").run();
    db.prepare(
      `INSERT INTO actor_runs (id, actor_id, started_at, ended_at, outcome, focus_entry_ids_json)
       VALUES ('abandoned', 'actor-a', '2026-11-05T13:00:00.000Z', '2026-11-05T14:00:00.000Z', 'abandoned', '[]')`
    ).run();
  }

  it("reads the handled feed in index order without scanning or sorting", () => {
    const plan = planOf(() => inbox.listRecentHandledEntries(50), 50);
    expect(plan).toContain(`USING INDEX ${HANDLED_INDEX}`);
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("reads the completed focus feed in index order without scanning or sorting", () => {
    const plan = planOf(() => runs.listRecentCompletedFocuses(100), 100);
    expect(plan).toContain(`USING INDEX ${COMPLETED_INDEX}`);
    expect(plan).not.toContain("TEMP B-TREE");
  });

  it("keeps the per-actor handled listing on its own actor index", () => {
    const plan = planOf(
      () => inbox.list("actor-a", { status: "handled", limit: 10 }),
      "actor-a",
      11
    );
    expect(plan).toContain("USING INDEX actor_inbox_");
    expect(plan).not.toContain(HANDLED_INDEX);
  });

  it("returns the same handled rows, ties and limits with and without the index", () => {
    seedHandledEntries();
    const read = () => [1, 2, 4, 50].map((limit) => inbox.listRecentHandledEntries(limit));
    const indexed = read();
    expect(indexed[3]?.map((entry) => entry.id)).toEqual([
      "tied-c",
      "tied-b",
      "tied-a",
      "other-actor",
      "older",
    ]);

    db.exec(`DROP INDEX ${HANDLED_INDEX}`);
    expect(read()).toEqual(indexed);
  });

  it("returns the same completed focus rows, ties and limits with and without the index", () => {
    seedCompletedRuns();
    const read = () => [1, 2, 100].map((limit) => runs.listRecentCompletedFocuses(limit));
    const indexed = read();
    expect(indexed[2]?.map((run) => run.entryIds)).toEqual([
      ["entry-tied-b"],
      ["entry-tied-a"],
      ["entry-older"],
    ]);

    db.exec(`DROP INDEX ${COMPLETED_INDEX}`);
    expect(read()).toEqual(indexed);
  });
});
