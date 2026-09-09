import type Database from "better-sqlite3";
import { z } from "zod";
import type { ActorRecord } from "../../actor/actor-record.js";
import { HUMAN_OPERATOR } from "../../mcp/stamp.js";
import type { ProviderModelConfig } from "../../providers/model-config.js";
import type { ActorRepository } from "../../repositories/actor-repository.js";
import { canonicalSupportedVoiceName } from "../../voice/tts-voices.js";
import { PrincipalRepository } from "./principal-repository.js";

type ActorRow = {
  id: string;
  charter: string;
  parent_id: string | null;
  model_config: string | null;
  context_config: string | null;
  voice_config: string | null;
  title: string | null;
  retired_at: string | null;
  created_at: string;
};

type LastHumanMessage = {
  session_id: string | null;
};

/**
 * `context_config` version emitted by this build. Version 2 adds the durable
 * execution-placement field; the version must identify the exact strict
 * document shape rather than merely its broad category.
 */
export const ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION = 2 as const;
/** `context_config` shape emitted before durable remote placement (#301). */
const LEGACY_ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION = 1 as const;

/** schemaVersion for a `model_config` document written before #169's pool contract. */
const LEGACY_MODEL_CONFIG_SCHEMA_VERSION = 1 as const;
/** schemaVersion for a `model_config` document holding a `ProviderModelConfig[]` pool. */
const MODEL_CONFIG_POOL_SCHEMA_VERSION = 2 as const;
/** schemaVersion for a pool with declared model-class provenance. */
const MODEL_CONFIG_CLASS_SCHEMA_VERSION = 3 as const;

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

const modelConfigClassSchema = z
  .object({
    schemaVersion: z.literal(MODEL_CONFIG_CLASS_SCHEMA_VERSION),
    entries: z.array(modelConfigEntrySchema).min(1),
    // A class resolves to this concrete snapshot at ingress. Retaining its
    // name lets the dashboard distinguish that intentional class selection
    // from an explicit pool without making the runtime re-resolve it later.
    modelClass: z.string().min(1),
  })
  .strict();

// v1 and v2 remain readable so existing records stay valid. New class-bearing
// documents are v3; a v2 parser therefore never mistakes them for malformed
// v2 records with an unrecognized member.
const modelConfigDocumentSchema = z.union([
  modelConfigClassSchema,
  modelConfigPoolSchema,
  legacyModelConfigSchema,
]);

const legacyContextConfigSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(LEGACY_ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION),
      type: z.literal("native"),
      sessionId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(LEGACY_ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION),
      type: z.literal("portable"),
      mode: z.enum(["tail", "ledger"]),
      compactionModel: z.string().optional(),
    })
    .strict(),
]);

const currentContextConfigSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION),
      type: z.literal("native"),
      sessionId: z.string().optional(),
      executionTarget: z.string().optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION),
      type: z.literal("portable"),
      mode: z.enum(["tail", "ledger"]),
      compactionModel: z.string().optional(),
      executionTarget: z.string().optional(),
    })
    .strict(),
]);
/**
 * Read both strict shapes. We write v2 only when executionTarget is set,
 * keeping unplaced actors on v1 so rollback blast radius is strictly bounded
 * to remotely-placed actors.
 */
const contextConfigSchema = z.union([legacyContextConfigSchema, currentContextConfigSchema]);
type LegacyContextConfigDocument = z.infer<typeof legacyContextConfigSchema>;
type CurrentContextConfigDocument = z.infer<typeof currentContextConfigSchema>;

/** `voice_config` shape emitted by this build: V1 names a prebuilt Gemini TTS voice. */
const voiceConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    voiceName: z.string().min(1),
  })
  .strict()
  .refine((config) => canonicalSupportedVoiceName(config.voiceName) !== undefined, {
    message: "voiceName must name a supported Google TTS voice",
  });

type VoiceConfigDocument = z.infer<typeof voiceConfigSchema>;

function parseDocument<T>(
  actorId: string,
  column: "model_config" | "context_config" | "voice_config",
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
  return JSON.stringify(
    record.modelClass === undefined
      ? { schemaVersion: MODEL_CONFIG_POOL_SCHEMA_VERSION, entries }
      : {
          schemaVersion: MODEL_CONFIG_CLASS_SCHEMA_VERSION,
          entries,
          modelClass: record.modelClass,
        }
  );
}

