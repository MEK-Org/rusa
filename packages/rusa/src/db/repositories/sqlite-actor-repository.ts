import type Database from "better-sqlite3";
import { z } from "zod";
import type { ActorRecord, ExecutionConfig } from "../../actor/actor-record.js";
import { lookupModelClassPool, type ModelClassStore } from "../../providers/model-config.js";
import type {
  ActorRecordPatch,
  ActorRepository,
  ContextSelectionChange,
  ModelSelectionChange,
} from "../../repositories/actor-repository.js";
import { canonicalSupportedVoiceName } from "../../voice/tts-voices.js";
import { googleVoiceConfig, voiceConfigSchema } from "../../voice/voice-config.js";
import { ModelClassRepository } from "./model-class-repository.js";
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
  execution_config: string | null;
  display_handle: string | null;
};

/**
 * `context_config` version emitted by this build: the portable/native context
 * selection and the native provider session, and nothing else. Version 2 also
 * carried `executionTarget`; migration 0056 moved that to `execution_config`
 * and rewrote every v2 document as v1, so v2 is no longer read.
 */
export const ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION = 1 as const;
/**
 * Durable staged context selections. Context v2 was retired with placement
 * data in migration 0056, so v3 is the next unambiguous format.
 */
const STAGED_CONTEXT_CONFIG_SCHEMA_VERSION = 3 as const;

/** `execution_config` version emitted by this build (#550). */
export const ACTOR_EXECUTION_CONFIG_SCHEMA_VERSION = 1 as const;

/** schemaVersion for a `model_config` document written before #169's pool contract. */
const LEGACY_MODEL_CONFIG_SCHEMA_VERSION = 1 as const;
/** schemaVersion for a `model_config` document holding a `ProviderModelConfig[]` pool. */
const MODEL_CONFIG_POOL_SCHEMA_VERSION = 2 as const;
/** schemaVersion for a pool with declared model-class provenance. */
const MODEL_CONFIG_CLASS_SCHEMA_VERSION = 3 as const;
/**
 * schemaVersion for a class-bound actor's reference-only document: the class
 * name and nothing else (#626). v3 wrote the resolved pool beside the name,
 * which is what let an actor disagree with its own class after an edit.
 */
const MODEL_CONFIG_CLASS_REFERENCE_SCHEMA_VERSION = 4 as const;
/** Durable staged model selections; v1 through v4 remain immutable readers. */
const STAGED_MODEL_CONFIG_SCHEMA_VERSION = 5 as const;

const modelConfigEntrySchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    effort: z.string().optional(),
  })
  .strict();

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

const modelConfigClassReferenceSchema = z
  .object({
    schemaVersion: z.literal(MODEL_CONFIG_CLASS_REFERENCE_SCHEMA_VERSION),
    // Deliberately the whole document. There is no `entries` member to fall
    // back to, which is what makes "the class row is authoritative" a fact
    // about the data rather than a rule readers have to remember.
    modelClass: z.string().min(1),
  })
  .strict();

const stagedModelSelectionSchema = z
  .object({
    desiredEntries: z.array(modelConfigEntrySchema).min(1).optional(),
    desiredClass: z.string().min(1).optional(),
  })
  .strict()
  .refine((config) => config.desiredEntries !== undefined || config.desiredClass !== undefined, {
    message: "a staged model document requires a desired selection",
  });

const stagedModelConfigPoolSchema = z
  .object({
    schemaVersion: z.literal(STAGED_MODEL_CONFIG_SCHEMA_VERSION),
    // Empty only represents an actor without an active explicit selection;
    // `desiredEntries` or `desiredClass` remains required by the intersection.
    entries: z.array(modelConfigEntrySchema),
  })
  .strict()
  .and(stagedModelSelectionSchema);

const stagedModelConfigClassReferenceSchema = z
  .object({
    schemaVersion: z.literal(STAGED_MODEL_CONFIG_SCHEMA_VERSION),
    modelClass: z.string().min(1),
  })
  .strict()
  .and(stagedModelSelectionSchema);

