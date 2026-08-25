import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const PORTABLE_CONTEXT_SCHEMA_VERSION = 2 as const;

/**
 * Every kind a *persisted* ledger file may contain.
 *
 * This must stay wide, and in particular must never be narrowed to match what
 * the compactor is currently allowed to author ({@link authorableMemoryKindSchema}).
 * The two are separate on purpose: this enum is embedded in
 * {@link portableContextStateSchema}, which `FilePortableContextStore.load()`
 * `parse()`s on every read, so narrowing it invalidates files already on disk —
 * retroactively, and with no migration step to notice it.
 *
 * Measured against live state on 2026-08-21T18:10Z, before ISSUE_NUM leg 3: cutting
 * `commitment` and `open_question` out of this enum made **17 of 17** state
 * files fail to load, covering **100 of 127** items. The `ZodError` surfaces
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
 * an LLM fold. Items of a retired kind that are already on disk stay readable
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

export const portableContextStateSchema = z.object({
  schemaVersion: z.literal(PORTABLE_CONTEXT_SCHEMA_VERSION),
  actorId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  lastFoldedMessageEventId: z.string().min(1).nullable(),
  compactor: z
    .object({
      provider: z.literal("gemini"),
      model: z.string().min(1),
    })
    .nullable(),
  items: z.array(portableMemoryItemSchema),
});
export type PortableContextState = z.infer<typeof portableContextStateSchema>;

export function emptyPortableContextState(actorId: string): PortableContextState {
  return {
    schemaVersion: PORTABLE_CONTEXT_SCHEMA_VERSION,
    actorId,
    generation: 0,
    updatedAt: new Date(0).toISOString(),
    lastFoldedMessageEventId: null,
    compactor: null,
    items: [],
  };
}

export interface PortableContextStore {
  load(actorId: string): PortableContextState;
  save(state: PortableContextState): void;
  pathFor(actorId: string): string;
}

/** Human-readable, atomically replaced materialized cache over mesh_events. */
export class FilePortableContextStore implements PortableContextStore {
  constructor(private readonly dir: string) {}

  pathFor(actorId: string): string {
    return join(this.dir, `${actorId}.json`);
  }

  load(actorId: string): PortableContextState {
    const path = this.pathFor(actorId);
    if (!existsSync(path)) return emptyPortableContextState(actorId);
    const parsed = portableContextStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (parsed.actorId !== actorId) {
      throw new Error(
        `portable context actor mismatch: expected ${actorId}, got ${parsed.actorId}`
      );
    }
    return parsed;
  }

  save(state: PortableContextState): void {
    portableContextStateSchema.parse(state);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const path = this.pathFor(state.actorId);
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
      chmodSync(path, 0o600);
    } finally {
      rmSync(tmp, { force: true });
    }
  }
}

export class InMemoryPortableContextStore implements PortableContextStore {
  private readonly states = new Map<string, PortableContextState>();

  pathFor(actorId: string): string {
    return `memory://${actorId}`;
  }

  load(actorId: string): PortableContextState {
    return structuredClone(this.states.get(actorId) ?? emptyPortableContextState(actorId));
  }

  save(state: PortableContextState): void {
    portableContextStateSchema.parse(state);
    this.states.set(state.actorId, structuredClone(state));
  }
}
