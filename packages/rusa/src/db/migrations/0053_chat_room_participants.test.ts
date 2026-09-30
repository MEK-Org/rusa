import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { chatRoomParticipants } from "./0053_chat_room_participants.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE actors (
      id        TEXT PRIMARY KEY,
      charter   TEXT NOT NULL
    );
    INSERT INTO actors (id, charter) VALUES ('root', 'r'), ('actor-a', 'a');
  `);
  return db;
}

/**
 * What the database itself guarantees for room membership when application
 * code is bypassed. Behavior through the service is covered in
 * `chat-room.test.ts`.
 */
describe("0053_chat_room_participants", () => {
  it("creates an empty roster table keyed by actor", () => {
    const db = seedDb();
    chatRoomParticipants.up(db);

    const columns = db.prepare("PRAGMA table_info(chat_room_participants)").all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    expect(columns.map(({ name, notnull, pk }) => ({ name, notnull, pk }))).toEqual([
      { name: "actor_id", notnull: 0, pk: 1 },
      { name: "added_by", notnull: 1, pk: 0 },
      { name: "added_at", notnull: 1, pk: 0 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chat_room_participants").get()).toEqual({ n: 0 });
  });

  it("allows one row per existing actor and refuses unknown actors", () => {
    const db = seedDb();
    chatRoomParticipants.up(db);
    const insert = db.prepare(
      "INSERT INTO chat_room_participants (actor_id, added_by, added_at) VALUES (?, 'root', '2026-09-30T00:00:00.000Z')"
    );

    insert.run("actor-a");
    expect(() => insert.run("actor-a")).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() => insert.run("missing")).toThrow(/FOREIGN KEY/);
  });

  it("keeps an actor row from being deleted while it is a participant", () => {
    const db = seedDb();
    chatRoomParticipants.up(db);
    db.prepare(
      "INSERT INTO chat_room_participants (actor_id, added_by, added_at) VALUES ('actor-a', 'root', '2026-09-30T00:00:00.000Z')"
    ).run();

    expect(() => db.prepare("DELETE FROM actors WHERE id = 'actor-a'").run()).toThrow(
      /FOREIGN KEY/
    );
  });
});
