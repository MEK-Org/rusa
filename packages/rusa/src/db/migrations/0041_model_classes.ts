import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Durable, runtime-managed model-class definitions.
 *
 * `definition_json` deliberately has no SQLite JSON constraint or JSON function
 * dependency. Its version and concrete tuple shape are checked by the only
 * consumer, ModelClassRepository, before a definition can be resolved. Keeping
 * that validation at the application boundary makes upgrades explicit and lets
 * a corrupt/manual row fail closed instead of being partly interpreted by SQL.
 */
export const modelClasses: Migration = {
  id: "0041_model_classes",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE model_classes (
        name            TEXT PRIMARY KEY,
        definition_json TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );
    `);
  },
};
