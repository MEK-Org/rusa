import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { dropMeshEventsCreatedAt } from "./0018_drop_mesh_events_created_at.js";

function columnNames(db: Database.Database): string[] {
  return (
    db.prepare("PRAGMA table_info(mesh_events)").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

describe("0018_drop_mesh_events_created_at", () => {
  it("drops created_at without disturbing mesh event data", () => {
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
        success INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO mesh_events (
        id, ts, kind, actor_id, peer_id, detail, body, payload, success, created_at
      ) VALUES (
        'evt-1', '2026-06-21T00:00:00.000Z', 'message_sent', 'worker-1', 'root',
        'summary', 'body text', '{"messageId":"m1"}', 1, '2026-06-21 00:00:00'
      );
    `);

    expect(columnNames(db)).toContain("created_at");

    dropMeshEventsCreatedAt.up(db);

    expect(columnNames(db)).toEqual([
      "id",
      "ts",
      "kind",
      "actor_id",
      "peer_id",
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
      peer_id: "root",
      detail: "summary",
      body: "body text",
      payload: '{"messageId":"m1"}',
      success: 1,
    });
  });

  it("is safe for databases that already lack created_at", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mesh_events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL
      );
    `);

    expect(() => dropMeshEventsCreatedAt.up(db)).not.toThrow();
    expect(columnNames(db)).toEqual(["id", "ts", "kind"]);
  });

  it("verifies the documented reverse reconstructs created_at from ts", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mesh_events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO mesh_events (id, ts, kind, created_at) VALUES
        ('e1', '2026-06-25T20:13:16.930Z', 'run_start', '2026-06-25 20:13:17'),
        ('e2', '2026-06-27T16:49:48.693Z', 'run_end', '2026-06-27 16:49:50');
    `);

    // Apply migration (drop created_at)
    dropMeshEventsCreatedAt.up(db);
    expect(columnNames(db)).not.toContain("created_at");

    // Execute reverse recipe from runbook / migration header
    db.exec(`
      ALTER TABLE mesh_events ADD COLUMN created_at TEXT;
      UPDATE mesh_events SET created_at = datetime(ts);
    `);

    expect(columnNames(db)).toContain("created_at");

    const rows = db
      .prepare("SELECT id, created_at FROM mesh_events ORDER BY id ASC")
      .all() as Array<{ id: string; created_at: string }>;

    expect(rows).toEqual([
      { id: "e1", created_at: "2026-06-25 20:13:16" },
      { id: "e2", created_at: "2026-06-27 16:49:48" },
    ]);
  });
});
