import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteInboxRepository } from "../repositories/sqlite-inbox-repository.js";
import { runMigrations } from "./runner.js";

describe("0068_actor_inbox_delivered_index", () => {
  let db: Database.Database;
  let inbox: SqliteInboxRepository;

  function seedEntries(
    database: Database.Database,
    actorId = "test-actor",
    handledCount = 50,
    unhandledCount = 5
  ) {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const insert = database.prepare(`
      INSERT INTO actor_inbox_entries (id, actor_id, source, delivered_at, handled_at, payload_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    database.transaction(() => {
      for (let i = 1; i <= handledCount; i++) {
        const delivered = new Date(now.getTime() - (handledCount - i) * 1000).toISOString();
        const handled = new Date(now.getTime() - (handledCount - i) * 1000 + 500).toISOString();
        const source = i % 2 === 0 ? "github:repo:issue" : "mesh:peer:message";
        const payload = i === 10 ? { priority: "responsive", type: "urgent" } : { type: "normal" };
        insert.run(
          `entry-${String(i).padStart(6, "0")}`,
          actorId,
          source,
          delivered,
          handled,
          JSON.stringify(payload)
        );
      }
      for (let j = 1; j <= unhandledCount; j++) {
        insert.run(
          `unhandled-${j}`,
          actorId,
          "mesh:peer",
          new Date(now.getTime() + j * 1000).toISOString(),
          null,
          JSON.stringify({ type: "normal" })
        );
      }
      // Populate a second actor to ensure realistic multi-actor stats
      for (let k = 1; k <= 10; k++) {
        insert.run(
          `other-${k}`,
          "other-actor",
          "mesh:peer",
          new Date(now.getTime() - k * 1000).toISOString(),
          new Date(now.getTime() - k * 1000 + 100).toISOString(),
          JSON.stringify({ type: "normal" })
        );
      }
    })();
  }

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    seedEntries(db);
    db.exec("ANALYZE;");
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

  it("reads an actor's handled inbox in index order without temporary sort after ANALYZE", () => {
    const plan = planOf(
      () => inbox.list("test-actor", { status: "handled", limit: 10 }),
      "test-actor",
      11
    );
    expect(plan).toContain("USING INDEX idx_actor_inbox_delivered");
    expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
  });

  it("reads an actor's entire inbox in index order without temporary sort after ANALYZE", () => {
    const plan = planOf(
      () => inbox.list("test-actor", { status: "all", limit: 10 }),
      "test-actor",
      11
    );
    expect(plan).toContain("USING INDEX idx_actor_inbox_delivered");
    expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
  });

  it("preserves unhandled listing on actor_inbox_unhandled index after ANALYZE", () => {
    const plan = planOf(
      () => inbox.list("test-actor", { status: "unhandled", limit: 10 }),
      "test-actor",
      11
    );
    expect(plan).toContain("USING INDEX actor_inbox_unhandled");
    expect(plan).not.toContain("TEMP B-TREE FOR ORDER BY");
  });

  it("proves query plans fail without 0068 (requiring TEMP B-TREE FOR ORDER BY)", () => {
    // Drop the 0068 index and re-analyze to simulate pre-0068 schema with statistics
    db.exec("DROP INDEX idx_actor_inbox_delivered; ANALYZE;");

    const handledPlan = planOf(
      () => inbox.list("test-actor", { status: "handled", limit: 10 }),
      "test-actor",
      11
    );
    expect(handledPlan).toContain("USE TEMP B-TREE FOR ORDER BY");
    expect(handledPlan).not.toContain("idx_actor_inbox_delivered");

    const allPlan = planOf(
      () => inbox.list("test-actor", { status: "all", limit: 10 }),
      "test-actor",
      11
    );
    expect(allPlan).toContain("USE TEMP B-TREE FOR ORDER BY");
    expect(allPlan).not.toContain("idx_actor_inbox_delivered");
  });

  it("serves seeded history with exact order, pagination cursor, and unhandled count", () => {
    const actorId = "test-actor";

    // 1. Handled listing page 1
    const p1 = inbox.list(actorId, { status: "handled", limit: 10 });
    expect(p1.entries).toHaveLength(10);
    expect(p1.unhandledCount).toBe(5);
    expect(p1.entries[0]?.id).toBe("entry-000050");
    expect(p1.entries[9]?.id).toBe("entry-000041");
    expect(p1.nextCursor).toBeDefined();

    // 2. Handled listing page 2 via cursor
    expect(p1.nextCursor).not.toBeNull();
    const p2 = inbox.list(actorId, {
      status: "handled",
      limit: 10,
      cursor: p1.nextCursor ?? undefined,
    });
    expect(p2.entries).toHaveLength(10);
    expect(p2.entries[0]?.id).toBe("entry-000040");
    expect(p2.entries[9]?.id).toBe("entry-000031");

    // 3. Status "all" includes unhandled entries in chronological delivered_at order
    const allP1 = inbox.list(actorId, { status: "all", limit: 5 });
    expect(allP1.entries).toHaveLength(5);
    expect(allP1.entries[0]?.id).toBe("unhandled-5");
    expect(allP1.entries[1]?.id).toBe("unhandled-4");
    expect(allP1.entries[2]?.id).toBe("unhandled-3");
    expect(allP1.entries[3]?.id).toBe("unhandled-2");
    expect(allP1.entries[4]?.id).toBe("unhandled-1");

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
    expect(responsive.entries[0]?.id).toBe("entry-000010");
  });
});
