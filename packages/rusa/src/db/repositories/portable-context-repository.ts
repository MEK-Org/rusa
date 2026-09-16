import type Database from "better-sqlite3";
import {
  emptyPortableContextState,
  type PortableContextState,
  type PortableContextStore,
  parsePortableContextState,
  portableContextStateSchema,
} from "../../actor/portable-context-state.js";

type SnapshotRow = { snapshot: string };

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
export class DbPortableContextStore implements PortableContextStore {
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
