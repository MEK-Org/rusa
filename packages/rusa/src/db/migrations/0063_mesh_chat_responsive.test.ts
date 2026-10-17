import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { meshChatResponsive } from "./0063_mesh_chat_responsive.js";

describe("0063_mesh_chat_responsive", () => {
  it("adds nullable send-time diagnostics without rewriting historical rows", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mesh_chat (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        body TEXT NOT NULL,
        session_id TEXT
      );
      INSERT INTO mesh_chat VALUES ('legacy', '2026-10-17T00:00:00.000Z', 'user', 'actor', 'keep', NULL);
    `);

    meshChatResponsive.up(db);

    expect(
      db.prepare("SELECT responsive, responsive_reason FROM mesh_chat WHERE id = 'legacy'").get()
    ).toEqual({ responsive: null, responsive_reason: null });
    db.prepare(
      "INSERT INTO mesh_chat(id, ts, sender_id, recipient_id, body, responsive, responsive_reason) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "new",
      "2026-10-17T00:01:00.000Z",
      "actor",
      "peer",
      "stamped",
      1,
      "responsive obligation"
    );
    expect(() =>
      db
        .prepare(
          "INSERT INTO mesh_chat(id, ts, sender_id, recipient_id, body, responsive) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run("bad", "2026-10-17T00:02:00.000Z", "actor", "peer", "invalid", 2)
    ).toThrow(/CHECK/);
  });
});
