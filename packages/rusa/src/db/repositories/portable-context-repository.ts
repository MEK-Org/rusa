import type Database from "better-sqlite3";
import { z } from "zod";
import {
  applyBriefCommit,
  emptyPortableContextState,
  type PortableBriefCommit,
  type PortableBriefRevision,
  type PortableBriefStore,
  type PortableContextState,
  type PortableContextStore,
  parsePortableContextState,
  portableContextStateSchema,
} from "../../actor/portable-context-state.js";

type SnapshotRow = { snapshot: string };

type BriefRevisionRow = {
  generation: number;
  acting_principal: string;
  timestamp: string;
  payload: string;
};

/** `portable_brief_revisions.payload` (0062), validated here at the point of consumption. */
const briefRevisionPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  before: z.string(),
  after: z.string(),
  explanation: z.string().optional(),
});

/**
 * SQLite implementation of {@link PortableContextStore} — every call reads
 * straight from `portable_context_snapshots` with no process-local cache, so a
 * snapshot written by one connection is visible to every other reader the
 * moment its transaction commits. That is what lets the compactor, the prompt
 * assembler and an out-of-process inspector agree on one snapshot without a
 * cache-invalidation story.
 *
 * `portable_context_snapshots.snapshot` carries no database-level shape
 * constraint (0048_portable_context_snapshots). The versioned document shape is
 * owned here, at the point of consumption: {@link parsePortableContextState}
 * reads a stored document forward on load, and
 * {@link portableContextStateSchema} validates on save, so a malformed value
 * cannot be written and an unreadable one is named rather than silently
 * treated as absent.
 */
export class DbPortableContextStore implements PortableContextStore, PortableBriefStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * The stored snapshot, or undefined when this actor has never been folded.
   * Use this where absence is meaningful; {@link load} is the reader for code
   * that wants an actor's memory as it stands.
   */
  find(actorId: string): PortableContextState | undefined {
    const row = this.db
      .prepare("SELECT snapshot FROM portable_context_snapshots WHERE actor_id = ?")
      .get(actorId) as SnapshotRow | undefined;
    if (row === undefined) return undefined;

    let parsed: PortableContextState;
    try {
      parsed = parsePortableContextState(JSON.parse(row.snapshot));
    } catch (cause) {
      // Never degrade to an empty state here. A snapshot that exists but will
      // not parse is unreconstructable memory, and quietly handing back an
      // empty ledger would let the next fold overwrite it with a generation-1
      // document built from whatever is still in the recent journal.
      throw new Error(
        `DbPortableContextStore: invalid portable-context snapshot for actor '${actorId}'`,
        { cause }
      );
    }
    if (parsed.actorId !== actorId) {
      throw new Error(
        `portable context actor mismatch: expected ${actorId}, got ${parsed.actorId}`
      );
    }
    return parsed;
  }

  load(actorId: string): PortableContextState {
    return this.find(actorId) ?? emptyPortableContextState(actorId);
  }

  save(state: PortableContextState): void {
    portableContextStateSchema.parse(state);
    this.db
      .prepare(
        `INSERT INTO portable_context_snapshots (actor_id, snapshot)
         VALUES (?, ?)
         ON CONFLICT(actor_id) DO UPDATE SET snapshot = excluded.snapshot`
      )
      .run(state.actorId, JSON.stringify(state));
  }

  saveFolded(state: PortableContextState): PortableContextState {
    return this.db
      .transaction(() => {
        const saved = { ...state, brief: this.load(state.actorId).brief };
        this.save(saved);
        return saved;
      })
      .immediate();
  }

  /**
   * Accept one brief write. The reread, the generation check, the snapshot
   * replace and the history append run in one immediate transaction, so a
   * writer that read an older generation gets a `StaleBriefWriteError`
   * and nothing changes, and the snapshot never shows a brief the history
   * lacks. `UNIQUE(actor_id, generation)` backs the check in the database.
   */
  commitBrief(input: PortableBriefCommit): PortableBriefRevision {
    return this.db
      .transaction(() => {
        const { state, revision } = applyBriefCommit(this.load(input.actorId), input);
        this.save(state);
        const payload: z.infer<typeof briefRevisionPayloadSchema> = {
          schemaVersion: 1,
          before: revision.before,
          after: revision.after,
          ...(revision.explanation === undefined ? {} : { explanation: revision.explanation }),
        };
        this.db
          .prepare(
            `INSERT INTO portable_brief_revisions
               (actor_id, generation, acting_principal, timestamp, payload)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            input.actorId,
            revision.generation,
            revision.actingPrincipal,
            revision.updatedAt,
            JSON.stringify(payload)
          );
        return revision;
      })
      .immediate();
  }

  listBriefRevisions(actorId: string, limit: number): PortableBriefRevision[] {
    const rows = this.db
      .prepare(
        `SELECT generation, acting_principal, timestamp, payload
         FROM portable_brief_revisions
         WHERE actor_id = ?
         ORDER BY generation DESC
         LIMIT ?`
      )
      .all(actorId, limit) as BriefRevisionRow[];
    return rows.map((row) => {
      const payload = briefRevisionPayloadSchema.parse(JSON.parse(row.payload));
      return {
        generation: row.generation,
        updatedAt: row.timestamp,
        actingPrincipal: row.acting_principal,
        before: payload.before,
        after: payload.after,
        ...(payload.explanation === undefined ? {} : { explanation: payload.explanation }),
      };
    });
  }

  /**
   * How many actors hold durable memory. The legacy importer asks this before
   * it issues the import receipt: any row at all means the database already
   * became authoritative, whatever the legacy directory holds.
   */
  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM portable_context_snapshots")
      .get() as { count: number };
    return row.count;
  }
}