// v1, v2 and v3 all remain readable so existing records stay valid. Class-bound
// documents are written as v4; a v3 record's copied pool remains encoded until
// an explicit model-configuration change, and is ignored on every read.
const modelConfigDocumentSchema = z.union([
  stagedModelConfigClassReferenceSchema,
  stagedModelConfigPoolSchema,
  modelConfigClassReferenceSchema,
  modelConfigClassSchema,
  modelConfigPoolSchema,
  legacyModelConfigSchema,
]);

const desiredContextSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("native"),
    })
    .strict(),
  z
    .object({
      type: z.literal("portable"),
      mode: z.enum(["tail", "ledger", "brief"]),
      compactionModel: z.string().optional(),
    })
    .strict(),
]);

const contextConfigSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION),
      type: z.literal("native"),
      sessionId: z.string().optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION),
      type: z.literal("portable"),
      mode: z.enum(["tail", "ledger", "brief"]),
      compactionModel: z.string().optional(),
    })
    .strict(),
]);

const stagedContextConfigSchema = z.discriminatedUnion("type", [
  z
    .object({
      schemaVersion: z.literal(STAGED_CONTEXT_CONFIG_SCHEMA_VERSION),
      type: z.literal("native"),
      sessionId: z.string().optional(),
      desired: desiredContextSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(STAGED_CONTEXT_CONFIG_SCHEMA_VERSION),
      type: z.literal("portable"),
      mode: z.enum(["tail", "ledger", "brief"]),
      compactionModel: z.string().optional(),
      desired: desiredContextSchema,
    })
    .strict(),
]);

const contextConfigDocumentSchema = z.union([stagedContextConfigSchema, contextConfigSchema]);

/**
 * The stored {@link ExecutionConfig} (#550): whether the actor runs outside
 * managed sandboxing and, for a remotely placed actor, its follower. Every
 * actor row has one, and it always states `unsandboxed` explicitly. The shape
 * is enforced here, by its version, rather than by the database.
 */
const executionConfigSchema = z
  .object({
    schemaVersion: z.literal(ACTOR_EXECUTION_CONFIG_SCHEMA_VERSION),
    unsandboxed: z.boolean(),
    executionTarget: z.string().optional(),
  })
  .strict();
type ExecutionConfigDocument = z.infer<typeof executionConfigSchema>;

function parseDocument<T>(
  actorId: string,
  column: "model_config" | "context_config" | "voice_config" | "execution_config",
  json: string,
  schema: z.ZodType<T>
): T {
  try {
    return schema.parse(JSON.parse(json));
  } catch (cause) {
    throw new Error(`SqliteActorRepository: invalid ${column} for actor '${actorId}'`, { cause });
  }
}

/**
 * Builds the versioned model-config document, or null when the pool is
 * unset/empty.
 *
 * A class-bound record persists its reference and nothing else, so there is no
 * second copy of the class definition to go stale — and no resolved pool to
 * write back, which matters because reads hand callers a pool resolved from the
 * class row and an ordinary `patch` would otherwise persist it (#626).
 *
 * A row converts from v3 to v4 only when its model configuration is
 * deliberately changed, never incidentally and never in a sweep. Incidental
 * writes preserve the stored document through {@link keepStoredModelConfig}.
 */
