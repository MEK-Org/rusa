import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligations } from "./0016_obligations.js";
import { obligationPriority } from "./0017_obligation_priority.js";

describe("0017_obligation_priority", () => {
  it("replaces queue_position while preserving root order and making children inherit", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    obligations.up(db);
    const insert = db.prepare(
      `INSERT INTO obligations
         (id, parent_id, owner_kind, owner_id, intent, external_ref, status, queue_position)
       VALUES (?, ?, 'actor', 'actor-a', NULL, NULL, 'ready', ?)`
    );
    insert.run("later", null, 8);
    insert.run("earlier", null, 2);
    insert.run("child", "later", 1);

    obligationPriority.up(db);

    const columns = db.prepare("PRAGMA table_info(obligations)").all() as Array<{
      name: string;
    }>;
    expect(columns.map(({ name }) => name)).toContain("priority");
    expect(columns.map(({ name }) => name)).not.toContain("queue_position");
    expect(db.prepare("SELECT id, priority FROM obligations ORDER BY id").all()).toEqual([
      { id: "child", priority: null },
      { id: "earlier", priority: 2 },
      { id: "later", priority: 8 },
    ]);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_obligations_owner_status_priority'"
        )
        .get()
    ).toBeDefined();
  });

  it("rejects non-finite stored priorities", () => {
    const db = new Database(":memory:");
    obligations.up(db);
    obligationPriority.up(db);

    expect(() =>
      db
        .prepare(
          `INSERT INTO obligations
             (id, parent_id, owner_kind, owner_id, intent, external_ref, status, priority)
           VALUES ('infinite', NULL, 'actor', 'actor-a', NULL, NULL, 'ready', ?)`
        )
        .run(Number.POSITIVE_INFINITY)
    ).toThrow("CHECK constraint failed");
  });
});
