import type Database from "better-sqlite3";
import type { ProviderModelConfig } from "../../providers/model-config.js";

/** The version carried inside every persisted model-class definition blob. */
export const MODEL_CLASS_DEFINITION_VERSION = 1;

export interface ModelClass {
  name: string;
  modelConfig: ProviderModelConfig[];
  createdAt: string;
  updatedAt: string;
}

type ModelClassRow = {
  name: string;
  definition_json: string;
  created_at: string;
  updated_at: string;
};

type StoredDefinition = {
  version: typeof MODEL_CLASS_DEFINITION_VERSION;
  modelConfig: ProviderModelConfig[];
};

function invalidDefinition(name: string, reason: string): Error {
  return new Error(`stored model class "${name}" has an invalid definition: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode and validate a database value at its consumption boundary. This is
 * intentionally independent of SQLite's json_* functions: the definition is
 * opaque text in SQL and a versioned, fail-closed document in TypeScript.
 */
function decodeDefinition(name: string, encoded: string): ProviderModelConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw invalidDefinition(name, "definition_json is not JSON");
  }
  if (!isRecord(parsed)) throw invalidDefinition(name, "definition_json is not an object");
  if (parsed.version !== MODEL_CLASS_DEFINITION_VERSION) {
    throw invalidDefinition(name, `unsupported version ${JSON.stringify(parsed.version)}`);
  }
  if (!Array.isArray(parsed.modelConfig) || parsed.modelConfig.length === 0) {
    throw invalidDefinition(name, "modelConfig must be a non-empty array");
  }
  return parsed.modelConfig.map((entry, index) => {
    if (!isRecord(entry))
      throw invalidDefinition(name, `modelConfig entry ${index + 1} is not an object`);
    if (typeof entry.provider !== "string" || !entry.provider.trim()) {
      throw invalidDefinition(name, `modelConfig entry ${index + 1} has no provider`);
    }
    if (typeof entry.model !== "string" || !entry.model.trim()) {
      throw invalidDefinition(name, `modelConfig entry ${index + 1} has no model`);
    }
    if (entry.effort !== undefined && typeof entry.effort !== "string") {
      throw invalidDefinition(name, `modelConfig entry ${index + 1} has a non-string effort`);
    }
    return {
      provider: entry.provider,
      model: entry.model,
      ...(typeof entry.effort === "string" ? { effort: entry.effort } : {}),
    };
  });
}

function fromRow(row: ModelClassRow): ModelClass {
  return {
    name: row.name,
    modelConfig: decodeDefinition(row.name, row.definition_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Thrown when a model class deletion is refused because live actors are still
 * bound to it by class reference (#636).
 */
export class ModelClassInUseError extends Error {
  readonly className: string;
  readonly referencingActors: readonly string[];

  constructor(className: string, referencingActors: readonly string[]) {
    super(
      `Cannot delete model class '${className}': referenced by live actor(s): ${referencingActors.join(", ")}. Rebind these actors first.`
    );
    this.name = "ModelClassInUseError";
    this.className = className;
    this.referencingActors = referencingActors;
  }
}

/**
 * SQLite source of truth for model classes. Every lookup reads the committed
 * row directly: a successful `set_model_class` affects the next class
 * selection in this process without a mesh restart, and a class-bound actor's
 * pool with it — actor records hold a reference to the class, never a copy of
 * its entries, so an edit here is the edit those actors see (#626). An
 * explicitly declared pool is a durable snapshot and is unaffected.
 */
export class ModelClassRepository {
  constructor(private readonly db: Database.Database) {}

  get(name: string): ModelClass | undefined {
    const row = this.db
      .prepare(
        `SELECT name, definition_json, created_at, updated_at
         FROM model_classes WHERE name = ?`
      )
      .get(name) as ModelClassRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(): ModelClass[] {
    return (
      this.db
        .prepare(
          `SELECT name, definition_json, created_at, updated_at
           FROM model_classes ORDER BY name ASC`
        )
        .all() as ModelClassRow[]
    ).map(fromRow);
  }

  /**
   * Names-only lookup for an unknown-class diagnostic. Unlike {@link list},
   * this intentionally never decodes a sibling's definition: one corrupt
   * class must not prevent another actor's broken reference from being shown.
   */
  names(): string[] {
    return (
      this.db.prepare("SELECT name FROM model_classes ORDER BY name ASC").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
  }

  /** Full replacement, preserving ordered candidate semantics exactly as supplied. */
  upsert(name: string, modelConfig: readonly ProviderModelConfig[], at: string): void {
    const definition: StoredDefinition = {
      version: MODEL_CLASS_DEFINITION_VERSION,
      modelConfig: modelConfig.map((entry) => ({ ...entry })),
    };
    this.db
      .prepare(
        `INSERT INTO model_classes (name, definition_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           definition_json = excluded.definition_json,
           updated_at = excluded.updated_at`
      )
      .run(name, JSON.stringify(definition), at, at);
  }

  /**
   * Returns the IDs of all live (non-retired) actors currently bound to this
   * model class by reference (#636).
   *
   * Only live actors (`retired_at IS NULL`) are returned: retired actors are
   * permanently stopped, never scheduled, and cannot be rebound with
   * `set_actor_model`. Counting retired rows would permanently prevent deleting
   * any class once used.
   *
   * Both class-bearing document shapes are caught by the same `$.modelClass`
   * path: a v4 reference and a v3 record whose copied pool is already ignored
   * on read. Deleting the class breaks either one identically.
   */
  referencingActors(name: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM actors
         WHERE retired_at IS NULL
           AND model_config IS NOT NULL
           AND json_valid(model_config)
           AND json_extract(model_config, '$.modelClass') = ?
         ORDER BY id ASC`
      )
      .all(name) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  /**
   * Delete a model class definition from mesh.db.
   *
   * Refuses deletion if any live actor is still bound to this class by
   * reference, throwing {@link ModelClassInUseError} naming those actors (#636).
   *
   * Settled design choices:
   * 1. Retired actors' rows do NOT count as references: they will never run
   *    again, and cannot be rebound.
   * 2. No force/override parameter: "rebind, then delete" is required to prevent
   *    leaving live actors or root with an unresolvable class that breaks
   *    dispatch or prevents root boot.
   * 3. The guard lives here, at the store, so a future caller inherits it
   *    rather than having to remember it. `delete_model_class` adds only the
   *    one reference this query cannot see: a process-local staged rebind.
   *
   * Deleting a class that does not exist stays the cheap no-op it is today —
   * there is nothing to protect, so the reference scan is skipped entirely.
   */
  delete(name: string): boolean {
    const exists = this.db.prepare("SELECT 1 FROM model_classes WHERE name = ?").get(name);
    if (!exists) return false;
    const referencing = this.referencingActors(name);
    if (referencing.length > 0) {
      throw new ModelClassInUseError(name, referencing);
    }
    return this.db.prepare("DELETE FROM model_classes WHERE name = ?").run(name).changes > 0;
  }
}