function buildModelConfig(record: ActorRecord): string | null {
  const desiredEntries =
    record.desiredModelConfig && record.desiredModelConfig.length > 0
      ? record.desiredModelConfig.map((entry) => ({
          provider: entry.provider,
          model: entry.model,
          ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
        }))
      : undefined;
  const desiredClass = record.desiredModelClass;

  // Pending selections carry a format of their own. The old strict schemas
  // stay immutable so deployed old readers continue to read unchanged rows
  // and fail closed on this deliberately unsupported downgrade format.
  if (desiredEntries !== undefined || desiredClass !== undefined) {
    if (record.modelClass !== undefined) {
      return JSON.stringify({
        schemaVersion: STAGED_MODEL_CONFIG_SCHEMA_VERSION,
        modelClass: record.modelClass,
        ...(desiredEntries !== undefined ? { desiredEntries } : {}),
        ...(desiredClass !== undefined ? { desiredClass } : {}),
      });
    }
    const entries = (record.modelConfig ?? []).map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
    }));
    return JSON.stringify({
      schemaVersion: STAGED_MODEL_CONFIG_SCHEMA_VERSION,
      entries,
      ...(desiredEntries !== undefined ? { desiredEntries } : {}),
      ...(desiredClass !== undefined ? { desiredClass } : {}),
    });
  }

  if (record.modelClass !== undefined) {
    return JSON.stringify({
      schemaVersion: MODEL_CONFIG_CLASS_REFERENCE_SCHEMA_VERSION,
      modelClass: record.modelClass,
    });
  }
  if (!record.modelConfig || record.modelConfig.length === 0) {
    return null;
  }
  const entries = record.modelConfig.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
  }));
  return JSON.stringify({
    schemaVersion: MODEL_CONFIG_POOL_SCHEMA_VERSION,
    entries,
  });
}

/**
 * The stored `model_config` text to keep verbatim on an incidental write, or
 * undefined when the write must restate the document.
 *
 * An incidental write — a session id, a title, a parent change — carries a
 * record whose `modelConfig` is a *read-time projection* of the class row, so
 * restating the document on such a write would both discard the row's existing
 * encoding and convert v3 rows to v4 as a side effect of unrelated traffic
 * (#626). Keeping the stored text is what confines the v4 cut to deliberate
 * model-configuration changes, which matters for rollback: an older binary
 * cannot read a v4 document, so a row must not acquire one by accident.
 *
 * The class match protects generic record replacement: ordinary root adoption
 * retains the existing binding, while a record deliberately re-bound to a
 * different class falls through. Explicit model changes use
 * `setModelSelection` and always restate independently of this predicate.
 */
function keepStoredModelConfig(record: ActorRecord, stored: string | null): string | undefined {
  if (stored === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return undefined;
  }
  const document = modelConfigDocumentSchema.safeParse(parsed);
  if (!document.success) return undefined;
  const storedObj = document.data;

  const recordHasDesiredEntries = record.desiredModelConfig !== undefined;
  const storedHasDesiredEntries =
    "desiredEntries" in storedObj && storedObj.desiredEntries !== undefined;
  if (recordHasDesiredEntries !== storedHasDesiredEntries) return undefined;

  const recordHasDesiredClass = record.desiredModelClass !== undefined;
  const storedHasDesiredClass = "desiredClass" in storedObj && storedObj.desiredClass !== undefined;
  if (recordHasDesiredClass !== storedHasDesiredClass) return undefined;

  if (
    recordHasDesiredEntries &&
    JSON.stringify(record.desiredModelConfig) !==
      JSON.stringify("desiredEntries" in storedObj ? storedObj.desiredEntries : undefined)
  ) {
    return undefined;
  }
  if (
    recordHasDesiredClass &&
    record.desiredModelClass !== ("desiredClass" in storedObj ? storedObj.desiredClass : undefined)
  ) {
    return undefined;
  }

  if ("modelClass" in storedObj) {
    return storedObj.modelClass === record.modelClass ? stored : undefined;
  }
  if (record.modelClass !== undefined) return undefined;
  if ("entries" in storedObj) {
    return JSON.stringify(record.modelConfig ?? []) === JSON.stringify(storedObj.entries)
      ? stored
      : undefined;
  }
  const legacyEntries =
    storedObj.provider !== undefined && storedObj.model !== undefined
      ? [
          {
            provider: storedObj.provider,
            model: storedObj.model,
            ...(storedObj.effort !== undefined ? { effort: storedObj.effort } : {}),
          },
        ]
      : [];
  if (JSON.stringify(record.modelConfig ?? []) !== JSON.stringify(legacyEntries)) return undefined;

  return stored;
}

