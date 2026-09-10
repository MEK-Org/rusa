import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { actorVoiceConfig } from "./0044_actor_voice_config.js";

function seedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE actors (
      id        TEXT PRIMARY KEY,
      charter   TEXT NOT NULL
    );
    INSERT INTO actors (id, charter) VALUES ('actor-a', 'a');
  `);
  return db;
}

/**
 * The schema half of the per-actor voice configuration change. Behavior through
 * the repository is covered in `sqlite-actor-repository.test.ts`; what is
 * pinned here is what the database itself guarantees when application code is
 * bypassed, because that is the part a reviewer is being asked to approve.
 */
describe("0044_actor_voice_config", () => {
  it("adds a nullable voice_config column to actors", () => {
    const db = seedDb();
    actorVoiceConfig.up(db);

    const columns = db.prepare(`PRAGMA table_info(actors)`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const column = columns.find((c) => c.name === "voice_config");
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
    expect(column?.dflt_value).toBeNull();
  });

  it("keeps pre-migration rows readable with a null document", () => {
    const db = seedDb();
    actorVoiceConfig.up(db);

    const row = db.prepare("SELECT voice_config FROM actors WHERE id = 'actor-a'").get() as {
      voice_config: string | null;
    };
    expect(row.voice_config).toBeNull();
  });

  it("stores the versioned document as plain text with no shape constraint", () => {
    const db = seedDb();
    actorVoiceConfig.up(db);

    db.prepare("UPDATE actors SET voice_config = ? WHERE id = 'actor-a'").run(
      JSON.stringify({
        schemaVersion: 1,
        provider: "google",
        config: { voiceName: "Puck" },
      })
    );
    const row = db.prepare("SELECT voice_config FROM actors WHERE id = 'actor-a'").get() as {
      voice_config: string;
    };
    expect(JSON.parse(row.voice_config)).toEqual({
      schemaVersion: 1,
      provider: "google",
      config: { voiceName: "Puck" },
    });
  });
});
