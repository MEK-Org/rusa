import type Database from "better-sqlite3";
import { z } from "zod";
import type { ActorRecord } from "../../actor/actor-record.js";
import { HUMAN_OPERATOR } from "../../mcp/stamp.js";
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

const modelConfigSchema = z
  .object({
    schemaVersion: z.literal(ACTOR_CONFIG_SCHEMA_VERSION),
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
type ModelConfigDocument = z.infer<typeof modelConfigSchema>;

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

/** Builds the versioned model-config document, or null when the tuple is entirely unset. */
function buildModelConfig(record: ActorRecord): string | null {
  const config: Omit<ModelConfigDocument, "schemaVersion"> = {};
  if (record.provider !== undefined) config.provider = record.provider;
  if (record.model !== undefined) config.model = record.model;
  if (record.effort !== undefined) config.effort = record.effort;
  if (!Object.keys(config).length) return null;
  return JSON.stringify({ schemaVersion: ACTOR_CONFIG_SCHEMA_VERSION, ...config });
}

function parseModelConfig(
  actorId: string,
  json: string | null
): Pick<ActorRecord, "provider" | "model" | "effort"> {
  if (!json) return {};
  const parsed = parseDocument(actorId, "model_config", json, modelConfigSchema);
  return {
    ...(parsed.provider !== undefined ? { provider: parsed.provider } : {}),
    ...(parsed.model !== undefined ? { model: parsed.model } : {}),
    ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}),
  };
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

/** A staged, not-yet-applied model/provider/effort change. */
type DesiredOverlayEntry = {
  desiredProvider?: string;
  desiredModel?: string;
  desiredEffort?: string | null;
};

/**
 * Authoritative SQLite repository for actor records. The two JSON columns are
 * versioned documents whose schema is validated here, at their consumption
 * boundary; the database stores them as ordinary TEXT.
 *
 * `desiredProvider`/`desiredModel`/`desiredEffort` are process memory, not a
 * durable row (an unapplied model change is discardable), so they live in an
 * instance-local overlay. Every successful upsert fully replaces an actor's
 * overlay entry from the desired-* keys present on the incoming record.
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
    const overlay: DesiredOverlayEntry = {};
    if ("desiredProvider" in record) overlay.desiredProvider = record.desiredProvider;
    if ("desiredModel" in record) overlay.desiredModel = record.desiredModel;
    if ("desiredEffort" in record) overlay.desiredEffort = record.desiredEffort;
    if (Object.keys(overlay).length) {
      this.desiredOverlay.set(record.id, overlay);
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
