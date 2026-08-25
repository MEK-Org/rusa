import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { MaintenanceRepository } from "./maintenance-repository.js";

describe("MaintenanceRepository", () => {
  let db: Database.Database;
  let repo: MaintenanceRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    repo = new MaintenanceRepository(db);
  });

  it("detects pending distillation work and returns the next queued task", () => {
    insertTask("later", "queued", "distiller", "2026-06-05 12:00:00");
    insertTask("now", "queued", "distiller", null);
    insertTask("other", "queued", "code-implementer", null);

    expect(repo.hasPendingDistillationTask()).toBe(true);
    expect(repo.getNextQueuedTask()?.id).toBe("now");
  });

  it("returns recent completed maintenance tasks only", () => {
    insertTask("old-done", "done", "distiller", null, "2026-06-05 10:00:00");
    insertTask("new-blocked", "blocked", "distiller", null, "2026-06-05 12:00:00");
    insertTask("queued", "queued", "distiller", null, "2026-06-05 13:00:00");

    expect(repo.getRecentTasks().map((task) => task.id)).toEqual(["new-blocked", "old-done"]);
  });

  function insertTask(
    id: string,
    status: string,
    persona: string,
    notBefore: string | null,
    updatedAt = "2026-06-05 11:00:00"
  ): void {
    db.prepare(
      `INSERT INTO tasks (id, repo, source, status, persona, context, not_before, updated_at)
       VALUES (?, 'owner/repo', 'maintenance', ?, ?, '{}', ?, ?)`
    ).run(id, status, persona, notBefore, updatedAt);
  }
});
