import type Database from "better-sqlite3";
import { z } from "zod";
import type { ActorRecord } from "../../actor/actor-record.js";
import { HUMAN_OPERATOR } from "../../mcp/stamp.js";
import type { ProviderModelConfig } from "../../providers/model-config.js";
import type { ActorRepository } from "../../repositories/actor-repository.js";

type ActorRow = {
  id: string;
  charter: string;
  parent_id: string | null;
  model_config: string | null;
  context_config: string | null;
  title: string | null;
  retired_at: string | null;
  created_at: string;
};

export const ACTOR_CONFIG_SCHEMA_VERSION = 1 as const;

/** schemaVersion for a `model_config` document written before #169's pool contract. */
const LEGACY_MODEL_CONFIG_SCHEMA_VERSION = 1 as const;
/** schemaVersion for a `model_config` document holding a `ProviderModelConfig[]` pool. */
const MODEL_CONFIG_POOL_SCHEMA_VERSION = 2 as const;

const legacyModelConfigSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_MODEL_CONFIG_SCHEMA_VERSION),
    provider: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
  })
  .strict()
  .refine(
    (config) =>
      config.provider !== undefined || config.model !== undefined || config.effort !== undefined,
    { message: "at least one model selection field is required" }
  );

const modelConfigEntrySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().optional(),
  })
  .strict();

const modelConfigPoolSchema = z
  .object({
    schemaVersion: z.literal(MODEL_CONFIG_POOL_SCHEMA_VERSION),
    entries: z.array(modelConfigEntrySchema).min(1),
  })
  .strict();

const modelConfigDocumentSchema = z.union([modelConfigPoolSchema, legacyModelConfigSchema]);

const contextConfigSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(ACTOR_CONFIG_SCHEMA_VERSION),
      type: z.literal("native"),
      sessionId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(ACTOR_CONFIG_SCHEMA_VERSION),
      type: z.literal("portable"),
      mode: z.enum(["tail", "ledger"]),
      compactionModel: z.string().optional(),
    })
    .strict(),
]);
type ContextConfigDocument = z.infer<typeof contextConfigSchema>;

function parseDocument<T>(
  actorId: string,
  column: "model_config" | "context_config",
  json: string,
  schema: z.ZodType<T>
): T {
  try {
    return schema.parse(JSON.parse(json));
  } catch (cause) {
    throw new Error(`SqliteActorRepository: invalid ${column} for actor '${actorId}'`, { cause });
  }
}

/** Builds the versioned model-config document, or null when the pool is unset/empty. */
function buildModelConfig(record: ActorRecord): string | null {
  if (!record.modelConfig || record.modelConfig.length === 0) return null;
  const entries = record.modelConfig.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
  }));
  return JSON.stringify({ schemaVersion: MODEL_CONFIG_POOL_SCHEMA_VERSION, entries });
}

/**
 * Parses the `model_config` document. A document written before #169's pool
 * contract (`schemaVersion: 1`, a single optional provider/model/effort) is
 * migrated on read into a one-entry pool. A legacy document missing either
 * `provider` or `model` predates the required-model contract and can't form a
 * valid entry — `modelConfig` is left unset so callers fall back the same way
 * they do for an actor with no configuration at all, rather than failing to
 * load the row.
 */
function parseModelConfig(actorId: string, json: string | null): Pick<ActorRecord, "modelConfig"> {
  if (!json) return {};
  const parsed = parseDocument(actorId, "model_config", json, modelConfigDocumentSchema);
  if ("entries" in parsed) {
    return { modelConfig: parsed.entries };
  }
  if (parsed.provider !== undefined && parsed.model !== undefined) {
    return {
      modelConfig: [
        {
          provider: parsed.provider,
          model: parsed.model,
          ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}),
        },
      ],
    };
  }
  return {};
}

/**
 * Builds the versioned context-config document grouping the native provider
 * session with portable-context selection, or null when neither is set. A
 * portable actor never carries a provider session because that session has no
 * meaning once the actor uses mesh-managed context.
 */
function buildContextConfig(record: ActorRecord): string | null {
  if (record.context?.type === "portable") {
    const config: ContextConfigDocument = {
      schemaVersion: ACTOR_CONFIG_SCHEMA_VERSION,
      type: "portable",
      mode: record.context.mode,
      ...(record.context.compactionModel !== undefined
        ? { compactionModel: record.context.compactionModel }
        : {}),
    };
    return JSON.stringify(config);
  }
  if (record.context?.type === "native" || record.sessionId !== undefined) {
    const config: ContextConfigDocument = {
      schemaVersion: ACTOR_CONFIG_SCHEMA_VERSION,
      type: "native",
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    };
    return JSON.stringify(config);
  }
  return null;
}

function parseContextConfig(
  actorId: string,
  json: string | null
): Pick<ActorRecord, "context" | "sessionId"> {
  if (!json) return {};
  const parsed = parseDocument(actorId, "context_config", json, contextConfigSchema);
  if (parsed.type === "portable") {
    return {
      context: {
        type: "portable",
        mode: parsed.mode,
        ...(parsed.compactionModel !== undefined
          ? { compactionModel: parsed.compactionModel }
          : {}),
      },
    };
  }
  return {
    context: { type: "native" },
    ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
  };
}

