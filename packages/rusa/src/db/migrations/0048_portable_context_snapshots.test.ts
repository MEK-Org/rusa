import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { portableContextSnapshots } from "./0048_portable_context_snapshots.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE actors (
      id        TEXT PRIMARY KEY,
      charter   TEXT NOT NULL
    );
    INSERT INTO actors (id, charter) VALUES ('actor-a', 'a');
    INSERT INTO actors (id, charter) VALUES ('actor-b', 'b');
  `);
  return db;
}

const store = (db: Database.Database, over: { actorId?: string; snapshot?: string } = {}): void => {
  db.prepare("INSERT INTO portable_context_snapshots (actor_id, snapshot) VALUES (?, ?)").run(
    over.actorId ?? "actor-a",
    over.snapshot ?? '{"schemaVersion":3,"actorId":"actor-a","generation":1}'
  );
};

/**
 * The schema half of the cutover. Behavior through the repository is covered in
 * `portable-context-repository.test.ts`; what is pinned here is what the
 * database itself guarantees when application code is bypassed, because that is
 * the part a reviewer is being asked to approve.
 */
describe("0048_portable_context_snapshots", () => {
  it("creates the table on a fresh database", () => {
    const db = seedDb();
    portableContextSnapshots.up(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = 'portable_context_snapshots'"
      )
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(["portable_context_snapshots"]);
  });

  it("keys one snapshot per actor", () => {
    const db = seedDb();
    portableContextSnapshots.up(db);
    store(db);
    expect(() =>
      store(db, { snapshot: '{"schemaVersion":3,"actorId":"actor-a","generation":2}' })
    ).toThrow();
  });

  it("requires a real actor", () => {
    const db = seedDb();
    portableContextSnapshots.up(db);
    expect(() => store(db, { actorId: "no-such-actor" })).toThrow();
  });

  // RESTRICT, because a snapshot is memory no source can reconstruct.
  // Verified against the repository layer as it stands: `ActorRepository`
  // exposes no delete — retirement sets `retired_at` — so no production path is
  // blocked by this.
  it("RESTRICTs deleting an actor that still has stored memory", () => {
    const db = seedDb();
    portableContextSnapshots.up(db);
    store(db);
    expect(() => db.prepare("DELETE FROM actors WHERE id = 'actor-a'").run()).toThrow();
  });

  // The shape contract lives in `parsePortableContextState`, at the point of
  // consumption, exactly as `actors.model_config` and `host_jobs.manifest` do.
  // A CHECK or a `json_valid` here would make every document-shape change a
  // table rebuild, and would still not be the validator the reader needs —
  // reading a v2 document forward is code, not a constraint.
  it("puts no database-level shape constraint on the stored document", () => {
    const db = seedDb();
    portableContextSnapshots.up(db);
    expect(() => store(db, { snapshot: "not json at all" })).not.toThrow();

    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'portable_context_snapshots'")
      .get() as { sql: string };
    expect(sql.sql).not.toMatch(/CHECK|json_valid|json_extract/i);
  });

  // The document is the state. Mirroring its fields into columns would be a
  // second copy of memory with no constraint keeping it honest, and nothing
  // selects on those fields; a real query can add a projection with an index.
  it("stores the document whole with nothing projected into its own column", () => {
    const db = seedDb();
    portableContextSnapshots.up(db);
    const columns = db
      .prepare("SELECT name FROM pragma_table_info('portable_context_snapshots')")
      .all() as { name: string }[];
    expect(columns.map((c) => c.name)).toEqual(["actor_id", "snapshot"]);
  });
});
