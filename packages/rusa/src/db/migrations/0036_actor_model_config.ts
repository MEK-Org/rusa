import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Replaces the scalar provider/model/effort (and desired_*) columns on
 * actor_threads with a single JSON-encoded modelConfig/desiredModelConfig
 * pool, mirroring the ThreadRecord shape migration (design MEK-Org/rusa#169).
 * actor_threads has no live writers yet (the cutover this table was staged
 * for hasn't happened — see 0034), so this preserves whatever rows exist by
 * folding their scalar columns into one-entry pools rather than assuming the
 * table is empty.
 */
export const actorModelConfig: Migration = {
  id: "0036_actor_model_config",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE actor_threads ADD COLUMN model_config TEXT;
      ALTER TABLE actor_threads ADD COLUMN desired_model_config TEXT;
    `);

    const rows = db
      .prepare(
        `SELECT id, provider, model, effort, desired_provider, desired_model, desired_effort, desired_effort_is_set
         FROM actor_threads`
      )
      .all() as Array<{
      id: string;
      provider: string | null;
      model: string | null;
      effort: string | null;
      desired_provider: string | null;
      desired_model: string | null;
      desired_effort: string | null;
      desired_effort_is_set: number;
    }>;
    const update = db.prepare(
      "UPDATE actor_threads SET model_config = ?, desired_model_config = ? WHERE id = ?"
    );
    for (const row of rows) {
      // The new modelConfig contract requires `model` on every entry (#169).
      // This table has no live writers yet (see the module comment), so a row
      // whose scalar columns declare a provider but never a model is not a
      // real, in-use record — but it's also not representable under the new
      // contract, so fail loudly rather than writing a pool entry that would
      // violate ProviderModelConfig's invariant on every future read.
      if (row.provider !== null && row.model === null) {
        throw new Error(
          `0036_actor_model_config: row ${row.id} has a provider ("${row.provider}") but no model, which the new modelConfig contract cannot represent — resolve this row manually before migrating`
        );
      }
      if (
        (row.desired_provider !== null || row.desired_effort_is_set) &&
        row.desired_model === null &&
        row.provider === null
      ) {
        throw new Error(
          `0036_actor_model_config: row ${row.id} has a desired provider/effort but no desired or current model, which the new modelConfig contract cannot represent — resolve this row manually before migrating`
        );
      }
      const modelConfig =
        row.provider !== null || row.model !== null || row.effort !== null
          ? JSON.stringify([
              {
                provider: row.provider,
                ...(row.model !== null ? { model: row.model } : {}),
                ...(row.effort !== null ? { effort: row.effort } : {}),
              },
            ])
          : null;
      const desiredModelConfig =
        row.desired_provider !== null || row.desired_model !== null || row.desired_effort_is_set
          ? JSON.stringify([
              {
                provider: row.desired_provider ?? row.provider,
                ...(row.desired_model !== null
                  ? { model: row.desired_model }
                  : row.model !== null
                    ? { model: row.model }
                    : {}),
                ...(row.desired_effort_is_set && row.desired_effort !== null
                  ? { effort: row.desired_effort }
                  : {}),
              },
            ])
          : null;
      update.run(modelConfig, desiredModelConfig, row.id);
    }

    db.exec(`
      ALTER TABLE actor_threads DROP COLUMN provider;
      ALTER TABLE actor_threads DROP COLUMN model;
      ALTER TABLE actor_threads DROP COLUMN effort;
      ALTER TABLE actor_threads DROP COLUMN desired_provider;
      ALTER TABLE actor_threads DROP COLUMN desired_model;
      ALTER TABLE actor_threads DROP COLUMN desired_effort;
      ALTER TABLE actor_threads DROP COLUMN desired_effort_is_set;
    `);
  },
};