/**
 * Parses the `model_config` document. Versioned documents (v2 explicit pools,
 * v3 class-bearing records, v4 class references) are validated strictly; an
 * invalid versioned payload throws fail-closed so corrupted configuration is
 * never silently executed.
 *
 * A class-bound document resolves its pool from the class store here, on every
 * read, which is what keeps a class-bound actor from disagreeing with its own
 * class (#626). A v3 record's copied entries are deliberately ignored: the
 * class row is the authority. The copy stays encoded until an explicit
 * model-configuration change rewrites that actor, but never becomes a stale
 * fallback. An unresolvable class yields `modelClassError` and no pool.
 *
 * For unversioned legacy documents predating #169: a single optional
 * provider/model/effort is migrated on read into a one-entry pool. A legacy
 * document missing either `provider` or `model` predates the required-model
 * contract and leaves `modelConfig` unset so callers fall back the same way
 * they do for an unconfigured actor, rather than failing to load the row.
 */
function parseModelConfig(
  actorId: string,
  json: string | null,
  classes: ModelClassStore
): Pick<
  ActorRecord,
  "modelConfig" | "modelClass" | "modelClassError" | "desiredModelConfig" | "desiredModelClass"
> {
  if (!json) return {};
  const parsed = parseDocument(actorId, "model_config", json, modelConfigDocumentSchema);
  const desiredPart: Pick<ActorRecord, "desiredModelConfig" | "desiredModelClass"> = {};
  if ("desiredEntries" in parsed && parsed.desiredEntries !== undefined) {
    desiredPart.desiredModelConfig = parsed.desiredEntries;
  }
  if ("desiredClass" in parsed && parsed.desiredClass !== undefined) {
    desiredPart.desiredModelClass = parsed.desiredClass;
  }

  if ("modelClass" in parsed) {
    const resolved = lookupModelClassPool(classes, parsed.modelClass);
    return {
      ...(resolved.error !== undefined
        ? { modelClass: parsed.modelClass, modelClassError: resolved.error }
        : { modelClass: parsed.modelClass, modelConfig: resolved.modelConfig }),
      ...desiredPart,
    };
  }
  if ("entries" in parsed) {
    return parsed.entries.length > 0
      ? { modelConfig: parsed.entries, ...desiredPart }
      : desiredPart;
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
      ...desiredPart,
    };
  }
  return desiredPart;
}

/**
 * Builds the versioned context-config document grouping the native provider
 * session with portable-context selection, or null when neither is set. A
 * portable actor never carries a provider session because that session has no
 * meaning once the actor uses mesh-managed context.
 */
function buildContextConfig(record: ActorRecord): string | null {
  const desired =
    record.desiredContextConfig !== undefined
      ? record.desiredContextConfig.type === "portable"
        ? {
            type: "portable" as const,
            mode: record.desiredContextConfig.mode,
            ...(record.desiredContextConfig.compactionModel !== undefined
              ? { compactionModel: record.desiredContextConfig.compactionModel }
              : {}),
          }
        : { type: "native" as const }
      : undefined;

  if (record.context?.type === "portable") {
    const config = {
      schemaVersion:
        desired !== undefined
          ? STAGED_CONTEXT_CONFIG_SCHEMA_VERSION
          : ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION,
      type: "portable",
      mode: record.context.mode,
      ...(record.context.compactionModel !== undefined
        ? { compactionModel: record.context.compactionModel }
        : {}),
      ...(desired !== undefined ? { desired } : {}),
    };
    return JSON.stringify(config);
  }
  if (
    record.context?.type === "native" ||
    record.sessionId !== undefined ||
    desired !== undefined
  ) {
    const config = {
      schemaVersion:
        desired !== undefined
          ? STAGED_CONTEXT_CONFIG_SCHEMA_VERSION
          : ACTOR_CONTEXT_CONFIG_SCHEMA_VERSION,
      type: "native",
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ...(desired !== undefined ? { desired } : {}),
    };
    return JSON.stringify(config);
  }
  return null;
}

