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
 * The brief's own monotonic position in the durable source stream, mirroring
 * the ledger source ordering (`ts`, then the message/yield discriminator,
 * then id as the tiebreak — never a UUID comparison on its own). `null` means
 * "before every source": either the actor was switched to brief mode before
 * any durable source existed, or no source has been incorporated yet.
 */
export const briefCursorSchema = z.object({
  ts: z.string().min(1),
  sourceOrder: z.number().int().min(0),
  id: z.string().min(1),
});
export type BriefCursor = z.infer<typeof briefCursorSchema>;

/**
 * The per-actor `brief` portable-context mode document (#954 iteration 1).
 *
 * Stored INSIDE the versioned snapshot document (schemaVersion v4) rather than
 * in its own table: `portable_context_snapshots` is already one versioned JSON
 * document per actor with no database-level shape constraint, and keeping the
 * brief beside the ledger is what makes switch-back free — the ledger `items`,
 * ledger generation and `lastFoldedSourceId` stay in the same document,
 * untouched by brief rewrites.
 *
 * The brief cursor and generation are the brief's OWN sequence position and
 * counter, fully independent of the ledger watermark and ledger generation:
 * a brief rewrite must never advance or otherwise touch the ledger fields.
 *
 * `consecutiveFailures`, `frozen` and `resolvedRefs` are the minimal
 * retry/freeze/resolved-ref-cache bookkeeping the rewrite cycle needs to
 * survive restarts; their shape is enforced here, at the point of
 * consumption, exactly like the rest of the document.
 */
export const portableBriefSchema = z.object({
  /** The rendered three-section brief text (WHAT/HOW/DOMAIN), verbatim. */
  text: z.string(),
  cursor: briefCursorSchema.nullable(),
  generation: z.number().int().nonnegative(),
  /** The Gemini model that produced the current text; null on the seed. */
  model: z.string().nullable(),
  updatedAt: z.string().min(1),
  /** Failed rewrite cycles since the last accepted rewrite (repair retries inside one cycle count once). */
  consecutiveFailures: z.number().int().nonnegative(),
  /**
   * Rewrites are frozen after three consecutive failed cycles until the
   * raised needs-attention item is handled. Handling releases the freeze: any
   * inbound human or ancestor message after the frozen cursor is the parent's
   * handling reply reaching the actor, and the cycle that sees it clears
   * `frozen` and resets the failure budget before rewriting (see
   * portable-context-brief.ts).
   */
  frozen: z.boolean(),
  /**
   * Per-actor resolved-ref cache, keyed by the canonical ref string: every ref
   * that has been successfully resolved at least once. A ref is resolved only
   * on its first appearance for the actor; a rewrite that introduces no new
   * ref makes zero resolution calls (for GitHub refs: zero tracker calls).
   */
  resolvedRefs: z.array(z.string().min(1)),
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
}

export class InMemoryPortableContextStore implements PortableContextStore {
  private readonly states = new Map<string, PortableContextState>();

  load(actorId: string): PortableContextState {
    return structuredClone(this.states.get(actorId) ?? emptyPortableContextState(actorId));
  }

  save(state: PortableContextState): void {
    portableContextStateSchema.parse(state);
    this.states.set(state.actorId, structuredClone(state));
  }
}
