import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Per-actor walkie-talkie voice configuration : one versioned JSON document.
 * Nullable for rows written before this migration — an absent document means
 * the actor follows the instance-wide voice fallback, which is the behavior
 * existing actors keep across this change. Consuming code parses and validates
 * non-null documents (version and shape enforced at the repository boundary),
 * rather than coupling SQLite to a JSON shape with CHECK or json_* constraints.
 */
export const actorVoiceConfig: Migration = {
  id: "0044_actor_voice_config",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE actors ADD COLUMN voice_config TEXT;
    `);
  },
};