/** Keep a semantically unchanged context document byte-for-byte on incidental writes. */
function keepStoredContextConfig(record: ActorRecord, stored: string | null): string | undefined {
  if (stored === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return undefined;
  }
  const document = contextConfigDocumentSchema.safeParse(parsed);
  if (!document.success) return undefined;
  const storedContext = document.data;
  const desired = "desired" in storedContext ? storedContext.desired : undefined;
  if (JSON.stringify(record.desiredContextConfig) !== JSON.stringify(desired)) return undefined;

  if (storedContext.type === "portable") {
    return record.context?.type === "portable" &&
      record.context.mode === storedContext.mode &&
      record.context.compactionModel === storedContext.compactionModel &&
      record.sessionId === undefined
      ? stored
      : undefined;
  }
  return record.context?.type === "native" && record.sessionId === storedContext.sessionId
    ? stored
    : undefined;
}

function parseContextConfig(
  actorId: string,
  json: string | null
): Pick<ActorRecord, "context" | "sessionId" | "desiredContextConfig"> {
  if (!json) return {};
  const parsed = parseDocument(actorId, "context_config", json, contextConfigDocumentSchema);
  const desiredPart: Pick<ActorRecord, "desiredContextConfig"> =
    "desired" in parsed && parsed.desired !== undefined
      ? {
          desiredContextConfig:
            parsed.desired.type === "portable"
              ? {
                  type: "portable",
                  mode: parsed.desired.mode,
                  ...(parsed.desired.compactionModel !== undefined
                    ? { compactionModel: parsed.desired.compactionModel }
                    : {}),
                }
              : { type: "native" },
        }
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
      ...desiredPart,
    };
  }
  return {
    context: { type: "native" },
    ...(parsed.sessionId !== undefined ? { sessionId: parsed.sessionId } : {}),
    ...desiredPart,
  };
}

/**
 * Builds the execution-config document every actor row carries. An actor is
 * sandboxed unless its record affirmatively says `unsandboxed: true`; the
 * stored document states that resolved value.
 */
function buildExecutionConfig(record: ActorRecord): string {
  const { unsandboxed, executionTarget } = record.executionConfig ?? {};
  const config: ExecutionConfigDocument = {
    schemaVersion: ACTOR_EXECUTION_CONFIG_SCHEMA_VERSION,
    // Only an absent value takes the default; anything else that is not a
    // boolean fails validation below.
    unsandboxed: unsandboxed === undefined ? false : unsandboxed,
    ...(executionTarget !== undefined ? { executionTarget } : {}),
  };
  const parsed = executionConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`SqliteActorRepository: invalid execution_config for actor '${record.id}'`, {
      cause: parsed.error,
    });
  }
  return JSON.stringify(parsed.data);
}

/**
 * A missing or unknown document fails the read: an actor's execution is never
 * guessed. The record omits default values, so a sandboxed leader-local actor
 * reads back without an `executionConfig`.
 */
function parseExecutionConfig(
  actorId: string,
  json: string | null
): Pick<ActorRecord, "executionConfig"> {
  if (json === null) {
    throw new Error(`SqliteActorRepository: missing execution_config for actor '${actorId}'`);
  }
  const parsed = parseDocument(actorId, "execution_config", json, executionConfigSchema);
  const executionConfig: ExecutionConfig = {
    ...(parsed.unsandboxed ? { unsandboxed: true } : {}),
    ...(parsed.executionTarget !== undefined ? { executionTarget: parsed.executionTarget } : {}),
  };
  return Object.keys(executionConfig).length > 0 ? { executionConfig } : {};
}

/** Builds the versioned voice-config document, or null when the actor follows the instance default. */
function buildVoiceConfig(record: ActorRecord): string | null {
  if (!record.voiceConfig) return null;
  const parsed = voiceConfigSchema.safeParse(record.voiceConfig);
  if (!parsed.success) {
    throw new Error(`invalid voice_config for actor '${record.id}'`);
  }
  if (parsed.data.provider !== "google") return JSON.stringify(parsed.data);
  const voiceName = canonicalSupportedVoiceName(parsed.data.config.voiceName);
  if (!voiceName) {
    throw new Error(
      `invalid voice_config for actor '${record.id}': Google voiceName must name a supported TTS voice`
    );
  }
  return JSON.stringify(googleVoiceConfig(voiceName));
}

