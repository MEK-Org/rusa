import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligations } from "./0016_obligations.js";
import { obligationPriority } from "./0017_obligation_priority.js";
import { obligationResponsive } from "./0049_obligation_responsive.js";

describe("0049_obligation_responsive", () => {
  it("adds a nullable responsive column that accepts only 0, 1, or NULL", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    obligations.up(db);
    obligationPriority.up(db);

    obligationResponsive.up(db);

    const columns = db.prepare("PRAGMA table_info(obligations)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toContain("responsive");

    const insert = db.prepare(
      `INSERT INTO obligations
         (id, parent_id, owner_kind, owner_id, intent, external_ref, status, priority, responsive)
       VALUES (?, ?, 'actor', 'actor-a', NULL, NULL, 'ready', 1, ?)`
    );
    insert.run("explicit", null, 1);
    insert.run("inherited", null, null);
    expect(db.prepare("SELECT id, responsive FROM obligations ORDER BY id").all()).toEqual([
      { id: "explicit", responsive: 1 },
      { id: "inherited", responsive: null },
    ]);

    expect(() => insert.run("bad", null, 2)).toThrow(/CHECK/);
  });
});
