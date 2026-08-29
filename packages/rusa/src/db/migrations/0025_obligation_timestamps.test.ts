import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { obligationTimestamps } from "./0025_obligation_timestamps.js";

function columnNames(db: Database.Database): string[] {
  return (db.prepare("PRAGMA table_info(obligations)").all() as Array<{ name: string }>).map(
    (column) => column.name
  );
}

/** The obligations table as of 0016/0017, without the timestamp columns. */
function seedDb(withReceipts = true): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE obligations (
      id             TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
      parent_id      TEXT REFERENCES obligations(id) ON DELETE RESTRICT,
      owner_kind     TEXT NOT NULL CHECK (owner_kind IN ('actor', 'human')),
      owner_id       TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
      intent         TEXT,
      external_ref   TEXT,
      status         TEXT NOT NULL CHECK (status IN ('ready', 'waiting', 'done', 'cancelled')),
      priority       REAL,
      CHECK (parent_id IS NULL OR parent_id <> id)
    );
  `);
  if (withReceipts) {
    db.exec(`
      CREATE TABLE obligation_capture_receipts (
        inbox_entry_id TEXT PRIMARY KEY,
        obligation_id  TEXT REFERENCES obligations(id) ON DELETE RESTRICT,
        actor_id       TEXT NOT NULL,
        source_type    TEXT NOT NULL,
        status         TEXT NOT NULL,
        failure_class  TEXT,
        reason         TEXT,
        created_at     TEXT NOT NULL
      );
    `);
  }
  return db;
}

/**
 * Insert a row against whichever shape the table currently has: the migration
 * drops `owner_kind`, so the same helper has to work either side of it.
 */
function insertObligation(
  db: Database.Database,
  id: string,
  ownerId = "actor-1",
  // Legacy human owners were free-form handles with no prefix, so the kind
  // cannot be inferred from the id — that is the whole reason the column existed.
  ownerKind: "actor" | "human" = "actor"
): void {
  const hasKind = (
    db.prepare("PRAGMA table_info(obligations)").all() as Array<{ name: string }>
  ).some((column) => column.name === "owner_kind");
  const columns = hasKind
    ? "(id, parent_id, owner_kind, owner_id, intent, external_ref, status, priority)"
    : "(id, parent_id, owner_id, intent, external_ref, status, priority)";
  const values = hasKind
    ? "(?, NULL, ?, ?, ?, NULL, 'ready', 1)"
    : "(?, NULL, ?, ?, NULL, 'ready', 1)";
  const args = hasKind
    ? [id, ownerKind, ownerId, `intent for ${id}`]
    : [id, ownerId, `intent for ${id}`];
  db.prepare(`INSERT INTO obligations ${columns} VALUES ${values}`).run(...args);
}

function read(
  db: Database.Database,
  id: string
): { created_at: string | null; updated_at: string | null } {
  return db.prepare("SELECT created_at, updated_at FROM obligations WHERE id = ?").get(id) as {
    created_at: string | null;
    updated_at: string | null;
  };
}

describe("0025_obligation_timestamps", () => {
  it("adds the timestamp and creator columns plus an index", () => {
    const db = seedDb();
    expect(columnNames(db)).not.toContain("created_at");

    obligationTimestamps.up(db);

    expect(columnNames(db)).toEqual(
      expect.arrayContaining(["created_at", "updated_at", "creator_id"])
    );
    const indexes = (
      db.prepare("PRAGMA index_list(obligations)").all() as Array<{ name: string }>
    ).map((index) => index.name);
    expect(indexes).toContain("idx_obligations_created_at");
  });

  it("installs no triggers — stamping is the repository's job (#1671: no opaque triggers)", () => {
    const db = seedDb();
    obligationTimestamps.up(db);

    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'obligations'")
      .all();
    expect(triggers).toEqual([]);
  });

  it("rejects a blank creator id but accepts any id in the one id space", () => {
    const db = seedDb();
    obligationTimestamps.up(db);
    insertObligation(db, "ok-1");

    expect(() =>
      db.prepare("UPDATE obligations SET creator_id = '  ' WHERE id = ?").run("ok-1")
    ).toThrow();
    for (const creator of ["root", "human:operator", "system:mesh"]) {
      expect(() =>
        db.prepare("UPDATE obligations SET creator_id = ? WHERE id = ?").run(creator, "ok-1")
      ).not.toThrow();
    }
  });

  it("never infers a creator for legacy rows (#1671: not from owner, author, or topology)", () => {
    const db = seedDb();
    insertObligation(db, "legacy-1");
    db.prepare(
      `INSERT INTO obligation_capture_receipts
         (inbox_entry_id, obligation_id, actor_id, source_type, status, created_at)
       VALUES ('entry-1', 'legacy-1', 'actor-1', 'chat', 'captured', '2026-08-23T18:56:49.572Z')`
    ).run();

    obligationTimestamps.up(db);

    const row = db
      .prepare("SELECT created_at, creator_id FROM obligations WHERE id = ?")
      .get("legacy-1") as Record<string, string | null>;
    // A capture receipt dates the row but says nothing trustworthy about who
    // raised it, so the timestamp backfills and the creator stays unknown.
    expect(row.created_at).toBe("2026-08-23T18:56:49.572Z");
    expect(row.creator_id).toBeNull();
  });

  it("backfills historical rows from their capture receipt", () => {
    const db = seedDb();
    insertObligation(db, "captured-1");
    db.prepare(
      `INSERT INTO obligation_capture_receipts
         (inbox_entry_id, obligation_id, actor_id, source_type, status, created_at)
       VALUES ('entry-1', 'captured-1', 'actor-1', 'chat', 'captured', '2026-08-23T18:56:49.572Z')`
    ).run();

    obligationTimestamps.up(db);

    expect(read(db, "captured-1")).toEqual({
      created_at: "2026-08-23T18:56:49.572Z",
      updated_at: "2026-08-23T18:56:49.572Z",
    });
  });

  it("leaves historical rows with no recoverable creation time NULL rather than inventing one", () => {
    const db = seedDb();
    insertObligation(db, "legacy-1");

    obligationTimestamps.up(db);

    expect(read(db, "legacy-1")).toEqual({ created_at: null, updated_at: null });
  });

  it("runs when the capture-receipts table is absent", () => {
    const db = seedDb(false);
    insertObligation(db, "legacy-1");

    expect(() => obligationTimestamps.up(db)).not.toThrow();
    expect(read(db, "legacy-1").created_at).toBeNull();
  });

  it("collapses owner into one id space and normalises human owners", () => {
    const db = seedDb();
    insertObligation(db, "by-actor", "actor-1");
    insertObligation(db, "by-name", "SomeDisplayName", "human");
    insertObligation(db, "by-login", "some-github-login", "human");
    insertObligation(db, "by-operator", "human:operator", "human");

    obligationTimestamps.up(db);

    expect(columnNames(db)).not.toContain("owner_kind");
    const owners = (
      db.prepare("SELECT id, owner_id FROM obligations ORDER BY id").all() as Array<{
        id: string;
        owner_id: string;
      }>
    ).reduce<Record<string, string>>((acc, row) => {
      acc[row.id] = row.owner_id;
      return acc;
    }, {});
    // Every human alias collapses onto the one operator id; actors untouched.
    expect(owners["by-actor"]).toBe("actor-1");
    expect(owners["by-name"]).toBe("human:operator");
    expect(owners["by-login"]).toBe("human:operator");
    expect(owners["by-operator"]).toBe("human:operator");

    const indexes = (
      db.prepare("PRAGMA index_list(obligations)").all() as Array<{ name: string }>
    ).map((index) => index.name);
    expect(indexes).toContain("idx_obligations_owner_status_priority");
  });

  it("is idempotent", () => {
    const db = seedDb();
    obligationTimestamps.up(db);
    insertObligation(db, "new-1");
    const before = read(db, "new-1");

    expect(() => obligationTimestamps.up(db)).not.toThrow();

    expect(read(db, "new-1")).toEqual(before);
    expect(columnNames(db).filter((name) => name === "created_at")).toHaveLength(1);
  });
});
