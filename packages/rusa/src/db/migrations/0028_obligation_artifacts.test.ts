import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligationArtifacts } from "./0028_obligation_artifacts.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE obligations (
      id        TEXT PRIMARY KEY,
      owner_id  TEXT NOT NULL,
      status    TEXT NOT NULL
    );
    INSERT INTO obligations (id, owner_id, status) VALUES ('ob-1', 'actor-a', 'ready');
  `);
  return db;
}

function attach(db: Database.Database, ref: string, id = "a1", obligation = "ob-1"): void {
  db.prepare(
    `INSERT INTO obligation_artifacts (id, obligation_id, ref, attached_at)
     VALUES (?, ?, ?, '2026-08-30T00:00:00.000Z')`
  ).run(id, obligation, ref);
}

describe("0028_obligation_artifacts", () => {
  it("creates the table and resolution_ref, idempotently", () => {
    const db = seedDb();
    obligationArtifacts.up(db);
    expect(() => obligationArtifacts.up(db)).not.toThrow();

    const columns = (
      db.prepare("PRAGMA table_info(obligations)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain("resolution_ref");
  });

  it("allows many artifacts per obligation but not the same one twice", () => {
    const db = seedDb();
    obligationArtifacts.up(db);

    attach(db, "mesh:messages/m1", "a1");
    attach(db, "github:o/r/pulls/7", "a2");
    expect(() => attach(db, "mesh:messages/m1", "a3")).toThrow();

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM obligation_artifacts WHERE obligation_id = 'ob-1'")
      .get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("refuses an artifact for an obligation that does not exist", () => {
    const db = seedDb();
    obligationArtifacts.up(db);
    expect(() => attach(db, "mesh:messages/m1", "a1", "nope")).toThrow();
  });

  it("drops an obligation's artifacts with it, unlike its children", () => {
    const db = seedDb();
    obligationArtifacts.up(db);
    attach(db, "mesh:messages/m1");

    // CASCADE, not RESTRICT: a citation has no meaning without the obligation
    // that made it, so it must not be the thing that blocks a delete.
    db.prepare("DELETE FROM obligations WHERE id = 'ob-1'").run();
    const count = db.prepare("SELECT COUNT(*) AS n FROM obligation_artifacts").get() as {
      n: number;
    };
    expect(count.n).toBe(0);
  });
});
