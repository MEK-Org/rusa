import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligations } from "./0016_obligations.js";
import { obligationPriority } from "./0017_obligation_priority.js";
import { obligationSnooze } from "./0052_obligation_snooze.js";

describe("0052_obligation_snooze", () => {
  it("adds a nullable snoozed_until column without touching existing rows", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    obligations.up(db);
    obligationPriority.up(db);
    db.prepare(
      `INSERT INTO obligations
         (id, parent_id, owner_kind, owner_id, intent, external_ref, status, priority)
       VALUES ('existing', NULL, 'actor', 'actor-a', NULL, NULL, 'ready', 1)`
    ).run();

    obligationSnooze.up(db);

    const columns = db.prepare("PRAGMA table_info(obligations)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    expect(columns.find((column) => column.name === "snoozed_until")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    expect(db.prepare("SELECT id, status, snoozed_until FROM obligations").all()).toEqual([
      { id: "existing", status: "ready", snoozed_until: null },
    ]);

    db.prepare("UPDATE obligations SET snoozed_until = ? WHERE id = 'existing'").run(
      "2026-10-01T09:00:00.000Z"
    );
    expect(db.prepare("SELECT snoozed_until FROM obligations WHERE id = 'existing'").get()).toEqual(
      { snoozed_until: "2026-10-01T09:00:00.000Z" }
    );
  });
});
