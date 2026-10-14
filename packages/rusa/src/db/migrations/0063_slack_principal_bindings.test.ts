import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";

const AT = "2026-10-14T00:00:00.000Z";

function insertUser(db: Database.Database, id: string, email: string) {
  db.prepare("INSERT INTO principals (id, kind, created_at) VALUES (?, 'user', ?)").run(id, AT);
  db.prepare("INSERT INTO users (principal_id, email) VALUES (?, ?)").run(id, email);
}

function migrated(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db, { throughId: "0059_obligation_completion_matchers" });
  insertUser(db, "alice", "alice@example.test");
  insertUser(db, "operator", "operator@example.test");
  runMigrations(db);
  return db;
}

const insertBinding = (db: Database.Database, values: Record<string, string | null>) =>
  db
    .prepare(
      `INSERT INTO slack_principal_bindings
         (workspace_id, slack_user_id, principal_id, granted_at, granted_by, grant_ref,
          revoked_at, revoked_by, revoke_ref)
       VALUES (@workspace_id, @slack_user_id, @principal_id, @granted_at, @granted_by,
               @grant_ref, @revoked_at, @revoked_by, @revoke_ref)`
    )
    .run({
      workspace_id: "T0HOME",
      slack_user_id: "U0ALICE",
      principal_id: "alice",
      granted_at: AT,
      granted_by: "operator",
      grant_ref: "mesh:messages/decision",
      revoked_at: null,
      revoked_by: null,
      revoke_ref: null,
      ...values,
    });

describe("0063_slack_principal_bindings", () => {
  it("upgrades to empty tables and leaves existing users unchanged", () => {
    const db = migrated();

    expect(db.prepare("SELECT COUNT(*) AS n FROM slack_principal_bindings").get()).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM slack_principal_binding_events").get()).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT principal_id, email FROM users ORDER BY principal_id").all()).toEqual(
      [
        { principal_id: "alice", email: "alice@example.test" },
        { principal_id: "operator", email: "operator@example.test" },
      ]
    );
  });

  it("keys a binding by the exact pair and admits only Slack-shaped ids", () => {
    const db = migrated();
    insertBinding(db, {});
    // The same user id in another workspace is a different identity.
    insertBinding(db, { workspace_id: "T0OTHER" });
    // Case is preserved, not folded.
    insertBinding(db, { slack_user_id: "u0alice" });

    expect(() => insertBinding(db, {})).toThrow(/UNIQUE|PRIMARY KEY/);
    const malformed: Array<Record<string, string>> = [
      { slack_user_id: "alice@example.test" },
      { slack_user_id: "Alice Example" },
      { slack_user_id: " U0ALICE" },
      { slack_user_id: "" },
      { workspace_id: "" },
      { workspace_id: "T0/HOME" },
    ];
    for (const bad of malformed) {
      expect(
        () => insertBinding(db, { workspace_id: "T0NEW", ...bad }),
        JSON.stringify(bad)
      ).toThrow(/CHECK/);
    }
  });

  it("binds and grants only through users, and keeps the revoke triple whole", () => {
    const db = migrated();
    db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('some-actor', 'c', NULL, ?)"
    ).run(AT);

    expect(() => insertBinding(db, { principal_id: "some-actor" })).toThrow(/FOREIGN KEY/);
    expect(() => insertBinding(db, { principal_id: "system:mesh" })).toThrow(/FOREIGN KEY/);
    expect(() => insertBinding(db, { granted_by: "some-actor" })).toThrow(/FOREIGN KEY/);
    expect(() => insertBinding(db, { grant_ref: "  " })).toThrow(/CHECK/);
    expect(() => insertBinding(db, { revoked_at: AT })).toThrow(/CHECK/);
    expect(() => insertBinding(db, { revoked_at: AT, revoked_by: "operator" })).toThrow(/CHECK/);

    insertBinding(db, {
      revoked_at: AT,
      revoked_by: "operator",
      revoke_ref: "mesh:messages/revoked",
    });
    expect(() => db.prepare("DELETE FROM users WHERE principal_id = 'alice'").run()).toThrow(
      /FOREIGN KEY/
    );
  });
});
