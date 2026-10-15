import { z } from "zod";

export const PORTABLE_CONTEXT_SCHEMA_VERSION = 4 as const;

/**
 * Every kind a *persisted* ledger snapshot may contain.
 *
 * This must stay wide, and in particular must never be narrowed to match what
 * the compactor is currently allowed to author ({@link authorableMemoryKindSchema}).
 * The two are separate on purpose: this enum is embedded in
 * {@link portableContextStateSchema}, which {@link parsePortableContextState}
 * applies to every stored document on every read, so narrowing it invalidates
 * snapshots already persisted — retroactively, and with no migration step to
 * notice it.
 *
 * Measured against live state on 2026-08-21T18:10Z, before ISSUE_NUM leg 3: cutting
 * `commitment` and `open_question` out of this enum made **17 of 17** state
 * documents fail to load, covering **100 of 127** items. The `ZodError` surfaces
 * inside the `buildPrompt` closure in `commands/start.ts`, which has no
 * `try`/`catch`, so the effect is not degraded context — the actor cannot start
 * at all. Retiring a kind removes its prompt authority (see `renderLedger`) and
 * its authorability (see below); it does not delete the evidence.
 */
export const portableMemoryKindSchema = z.enum([
  "constraint",
  "decision",
  "rationale",
  "commitment",
  "open_question",
]);
export type PortableMemoryKind = z.infer<typeof portableMemoryKindSchema>;

/**
 * The kinds the compactor may author.
 *
 * `commitment` and `open_question` are absent because the obligation store is
 * their system of record : work state is created there, explicitly, by
 * the actor, through a deterministic gateway — never inferred into existence by
 * an LLM fold. Items of a retired kind that are already persisted stay readable
 * and queryable as provenance; they are simply frozen and unrendered.
 */
export const authorableMemoryKindSchema = z.enum(["constraint", "decision", "rationale"]);
export type AuthorableMemoryKind = z.infer<typeof authorableMemoryKindSchema>;

/** Kinds that persist and are readable, but can no longer be authored or rendered. */
export const RETIRED_MEMORY_KINDS: readonly PortableMemoryKind[] = ["commitment", "open_question"];

export function isRetiredMemoryKind(kind: PortableMemoryKind): boolean {
  return RETIRED_MEMORY_KINDS.includes(kind);
}

export const portableMemoryPrioritySchema = z.enum(["must", "should", "background"]);
export type PortableMemoryPriority = z.infer<typeof portableMemoryPrioritySchema>;

const portableMemoryEvidenceSchema = z.object({
  eventId: z.string().min(1),
  sender: z.string().min(1),
  ts: z.string().min(1),
  quote: z.string().min(1),
});
export type PortableMemoryEvidence = z.infer<typeof portableMemoryEvidenceSchema>;

const portableMemoryItemSchema = z.object({
  id: z.string().min(1),
  kind: portableMemoryKindSchema,
  priority: portableMemoryPrioritySchema,
  status: z.enum(["active", "superseded", "resolved"]),
  statement: z.string().min(1),
  evidence: z.array(portableMemoryEvidenceSchema).min(1),
  updatedAt: z.string().min(1),
});
export type PortableMemoryItem = z.infer<typeof portableMemoryItemSchema>;

/**
 * The per-actor `brief` portable-context mode document (#954).
 *
 * Stored INSIDE the versioned snapshot document (schemaVersion v4) rather than
 * in its own table: `portable_context_snapshots` is already one versioned JSON
 * document per actor with no database-level shape constraint, and keeping the
 * brief beside the ledger is what makes switch-back free — the ledger `items`,
 * ledger generation and `lastFoldedSourceId` stay in the same document,
 * untouched by brief writes.
 *
 * The actor writes its own brief through the brief MCP server; nothing rewrites
 * it after a run. The snapshot holds only the CURRENT brief. Its accepted-write
 * history lives in `portable_brief_revisions` (0062), the one authoritative
 * history, appended in the same transaction that replaces this document.
 */
