import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligations } from "./0016_obligations.js";
import { obligationPriority } from "./0017_obligation_priority.js";
import { obligationResponsive } from "./0049_obligation_responsive.js";

describe("0049_obligation_responsive", () => {
  it("adds nullable responsive and ready_count columns with their CHECKs", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    obligations.up(db);
    obligationPriority.up(db);

    obligationResponsive.up(db);

    const columns = db.prepare("PRAGMA table_info(obligations)").all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["responsive", "ready_count"])
    );

    const insert = db.prepare(
      `INSERT INTO obligations
         (id, parent_id, owner_kind, owner_id, intent, external_ref, status, priority, responsive, ready_count)
       VALUES (?, ?, 'actor', 'actor-a', NULL, NULL, 'ready', 1, ?, ?)`
    );
    insert.run("explicit", null, 1, 1);
    insert.run("inherited", null, null, 0);
    expect(
      db.prepare("SELECT id, responsive, ready_count FROM obligations ORDER BY id").all()
    ).toEqual([
      { id: "explicit", responsive: 1, ready_count: 1 },
      { id: "inherited", responsive: null, ready_count: 0 },
    ]);

    expect(() => insert.run("bad", null, 0, 0)).toThrow(/CHECK/);
    expect(() => insert.run("bad-episode", null, null, -1)).toThrow(/CHECK/);
  });

  it("initializes existing ready rows to ready_count = 1 and unready rows to 0", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    obligations.up(db);
    obligationPriority.up(db);

    const insert = db.prepare(
      `INSERT INTO obligations
         (id, parent_id, owner_kind, owner_id, intent, external_ref, status, priority)
       VALUES (?, null, 'actor', 'actor-a', NULL, NULL, ?, 1)`
    );
    insert.run("pre-existing-ready", "ready");
    insert.run("pre-existing-waiting", "waiting");
    insert.run("pre-existing-done", "done");

    obligationResponsive.up(db);

    expect(
      db.prepare("SELECT id, responsive, ready_count FROM obligations ORDER BY id").all()
    ).toEqual([
      { id: "pre-existing-done", responsive: null, ready_count: 0 },
      { id: "pre-existing-ready", responsive: null, ready_count: 1 },
      { id: "pre-existing-waiting", responsive: null, ready_count: 0 },
    ]);
  });
});