/**
 * Parses the `voice_config` document. Version and shape are validated
 * strictly; a malformed document throws fail-closed, matching the other
 * versioned columns.
 *
 * Voice names are consumer-validated against the shared supported catalog. A
 * retired Google voice uses the instance fallback until an operator chooses a
 * supported one; every version, provider, and shape mismatch fails closed.
 * SQLite stays deliberately unconstrained.
 */
function parseVoiceConfig(actorId: string, json: string | null): Pick<ActorRecord, "voiceConfig"> {
  if (!json) return {};
  const parsed = parseDocument(actorId, "voice_config", json, voiceConfigSchema);
  // Canonicalizing repairs case-only hand edits so the dropdown always receives
  // one of its exact option values. A retired vendor voice uses the instance
  // fallback without treating its otherwise valid document as malformed.
  if (parsed.provider !== "google") return { voiceConfig: parsed };
  const voiceName = canonicalSupportedVoiceName(parsed.config.voiceName);
  if (!voiceName) return {};
  return { voiceConfig: googleVoiceConfig(voiceName) };
}

/**
 * Authoritative SQLite repository for actor records. The two JSON columns are
 * versioned documents whose schema is validated here, at their consumption
 * boundary; the database stores them as ordinary TEXT.
 *
 * Staged replacements (`desiredModelConfig`, `desiredModelClass`, `desiredContextConfig`)
 * are durably stored in the versioned `model_config` and `context_config` JSON documents
 * so they survive process restarts and apply at the next run boundary.
 *
 * Every actor row is accompanied by its principal row, written inside the same
 * transaction. That coupling is what makes "every actor has an identity" a fact
 * rather than a convention: an actor cannot exist unattributable, and a failed
 * principal write takes the actor row down with it instead of leaving a half
 * -identified actor behind. `upsert` is the single write path for both spawn
 * and legacy import, so neither needs to remember to do it.
 */
export class SqliteActorRepository implements ActorRepository {
  private readonly db: Database.Database;
  private parentStmt?: Database.Statement;

  constructor(
    db: Database.Database,
    private readonly principals: PrincipalRepository = new PrincipalRepository(db),
    /**
     * Read surface for the runtime class definitions a class-bound actor's pool
     * is resolved from on every read (#626). Defaulted from the same database
     * so no construction site can accidentally leave an actor repository that
     * cannot resolve the bindings it stores.
     */
    private readonly modelClasses: ModelClassStore = new ModelClassRepository(db)
  ) {
    this.db = db;
  }

  private getParentStmt(): Database.Statement {
    if (!this.parentStmt) {
      this.parentStmt = this.db.prepare("SELECT parent_id FROM actors WHERE id = ?");
    }
    return this.parentStmt;
  }

  upsert(record: ActorRecord): void {
    this.write(record);
  }

  /**
   * The one write allowed to restate an existing row's model-config document,
   * per the {@link ActorRepository} contract. Everything else preserves the
   * stored encoding.
   */
  setModelSelection(id: string, changes: ModelSelectionChange): void {
    const record = this.get(id);
    if (!record) {
      throw new Error(`SqliteActorRepository: cannot set model selection on unknown actor '${id}'`);
    }
    this.write({ ...record, ...changes, id }, { restateModelConfig: true });
  }

  applyPendingSelections(
    id: string,
    changes: {
      model?: ModelSelectionChange;
      context?: ContextSelectionChange;
    }
  ): void {
    const record = this.get(id);
    if (!record) {
      throw new Error(
        `SqliteActorRepository: cannot apply pending selections on unknown actor '${id}'`
      );
    }
    const updated: ActorRecord = {
      ...record,
      ...(changes.context ?? {}),
      ...(changes.model ?? {}),
      id,
    };
    this.write(updated, { restateModelConfig: changes.model !== undefined });
  }

