import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { isReference } from "../../references/reference.js";
import { referenceGrammar } from "./0029_reference_grammar.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE obligations (
      id             TEXT PRIMARY KEY,
      owner_id       TEXT NOT NULL,
      status         TEXT NOT NULL,
      external_ref   TEXT,
      resolution_ref TEXT
    );
    CREATE TABLE obligation_artifacts (
      id            TEXT PRIMARY KEY,
      obligation_id TEXT NOT NULL,
      ref           TEXT NOT NULL
    );
  `);
  return db;
}

function insertObligation(
  db: Database.Database,
  id: string,
  externalRef: string | null,
  resolutionRef: string | null = null
): void {
  db.prepare(
    "INSERT INTO obligations (id, owner_id, status, external_ref, resolution_ref) VALUES (?, 'actor-a', 'ready', ?, ?)"
  ).run(id, externalRef, resolutionRef);
}

function refOf(db: Database.Database, id: string): string | null {
  return (
    db.prepare("SELECT external_ref FROM obligations WHERE id = ?").get(id) as {
      external_ref: string | null;
    }
  ).external_ref;
}

describe("0029_reference_grammar", () => {
  it("rewrites GitHub identity claims onto the path grammar", () => {
    const db = seedDb();
    insertObligation(db, "issue", "github_issue:MEK-Org/rusa#33");
    insertObligation(db, "pull", "github_pr:MEK-Org/rusa#76");

    referenceGrammar.up(db);

    expect(refOf(db, "issue")).toBe("github:MEK-Org/rusa/issues/33");
    // GitHub's singular `/pull/` is a URL wrinkle, not our vocabulary.
    expect(refOf(db, "pull")).toBe("github:MEK-Org/rusa/pulls/76");
    expect(isReference(refOf(db, "pull") ?? "")).toBe(true);
  });

  it("rewrites artifact and resolution references", () => {
    const db = seedDb();
    insertObligation(db, "answered", null, "mesh_chat:abc-123");
    db.prepare("INSERT INTO obligation_artifacts (id, obligation_id, ref) VALUES (?, ?, ?)").run(
      "a1",
      "answered",
      "gchat_message:spaces/S/messages/M"
    );

    referenceGrammar.up(db);

    expect(
      (
        db.prepare("SELECT resolution_ref FROM obligations WHERE id = 'answered'").get() as {
          resolution_ref: string;
        }
      ).resolution_ref
    ).toBe("mesh:messages/abc-123");
    // Google's resource name is carried verbatim; only the scheme changes.
    expect(
      (db.prepare("SELECT ref FROM obligation_artifacts WHERE id = 'a1'").get() as { ref: string })
        .ref
    ).toBe("gchat:spaces/S/messages/M");
  });

  it("leaves a value it cannot safely reinterpret alone", () => {
    const db = seedDb();
    // Already migrated, and an entry-only inbox ref whose owning actor the old
    // grammar never recorded — guessing one would be worse than leaving it.
    insertObligation(db, "already", "github:MEK-Org/rusa/issues/33");
    insertObligation(db, "orphan", null, "inbox_entry:entry-9");

    referenceGrammar.up(db);

    expect(refOf(db, "already")).toBe("github:MEK-Org/rusa/issues/33");
    expect(
      (
        db.prepare("SELECT resolution_ref FROM obligations WHERE id = 'orphan'").get() as {
          resolution_ref: string;
        }
      ).resolution_ref
    ).toBe("inbox_entry:entry-9");
  });

  it("is idempotent and tolerates a database with no obligation tables", () => {
    const db = seedDb();
    insertObligation(db, "issue", "github_issue:MEK-Org/rusa#33");
    referenceGrammar.up(db);
    referenceGrammar.up(db);
    expect(refOf(db, "issue")).toBe("github:MEK-Org/rusa/issues/33");

    const bare = new Database(":memory:");
    expect(() => referenceGrammar.up(bare)).not.toThrow();
  });
});