export const portableBriefSchema = z.object({
  /** The three-section brief text (WHAT/HOW/DOMAIN), verbatim. */
  text: z.string(),
  /** Accepted-write counter: 0 for the seed, +1 per accepted change, unchanged by a no-op. */
  generation: z.number().int().nonnegative(),
  /** Time of the last accepted write (the seed time before the first one). */
  updatedAt: z.string().min(1),
});
export type PortableBrief = z.infer<typeof portableBriefSchema>;

const portableContextStateFields = {
  actorId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  compactor: z
    .object({
      provider: z.literal("gemini"),
      model: z.string().min(1),
    })
    .nullable(),
  items: z.array(portableMemoryItemSchema),
};

export const portableContextStateSchema = z.object({
  schemaVersion: z.literal(PORTABLE_CONTEXT_SCHEMA_VERSION),
  ...portableContextStateFields,
  /** Durable mesh_chat or actor_runs id; never a mesh_events cursor after v3 writes. */
  lastFoldedSourceId: z.string().min(1).nullable(),
  /** The brief-mode document; null until the actor is switched to brief mode. */
  brief: portableBriefSchema.nullable(),
});
export type PortableContextState = z.infer<typeof portableContextStateSchema>;

const portableContextStateV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...portableContextStateFields,
  lastFoldedMessageEventId: z.string().min(1).nullable(),
});

/** A v3 document: identical to v4 except it predates the `brief` object. */
const portableContextStateV3Schema = z.object({
  schemaVersion: z.literal(3),
  ...portableContextStateFields,
  lastFoldedSourceId: z.string().min(1).nullable(),
});

/**
 * Read a persisted snapshot document forward to the current schema version.
 *
 * This is the whole shape contract for stored portable context: the column
 * holding it carries no database-level validator (0048_portable_context_snapshots),
 * exactly as `actors.model_config` and `host_jobs.manifest` carry none, so a
 * document only ever becomes state by passing through here. Exported because
 * both consumers need the same forward read — the durable store on every load,
 * and the one-time legacy importer on every file it parses.
 *
 * The chain is incremental, one version at a time, exactly as v2→v3 was: v2
 * renames the event watermark to the durable-source cursor, v3→v4 (#954)
 * adds the nullable `brief` object. Each step only ever ADDS fields, so a
 * document written by any older build reads forward without data loss and the
 * ledger fields it already carried round-trip byte-identically.
 */