  private write(record: ActorRecord, opts?: { restateModelConfig?: boolean }): void {
    const executionConfigJson = buildExecutionConfig(record);

    this.db.transaction(() => {
      // One read of the prior row serves the retirement timestamp and both
      // stored config documents an incidental write must preserve.
      const prior = this.db
        .prepare("SELECT retired_at, model_config, context_config FROM actors WHERE id = ?")
        .get(record.id) as
        | {
            retired_at: string | null;
            model_config: string | null;
            context_config: string | null;
          }
        | undefined;
      const retiredAt =
        record.status === "active" ? null : (prior?.retired_at ?? new Date().toISOString());
      const modelConfigJson =
        opts?.restateModelConfig === true
          ? buildModelConfig(record)
          : (keepStoredModelConfig(record, prior?.model_config ?? null) ??
            buildModelConfig(record));

      this.db
        .prepare(`INSERT INTO actors (
        id, charter, parent_id, model_config, context_config, voice_config, title, retired_at, created_at,
        execution_config, display_handle
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET charter=excluded.charter, parent_id=excluded.parent_id,
        model_config=excluded.model_config, context_config=excluded.context_config,
        voice_config=excluded.voice_config,
        title=excluded.title, retired_at=excluded.retired_at, created_at=excluded.created_at,
        execution_config=excluded.execution_config, display_handle=excluded.display_handle`)
        .run(
          record.id,
          record.charter,
          record.parentId,
          modelConfigJson,
          keepStoredContextConfig(record, prior?.context_config ?? null) ??
            buildContextConfig(record),
          buildVoiceConfig(record),
          record.title ?? null,
          retiredAt,
          record.createdAt,
          executionConfigJson,
          record.displayHandle ?? null
        );
      this.principals.ensureActorPrincipal(record.id, record.createdAt);
      this.db.prepare("DELETE FROM actor_handles WHERE actor_id = ?").run(record.id);
      const addHandle = this.db.prepare(
        "INSERT INTO actor_handles (actor_id, target_id, role) VALUES (?, ?, ?)"
      );
      for (const handle of record.handles ?? []) {
        let storedRole: string | null = null;
        if (handle.origin === "message") {
          storedRole = handle.role ? `__origin:message:${handle.role}` : "__origin:message";
        } else if (handle.role) {
          storedRole = handle.role.startsWith("__origin:")
            ? `__origin:explicit:${handle.role}`
            : handle.role;
        }
        addHandle.run(record.id, handle.id, storedRole);
      }
    })();
  }

  parentOf(id: string): string | null | undefined {
    const row = this.getParentStmt().get(id) as { parent_id: string | null } | undefined;
    return row ? row.parent_id : undefined;
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

  patch(id: string, changes: ActorRecordPatch): void {
    const record = this.get(id);
    if (record) this.upsert({ ...record, ...changes, id });
  }

  private fromRow(row: ActorRow): ActorRecord {
    const handles = this.db
      .prepare("SELECT target_id, role FROM actor_handles WHERE actor_id = ? ORDER BY target_id")
      .all(row.id) as Array<{ target_id: string; role: string | null }>;
    return {
      id: row.id,
      charter: row.charter,
      parentId: row.parent_id,
      ...parseExecutionConfig(row.id, row.execution_config),
      status: row.retired_at === null ? "active" : "retired",
      createdAt: row.created_at,
      ...parseModelConfig(row.id, row.model_config, this.modelClasses),
      ...parseContextConfig(row.id, row.context_config),
      ...parseVoiceConfig(row.id, row.voice_config),
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.display_handle === null ? {} : { displayHandle: row.display_handle }),
      ...(handles.length
        ? {
            handles: handles.map((handle) => {
              const roleText = handle.role ?? undefined;
              if (!roleText) {
                return { id: handle.target_id };
              }
              if (roleText.startsWith("__origin:explicit:")) {
                return {
                  id: handle.target_id,
                  role: roleText.slice("__origin:explicit:".length),
                };
              }
              if (roleText === "__origin:message") {
                return {
                  id: handle.target_id,
                  origin: "message" as const,
                };
              }
              if (roleText.startsWith("__origin:message:")) {
                return {
                  id: handle.target_id,
                  role: roleText.slice("__origin:message:".length),
                  origin: "message" as const,
                };
              }
              return {
                id: handle.target_id,
                role: roleText,
              };
            }),
          }
        : {}),
    };
  }
}
