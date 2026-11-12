import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { ObligationRepository } from "../repositories/obligation-repository.js";
import { SqliteInboxRepository } from "../repositories/sqlite-inbox-repository.js";
import { meshWriterFor } from "./obligation-store.js";

describe("meshWriterFor (#1289)", () => {
  let db: Database.Database;
  let obligations: ObligationRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    obligations = new ObligationRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("shares one writer per repository, whether or not later calls name the same repos", () => {
    const inbox = new SqliteInboxRepository(db);
    const writer = meshWriterFor(db, obligations, { inbox });

    expect(meshWriterFor(db, obligations)).toBe(writer);
    expect(meshWriterFor(db, obligations, { inbox })).toBe(writer);
  });

  it("throws when a later call names repos the cached writer does not deliver to", () => {
    meshWriterFor(db, obligations, { inbox: new SqliteInboxRepository(db) });

    expect(() => meshWriterFor(db, obligations, { inbox: new SqliteInboxRepository(db) })).toThrow(
      /already built over other inbox/
    );
    expect(() => meshWriterFor(db, obligations, { actors: { get: () => undefined } })).toThrow(
      /already built over other actors/
    );
  });

  it("throws when a later call names another database", () => {
    meshWriterFor(db, obligations);
    const other = new Database(":memory:");
    try {
      expect(() => meshWriterFor(other, obligations)).toThrow(/already built over other db/);
    } finally {
      other.close();
    }
  });
});
