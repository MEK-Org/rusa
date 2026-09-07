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
 * SQLite source of truth for model classes. Every lookup reads the committed
 * row directly: a successful `set_model_class` affects the next class
 * selection in this process without a mesh restart, while actor records retain
 * the concrete pool already resolved for them.
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

  delete(name: string): boolean {
    return this.db.prepare("DELETE FROM model_classes WHERE name = ?").run(name).changes > 0;
  }
}
