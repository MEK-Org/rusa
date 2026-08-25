import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { dropMeshEventsPeerId } from "./0023_drop_mesh_events_peer_id.js";

function columnNames(db: Database.Database): string[] {
  return (
    db.prepare("PRAGMA table_info(mesh_events)").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

describe("0023_drop_mesh_events_peer_id", () => {
  it("drops peer_id without disturbing mesh event data", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mesh_events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        actor_id TEXT,
        peer_id TEXT,
        detail TEXT,
        body TEXT,
        payload TEXT,
        success INTEGER
      );
      INSERT INTO mesh_events (
        id, ts, kind, actor_id, peer_id, detail, body, payload, success
      ) VALUES (
        'evt-1', '2026-06-21T00:00:00.000Z', 'message_sent', 'worker-1', 'root',
        'summary', 'body text', '{"messageId":"m1"}', 1
      );
    `);

    expect(columnNames(db)).toContain("peer_id");

    dropMeshEventsPeerId.up(db);

    expect(columnNames(db)).toEqual([
      "id",
      "ts",
      "kind",
      "actor_id",
      "detail",
      "body",
      "payload",
      "success",
    ]);

    expect(db.prepare("SELECT * FROM mesh_events WHERE id = 'evt-1'").get()).toEqual({
      id: "evt-1",
      ts: "2026-06-21T00:00:00.000Z",
      kind: "message_sent",
      actor_id: "worker-1",
      detail: "summary",
      body: "body text",
      payload: '{"messageId":"m1"}',
      success: 1,
    });
  });

  it("is safe for databases that already lack peer_id", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mesh_events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL
      );
    `);

    expect(() => dropMeshEventsPeerId.up(db)).not.toThrow();
    expect(columnNames(db)).toEqual(["id", "ts", "kind"]);
  });
});
