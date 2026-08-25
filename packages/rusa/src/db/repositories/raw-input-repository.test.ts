import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { RawInputRepository } from "./raw-input-repository.js";

describe("RawInputRepository", () => {
  let db: Database.Database;
  let repo: RawInputRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    repo = new RawInputRepository(db);
  });

  it("inserts raw inputs idempotently and reads rich objects", () => {
    const inserted = repo.insert({
      id: "ri-1",
      platform: "github",
      providerEventId: "event-1",
      repo: "owner/repo",
      issueNumber: 1,
      prNumber: null,
      author: "user",
      content: "hello",
      metadata: JSON.stringify({ action: "opened" }),
    });
    const duplicate = repo.insert({
      id: "ri-duplicate",
      platform: "github",
      providerEventId: "event-1",
      repo: "owner/repo",
      issueNumber: 1,
      prNumber: null,
      author: "user",
      content: "hello again",
      metadata: null,
    });

    expect(inserted).toBe(true);
    expect(duplicate).toBe(false);
    expect(repo.getUnprocessed()[0]).toMatchObject({
      id: "ri-1",
      providerEventId: "event-1",
      issueNumber: 1,
      processedAt: null,
    });
  });

  it("marks inputs processed and counts pending distillation inputs", () => {
    insertFixture("ri-1");
    insertFixture("ri-2");

    repo.markProcessed(["ri-1"]);

    expect(repo.countPendingDistillation()).toBe(1);
    expect(repo.getPendingDistillation()).toEqual([expect.objectContaining({ id: "ri-2" })]);
  });

  it("resets processed inputs, optionally since a timestamp", () => {
    insertFixture("old", "2026-06-05 10:00:00");
    insertFixture("new", "2026-06-05 12:00:00");
    repo.markProcessed(["old", "new"]);

    expect(repo.resetDistillation("2026-06-05T11:00:00Z")).toBe(1);

    expect(repo.getPendingDistillation()).toEqual([expect.objectContaining({ id: "new" })]);
  });

  function insertFixture(id: string, createdAt = "2026-06-05 12:00:00"): void {
    repo.insert({
      id,
      platform: "github",
      providerEventId: id,
      repo: "owner/repo",
      issueNumber: null,
      prNumber: null,
      author: "user",
      content: `content ${id}`,
      metadata: null,
    });
    // Stable ordering/timestamps for reset tests.
    db.prepare(`UPDATE raw_inputs SET created_at = ? WHERE id = ?`).run(createdAt, id);
  }
});