/**
 * Parses the `model_config` document. Versioned documents (v2 explicit pools,
 * v3 class-bearing records) are validated strictly; an invalid versioned
 * payload throws fail-closed so corrupted configuration is never silently
 * executed.
 *
 * For unversioned legacy documents predating #169: a single optional
 * provider/model/effort is migrated on read into a one-entry pool. A legacy
 * document missing either `provider` or `model` predates the required-model
 * contract and leaves `modelConfig` unset so callers fall back the same way
 * they do for an unconfigured actor, rather than failing to load the row.
 */
function parseModelConfig(
  actorId: string,
  json: string | null
): Pick<ActorRecord, "modelConfig" | "modelClass"> {
  if (!json) return {};
  const parsed = parseDocument(actorId, "model_config", json, modelConfigDocumentSchema);
  if ("entries" in parsed) {
    return {
      modelConfig: parsed.entries,
      ...("modelClass" in parsed ? { modelClass: parsed.modelClass } : {}),
    };
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
    if (record.executionTarget !== undefined) {
      const config: CurrentContextConfigDocument = {
        schemaVersion: ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION,
        type: "portable",
        mode: record.context.mode,
        ...(record.context.compactionModel !== undefined
          ? { compactionModel: record.context.compactionModel }
          : {}),
        executionTarget: record.executionTarget,
      };
      return JSON.stringify(config);
    }
    const config: LegacyContextConfigDocument = {
      schemaVersion: LEGACY_ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION,
      type: "portable",
      mode: record.context.mode,
      ...(record.context.compactionModel !== undefined
        ? { compactionModel: record.context.compactionModel }
        : {}),
    };
    return JSON.stringify(config);
  }
  if (
    record.context?.type === "native" ||
    record.sessionId !== undefined ||
    record.executionTarget !== undefined
  ) {
    if (record.executionTarget !== undefined) {
      const config: CurrentContextConfigDocument = {
        schemaVersion: ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION,
        type: "native",
        ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
        executionTarget: record.executionTarget,
      };
      return JSON.stringify(config);
    }
    const config: LegacyContextConfigDocument = {
      schemaVersion: LEGACY_ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION,
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
): Pick<ActorRecord, "context" | "sessionId" | "executionTarget"> {
  if (!json) return {};
  const parsed = parseDocument(actorId, "context_config", json, contextConfigSchema);
  const executionTarget =
    "executionTarget" in parsed && parsed.executionTarget !== undefined
      ? { executionTarget: parsed.executionTarget }
      : {};
  if (parsed.type === "portable") {
    return {
      context: {
        type: "portable",
        mode: parsed.mode,
        ...(parsed.compactionModel !== undefined
          ? { compactionModel: parsed.compactionModel }
          : {}),
      },
      ...executionTarget,
    };
  }
  return {
    context: { type: "native" },
    ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
    ...executionTarget,
  };
}

/** Builds the versioned voice-config document, or null when the actor follows the instance default. */
function buildVoiceConfig(record: ActorRecord): string | null {
  if (!record.voiceConfig) return null;
  const voiceName = canonicalSupportedVoiceName(record.voiceConfig.voiceName);
  if (!voiceName) {
    throw new Error(
      `invalid voice_config for actor '${record.id}': voiceName must name a supported Google TTS voice`
    );
  }
  const config: VoiceConfigDocument = {
    schemaVersion: 1,
    voiceName,
  };
  return JSON.stringify(config);
}

/**
 * Parses the `voice_config` document. Version and shape are validated
 * strictly; a malformed document throws fail-closed, matching the other
 * versioned columns.
 *
 * Voice names are also consumer-validated against the shared supported
 * catalog. SQLite stays deliberately unconstrained: a direct database edit
 * remains readable only when it is a document this build can actually render.
 */
function parseVoiceConfig(actorId: string, json: string | null): Pick<ActorRecord, "voiceConfig"> {
  if (!json) return {};
  const parsed = parseDocument(actorId, "voice_config", json, voiceConfigSchema);
  // The schema's refinement above proves this exists; canonicalizing also
  // repairs case-only hand edits so the dropdown always receives one of its
  // exact option values.
  const voiceName = canonicalSupportedVoiceName(parsed.voiceName);
  if (!voiceName) throw new Error(`invalid voice_config for actor '${actorId}'`);
  return { voiceConfig: { schemaVersion: 1, voiceName } };
}

/** A staged, not-yet-applied replacement for the actor's declared modelConfig pool. */
type DesiredOverlayEntry = {
  desiredModelConfig?: ProviderModelConfig[];
  desiredModelClass?: string;
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
 *
 * Every actor row is accompanied by its principal row, written inside the same
 * transaction. That coupling is what makes "every actor has an identity" a fact
 * rather than a convention: an actor cannot exist unattributable, and a failed
 * principal write takes the actor row down with it instead of leaving a half
 * -identified actor behind. `upsert` is the single write path for both spawn
 * and legacy import, so neither needs to remember to do it.
 */
export class SqliteActorRepository implements ActorRepository {
  private readonly desiredOverlay = new Map<string, DesiredOverlayEntry>();

  constructor(
    private readonly db: Database.Database,
    private readonly principals: PrincipalRepository = new PrincipalRepository(db)
  ) {}

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
        id, charter, parent_id, model_config, context_config, voice_config, title, retired_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET charter=excluded.charter, parent_id=excluded.parent_id,
        model_config=excluded.model_config, context_config=excluded.context_config,
        voice_config=excluded.voice_config,
        title=excluded.title, retired_at=excluded.retired_at, created_at=excluded.created_at`)
        .run(
          record.id,
          record.charter,
          record.parentId,
          buildModelConfig(record),
          buildContextConfig(record),
          buildVoiceConfig(record),
          record.title ?? null,
          retiredAt,
          record.createdAt
        );
      this.principals.ensureActorPrincipal(record.id, record.createdAt);
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
    const rows = this.db
      .prepare("SELECT * FROM actors ORDER BY created_at, id")
      .all() as ActorRow[];
    const lastHumanMessageByRecipient = new Map<string, LastHumanMessage>();
    // `/api/mesh/threads` lists every actor. Resolving the newest operator
    // message in `fromRow` turned that request into one full mesh_chat scan per
    // actor when no recipient index existed. One ordered pass has the same
    // newest `(ts, id)` semantics and leaves the first row for each recipient
    // in the map, without a schema migration or an N+1 query.
    const newestHumanRows = this.db
      .prepare(
        "SELECT recipient_id, session_id FROM mesh_chat WHERE sender_id = ? ORDER BY recipient_id, ts DESC, id DESC"
      )
      .all(HUMAN_OPERATOR) as Array<{ recipient_id: string; session_id: string | null }>;
    for (const message of newestHumanRows) {
      if (!lastHumanMessageByRecipient.has(message.recipient_id)) {
        lastHumanMessageByRecipient.set(message.recipient_id, { session_id: message.session_id });
      }
    }
    // `null` means this actor was resolved by the batch and has no matching
    // human message. `undefined` remains reserved for callers such as `get()`
    // and `children()`, which did not run the batch and must resolve one row.
    return rows.map((row) => this.fromRow(row, lastHumanMessageByRecipient.get(row.id) ?? null));
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
      this.desiredOverlay.set(record.id, {
        desiredModelConfig: record.desiredModelConfig,
        ...("desiredModelClass" in record ? { desiredModelClass: record.desiredModelClass } : {}),
      });
    } else {
      this.desiredOverlay.delete(record.id);
    }
  }

  private fromRow(row: ActorRow, listedLastHumanMessage?: LastHumanMessage | null): ActorRecord {
    const handles = this.db
      .prepare("SELECT target_id, role FROM actor_handles WHERE actor_id = ? ORDER BY target_id")
      .all(row.id) as Array<{ target_id: string; role: string | null }>;
    const lastHumanMessage =
      listedLastHumanMessage === undefined
        ? (this.db
            .prepare(
              "SELECT session_id FROM mesh_chat WHERE recipient_id = ? AND sender_id = ? ORDER BY ts DESC, id DESC LIMIT 1"
            )
            .get(row.id, HUMAN_OPERATOR) as LastHumanMessage | undefined)
        : listedLastHumanMessage;
    return {
      id: row.id,
      charter: row.charter,
      parentId: row.parent_id,
      status: row.retired_at === null ? "active" : "retired",
      createdAt: row.created_at,
      ...parseModelConfig(row.id, row.model_config),
      ...parseContextConfig(row.id, row.context_config),
      ...parseVoiceConfig(row.id, row.voice_config),
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
