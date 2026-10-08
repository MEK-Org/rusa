import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "./runner.js";

function insertUser(db: Database.Database, id: string, email: string, subject: string | null) {
  db.prepare("INSERT INTO principals (id, kind, created_at) VALUES (?, 'user', ?)").run(
    id,
    "2026-10-01T00:00:00.000Z"
  );
  db.prepare(
    `INSERT INTO users (principal_id, email, firebase_issuer, firebase_subject)
     VALUES (?, ?, ?, ?)`
  ).run(id, email, subject === null ? null : "https://securetoken.google.com/p", subject);
}

describe("0058_user_google_account_id", () => {
  it("adds a nullable google_account_id to existing users and keeps their identity", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, { throughId: "0053_chat_room_participants" });
    insertUser(db, "bound", "bound@example.com", "subject-1");
    insertUser(db, "unbound", "unbound@example.com", null);

    runMigrations(db);

    const columns = db.prepare("PRAGMA table_info(users)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: unknown;
    }>;
    expect(columns.find((column) => column.name === "google_account_id")).toMatchObject({
      notnull: 0,
      dflt_value: null,
    });
    expect(
      db
        .prepare(
          "SELECT principal_id, email, firebase_subject, google_account_id FROM users ORDER BY principal_id"
        )
        .all()
    ).toEqual([
      {
        principal_id: "bound",
        email: "bound@example.com",
        firebase_subject: "subject-1",
        google_account_id: null,
      },
      {
        principal_id: "unbound",
        email: "unbound@example.com",
        firebase_subject: null,
        google_account_id: null,
      },
    ]);
  });

  it("lets one Google account name at most one user and rejects an empty id", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    insertUser(db, "a", "a@example.com", "subject-a");
    insertUser(db, "b", "b@example.com", "subject-b");
    const set = db.prepare("UPDATE users SET google_account_id = ? WHERE principal_id = ?");

    set.run("100000000000000000001", "a");
    expect(() => set.run("100000000000000000001", "b")).toThrow(/UNIQUE/);
    expect(() => set.run("", "b")).toThrow(/CHECK/);
  });
});