/** A staged, not-yet-applied replacement for the actor's declared modelConfig pool. */
type DesiredOverlayEntry = {
  desiredModelConfig?: ProviderModelConfig[];
};

/**
 * Authoritative SQLite repository for actor records. The two JSON columns are
 * versioned documents whose schema is validated here, at their consumption
 * boundary; the database stores them as ordinary TEXT.
 *
 * `desiredModelConfig` is process memory, not a durable row (an unapplied
 * pool change is discardable — see MEK-Org/rusa#169's binding to #199
 * dispatch-time-apply semantics), so it lives in an instance-local overlay.
 * Every successful upsert fully replaces an actor's overlay entry when
 * `desiredModelConfig` is present as a key on the incoming record.
 */
export class SqliteActorRepository implements ActorRepository {
  private readonly desiredOverlay = new Map<string, DesiredOverlayEntry>();

  constructor(private readonly db: Database.Database) {}

  upsert(record: ActorRecord): void {
    const isRoot = record.isRoot === true;
    if (record.parentId === null && !isRoot) {
      throw new Error(
        `SqliteActorRepository: refusing to store parentless actor '${record.id}' without isRoot — ` +
          "root topology is derived from parent_id IS NULL in this schema"
      );
    }
    if (record.parentId !== null && isRoot) {
      throw new Error(
        `SqliteActorRepository: root actor '${record.id}' must have a null parentId (got '${record.parentId}')`
      );
    }

    this.db.transaction(() => {
      const retiredAt =
        record.status === "active"
          ? null
          : ((
              this.db.prepare("SELECT retired_at FROM actors WHERE id = ?").get(record.id) as
                | { retired_at: string | null }
                | undefined
            )?.retired_at ?? new Date().toISOString());

      this.db
        .prepare(`INSERT INTO actors (
        id, charter, parent_id, model_config, context_config, title, retired_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET charter=excluded.charter, parent_id=excluded.parent_id,
        model_config=excluded.model_config, context_config=excluded.context_config,
        title=excluded.title, retired_at=excluded.retired_at, created_at=excluded.created_at`)
        .run(
          record.id,
          record.charter,
          record.parentId,
          buildModelConfig(record),
          buildContextConfig(record),
          record.title ?? null,
          retiredAt,
          record.createdAt
        );
      this.db.prepare("DELETE FROM actor_handles WHERE actor_id = ?").run(record.id);
      const addHandle = this.db.prepare(
        "INSERT INTO actor_handles (actor_id, target_id, role) VALUES (?, ?, ?)"
      );
      for (const handle of record.handles ?? []) {
        addHandle.run(record.id, handle.id, handle.role ?? null);
      }
    })();

    // Process memory must advance only after the durable transaction commits.
    this.storeDesiredOverlay(record);
  }

  get(id: string): ActorRecord | undefined {
    const row = this.db.prepare("SELECT * FROM actors WHERE id = ?").get(id) as
      | ActorRow
      | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  list(): ActorRecord[] {
    return (
      this.db.prepare("SELECT * FROM actors ORDER BY created_at, id").all() as ActorRow[]
    ).map((row) => this.fromRow(row));
  }

  children(parentId: string): ActorRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM actors WHERE parent_id = ? ORDER BY created_at, id")
        .all(parentId) as ActorRow[]
    ).map((row) => this.fromRow(row));
  }

  patch(id: string, changes: Partial<Omit<ActorRecord, "id">>): void {
    const record = this.get(id);
    if (record) this.upsert({ ...record, ...changes, id });
  }

  private storeDesiredOverlay(record: ActorRecord): void {
    if ("desiredModelConfig" in record) {
      this.desiredOverlay.set(record.id, { desiredModelConfig: record.desiredModelConfig });
    } else {
      this.desiredOverlay.delete(record.id);
    }
  }

  private fromRow(row: ActorRow): ActorRecord {
    const handles = this.db
      .prepare("SELECT target_id, role FROM actor_handles WHERE actor_id = ? ORDER BY target_id")
      .all(row.id) as Array<{ target_id: string; role: string | null }>;
    const lastHumanMessage = this.db
      .prepare(
        "SELECT session_id FROM mesh_chat WHERE recipient_id = ? AND sender_id = ? ORDER BY ts DESC, id DESC LIMIT 1"
      )
      .get(row.id, HUMAN_OPERATOR) as { session_id: string | null } | undefined;
    return {
      id: row.id,
      charter: row.charter,
      parentId: row.parent_id,
      status: row.retired_at === null ? "active" : "retired",
      createdAt: row.created_at,
      ...parseModelConfig(row.id, row.model_config),
      ...parseContextConfig(row.id, row.context_config),
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.parent_id === null ? { isRoot: true } : {}),
      ...(handles.length
        ? {
            handles: handles.map((handle) => ({
              id: handle.target_id,
              ...(handle.role ? { role: handle.role } : {}),
            })),
          }
        : {}),
      ...(lastHumanMessage ? { humanUnlocked: true } : {}),
      ...(lastHumanMessage?.session_id ? { lastChatSessionId: lastHumanMessage.session_id } : {}),
      ...this.desiredOverlay.get(row.id),
    };
  }
}