export function parsePortableContextState(value: unknown): PortableContextState {
  const version =
    value !== null && typeof value === "object" && "schemaVersion" in value
      ? (value as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (version !== 2 && version !== 3) return portableContextStateSchema.parse(value);
  if (version === 3) {
    const v3 = portableContextStateV3Schema.parse(value);
    return portableContextStateSchema.parse({
      ...v3,
      schemaVersion: PORTABLE_CONTEXT_SCHEMA_VERSION,
      brief: null,
    });
  }
  const legacy = portableContextStateV2Schema.parse(value);
  return portableContextStateSchema.parse({
    ...legacy,
    schemaVersion: PORTABLE_CONTEXT_SCHEMA_VERSION,
    lastFoldedSourceId: legacy.lastFoldedMessageEventId,
    lastFoldedMessageEventId: undefined,
    brief: null,
  });
}

export function emptyPortableContextState(actorId: string): PortableContextState {
  return {
    schemaVersion: PORTABLE_CONTEXT_SCHEMA_VERSION,
    actorId,
    generation: 0,
    updatedAt: new Date(0).toISOString(),
    lastFoldedSourceId: null,
    compactor: null,
    items: [],
    brief: null,
  };
}

/**
 * Persistence boundary for portable-context snapshots — SQLite in production
 * (`DbPortableContextStore`), in-memory for tests. A snapshot is authoritative
 * memory rather than a cache: `load` returning an empty state means this actor
 * has never been folded, never that a stored snapshot could not be read.
 */
export interface PortableContextStore {
  load(actorId: string): PortableContextState;
  save(state: PortableContextState): void;
  /** Save ledger fold fields while atomically preserving the latest stored brief. */
  saveFolded(state: PortableContextState): PortableContextState;
}

/** One accepted brief write, read back from the append-only brief history. */
export interface PortableBriefRevision {
  generation: number;
  updatedAt: string;
  /** Server-bound writer identity; never taken from tool input. */
  actingPrincipal: string;
  /** The brief text this write replaced. */
  before: string;
  after: string;
  /** The writer's optional account of why it changed the brief. */
  explanation?: string;
}

export interface PortableBriefCommit {
  actorId: string;
  /** The generation the writer read; a write against any other generation is refused. */
  expectedGeneration: number;
  text: string;
  explanation?: string;
  actingPrincipal: string;
  at: string;
}

/** A write whose expected generation is no longer the stored one. Nothing was written. */
export class StaleBriefWriteError extends Error {
  constructor(
    readonly actorId: string,
    readonly expectedGeneration: number,
    readonly currentGeneration: number | null
  ) {
    super(
      currentGeneration === null
        ? `actor ${actorId} has no brief to replace`
        : `stale brief write for actor ${actorId}: expected generation ${expectedGeneration}, current is ${currentGeneration}; read the brief again before replacing it`
    );
    this.name = "StaleBriefWriteError";
  }
}

/**
 * Brief writes and their history. {@link commitBrief} is the only accepted-write
 * path: it rereads the stored brief, refuses a stale `expectedGeneration`, and
 * replaces the snapshot and appends the revision as one unit, so the current
 * brief and its history cannot disagree.
 */
export interface PortableBriefStore {
  commitBrief(input: PortableBriefCommit): PortableBriefRevision;
  /** Newest first, at most `limit`. */
  listBriefRevisions(actorId: string, limit: number): PortableBriefRevision[];
}

/** The snapshot an accepted brief write leaves behind; shared by both stores. */
export function applyBriefCommit(
  state: PortableContextState,
  input: PortableBriefCommit
): { state: PortableContextState; revision: PortableBriefRevision } {
  const current = state.brief;
  if (current === null || current.generation !== input.expectedGeneration) {
    throw new StaleBriefWriteError(
      input.actorId,
      input.expectedGeneration,
      current?.generation ?? null
    );
  }
  const revision: PortableBriefRevision = {
    generation: current.generation + 1,
    updatedAt: input.at,
    actingPrincipal: input.actingPrincipal,
    before: current.text,
    after: input.text,
    ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
  };
  return {
    state: {
      ...state,
      brief: { text: input.text, generation: revision.generation, updatedAt: input.at },
    },
    revision,
  };
}

export class InMemoryPortableContextStore implements PortableContextStore, PortableBriefStore {
  private readonly states = new Map<string, PortableContextState>();
  private readonly revisions = new Map<string, PortableBriefRevision[]>();

  load(actorId: string): PortableContextState {
    return structuredClone(this.states.get(actorId) ?? emptyPortableContextState(actorId));
  }

  save(state: PortableContextState): void {
    portableContextStateSchema.parse(state);
    this.states.set(state.actorId, structuredClone(state));
  }

  saveFolded(state: PortableContextState): PortableContextState {
    const saved = { ...state, brief: this.load(state.actorId).brief };
    this.save(saved);
    return saved;
  }

  commitBrief(input: PortableBriefCommit): PortableBriefRevision {
    const { state, revision } = applyBriefCommit(this.load(input.actorId), input);
    this.save(state);
    this.revisions.set(input.actorId, [...(this.revisions.get(input.actorId) ?? []), revision]);
    return structuredClone(revision);
  }

  listBriefRevisions(actorId: string, limit: number): PortableBriefRevision[] {
    return structuredClone((this.revisions.get(actorId) ?? []).slice(-limit).reverse());
  }
}
