import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runLifecycleTaxonomy } from "./0008_run_lifecycle_taxonomy.js";

describe("0008 run lifecycle taxonomy", () => {
  it("swaps lifecycle meanings without rewriting any bodies", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mesh_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT);
      INSERT INTO mesh_events (id, kind, body) VALUES
        ('queued', 'run_start', '{"sourceEventIds":["end-1"]}'),
        ('started', 'run_admitted', NULL),
        ('ended', 'run_end', 'forensic transcript');
    `);

    runLifecycleTaxonomy.up(db);

    expect(db.prepare("SELECT id, kind, body FROM mesh_events ORDER BY id").all()).toEqual([
      { id: "ended", kind: "run_end", body: "forensic transcript" },
      { id: "queued", kind: "run_queued", body: '{"sourceEventIds":["end-1"]}' },
      { id: "started", kind: "run_start", body: null },
    ]);
    db.close();
  });
});
