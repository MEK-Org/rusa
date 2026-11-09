import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteInboxRepository } from "../repositories/sqlite-inbox-repository.js";
import { runMigrations } from "./runner.js";

describe("0068_actor_inbox_delivered_index", () => {
  let db: Database.Database;
  let inbox: SqliteInboxRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    inbox = new SqliteInboxRepository(db);
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

  it("reads an actor's handled inbox in index order without temporary sort", () => {
    const plan = planOf(
      () => inbox.list("test-actor", { status: "handled", limit: 10 }),
      "test-actor",
      11
    );
    expect(plan).toContain("USING INDEX idx_actor_inbox_delivered");
    expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
  });

  it("reads an actor's entire inbox in index order without temporary sort", () => {
    const plan = planOf(
      () => inbox.list("test-actor", { status: "all", limit: 10 }),
      "test-actor",
      11
    );
    expect(plan).toContain("USING INDEX idx_actor_inbox_delivered");
    expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
  });

  it("preserves unhandled listing on actor_inbox_unhandled index", () => {
    const plan = planOf(
      () => inbox.list("test-actor", { status: "unhandled", limit: 10 }),
      "test-actor",
      11
    );
    expect(plan).toContain("USING INDEX actor_inbox_unhandled");
    expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
  });

  it("serves a large seeded history with exact order, pagination cursor, and unhandled count", () => {
    const actorId = "heavy-actor";
    const totalHandled = 1500;
    const now = new Date("2026-11-09T12:00:00.000Z");

    // Fast batch insert of synthetic handled entries
    const insert = db.prepare(`
      INSERT INTO actor_inbox_entries (id, actor_id, source, delivered_at, handled_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction(() => {
      for (let i = 1; i <= totalHandled; i++) {
        const delivered = new Date(now.getTime() - (totalHandled - i) * 1000).toISOString();
        const handled = new Date(now.getTime() - (totalHandled - i) * 1000 + 500).toISOString();
        const source = i % 2 === 0 ? "github:repo:issue" : "mesh:peer:message";
        const payload = i === 100 ? { priority: "responsive", type: "urgent" } : { type: "normal" };
        insert.run(
          `entry-${String(i).padStart(6, "0")}`,
          actorId,
          source,
          delivered,
          handled,
          JSON.stringify(payload)
        );
      }
      // Add 2 unhandled entries at the end
      insert.run(
        "unhandled-1",
        actorId,
        "mesh:peer",
        new Date(now.getTime() + 1000).toISOString(),
        null,
        JSON.stringify({ type: "normal" })
      );
      insert.run(
        "unhandled-2",
        actorId,
        "mesh:peer",
        new Date(now.getTime() + 2000).toISOString(),
        null,
        JSON.stringify({ priority: "responsive", type: "alert" })
      );
    });
    insertMany();

    // 1. Handled listing page 1
    const p1 = inbox.list(actorId, { status: "handled", limit: 10 });
    expect(p1.entries).toHaveLength(10);
    expect(p1.unhandledCount).toBe(2);
    expect(p1.entries[0]?.id).toBe("entry-001500");
    expect(p1.entries[9]?.id).toBe("entry-001491");
    expect(p1.nextCursor).toBeDefined();

    // 2. Handled listing page 2 via cursor
    expect(p1.nextCursor).not.toBeNull();
    const p2 = inbox.list(actorId, {
      status: "handled",
      limit: 10,
      cursor: p1.nextCursor ?? undefined,
    });
    expect(p2.entries).toHaveLength(10);
    expect(p2.entries[0]?.id).toBe("entry-001490");
    expect(p2.entries[9]?.id).toBe("entry-001481");

    // 3. Status "all" includes unhandled entries in chronological delivered_at order
    const allP1 = inbox.list(actorId, { status: "all", limit: 5 });
    expect(allP1.entries).toHaveLength(5);
    expect(allP1.entries[0]?.id).toBe("unhandled-2");
    expect(allP1.entries[1]?.id).toBe("unhandled-1");
    expect(allP1.entries[2]?.id).toBe("entry-001500");

    // 4. Source filtering
    const githubOnly = inbox.list(actorId, {
      status: "handled",
      source: "github:repo:issue",
      limit: 10,
    });
    expect(githubOnly.entries).toHaveLength(10);
    for (const e of githubOnly.entries) {
      expect(e.source).toBe("github:repo:issue");
    }

    // 5. Responsive-only filtering
    const responsive = inbox.list(actorId, { status: "handled", responsiveOnly: true, limit: 10 });
    expect(responsive.entries).toHaveLength(1);
    expect(responsive.entries[0]?.id).toBe("entry-000100");
  });
});
