import type Database from "better-sqlite3";
import { generateHandle } from "../../actor/handle-generator.js";
import type { ThreadRecord, ThreadRegistry } from "../../actor/thread-registry.js";
import { HUMAN_OPERATOR } from "../../mcp/stamp.js";

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

type ModelConfig = {
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
};

type ContextConfigJson = {
  type?: "native" | "portable" | null;
  sessionId?: string | null;
  mode?: "tail" | "ledger" | null;
  compactionModel?: string | null;
};

/** Builds the sparse `model_config` JSON object, or null when the tuple is entirely unset. */
function buildModelConfig(record: ThreadRecord): string | null {
  const config: ModelConfig = {};
  if (record.provider !== undefined) config.provider = record.provider;
  if (record.model !== undefined) config.model = record.model;
  if (record.effort !== undefined) config.effort = record.effort;
  return Object.keys(config).length ? JSON.stringify(config) : null;
}

function parseModelConfig(
  json: string | null
): Pick<ThreadRecord, "provider" | "model" | "effort"> {
  if (!json) return {};
  const parsed = JSON.parse(json) as ModelConfig;
  return {
    ...(parsed.provider != null ? { provider: parsed.provider } : {}),
    ...(parsed.model != null ? { model: parsed.model } : {}),
    ...(parsed.effort != null ? { effort: parsed.effort } : {}),
  };
}

/**
 * Builds the `context_config` JSON object grouping the native provider session
 * with portable-context selection, or null when neither is set. A `portable`
 * record never carries `sessionId` forward — a provider session is meaningless
 * once an actor is mesh-managed-context — and a record with a session but no
 * explicit `context` (the legacy default) normalizes to `type: "native"`,
 * matching the CHECK the `actors` table enforces on this column.
 */
function buildContextConfig(record: ThreadRecord): string | null {
  if (record.context?.type === "portable") {
    const config: ContextConfigJson = { type: "portable", mode: record.context.mode };
    if (record.context.compactionModel !== undefined) {
      config.compactionModel = record.context.compactionModel;
    }
    return JSON.stringify(config);
  }
  if (record.context?.type === "native" || record.sessionId !== undefined) {
    const config: ContextConfigJson = { type: "native" };
    if (record.sessionId !== undefined) config.sessionId = record.sessionId;
    return JSON.stringify(config);
  }
  return null;
}

function parseContextConfig(json: string | null): Pick<ThreadRecord, "context" | "sessionId"> {
  if (!json) return {};
  const parsed = JSON.parse(json) as ContextConfigJson;
  const out: Pick<ThreadRecord, "context" | "sessionId"> = {};
  if (parsed.type === "portable") {
    out.context = {
      type: "portable",
      mode: parsed.mode ?? "tail",
      ...(parsed.compactionModel ? { compactionModel: parsed.compactionModel } : {}),
    };
  } else if (parsed.type === "native") {
    out.context = { type: "native" };
  }
  if (parsed.sessionId != null) out.sessionId = parsed.sessionId;
  return out;
}

/** A staged, not-yet-applied model/provider/effort change. */
type DesiredOverlayEntry = {
  desiredProvider?: string;
  desiredModel?: string;
  desiredEffort?: string | null;
};

/**
 * SQLite implementation of the existing registry interface, storing the
 * operator-approved actor shape: `provider`/`model`/`effort` and native
 * session/portable-context selection each collapse into one validated JSON
 * object, root topology is derived from `parent_id IS NULL`, and retirement
 * is a nullable timestamp rather than a duplicate status enum.
 *
 * `desiredProvider`/`desiredModel`/`desiredEffort` are process memory, not a
 * durable row (an unapplied model change is discardable), so they live in an
 * instance-local overlay instead of a column: gone on reopen, present within
 * the same process across `get`/`patch` calls. Every `upsert` fully replaces
 * an id's overlay entry from whichever of the three keys are actually present
 * on the incoming record — `patch` always builds that record by spreading
 * `get(id)` (which already reads the current overlay back in) under the new
 * `changes`, so "key present with value `undefined`" (an explicit clear, e.g.
 * `desiredEffort: null` clearing to provider default, or `desiredModel:
 * undefined` after applying it) and "key absent" (leave whatever is staged
 * alone) stay distinguishable all the way through.
 */
export class DbThreadRegistry implements ThreadRegistry {
  private readonly desiredOverlay = new Map<string, DesiredOverlayEntry>();

  constructor(private readonly db: Database.Database) {}

  upsert(record: ThreadRecord): void {
    const isRoot = record.isRoot === true;
    if (record.parentId === null && !isRoot) {
      throw new Error(
        `DbThreadRegistry: refusing to store parentless actor '${record.id}' without isRoot — ` +
          "root topology is derived from parent_id IS NULL in this schema, so a parentless " +
          "non-root record (e.g. the ab-context rig holder) would be read back as root. Keep " +
          "that shape in the file-backed registry until this repository supports it explicitly."
      );
    }
    if (record.parentId !== null && isRoot) {
      throw new Error(
        `DbThreadRegistry: root actor '${record.id}' must have a null parentId (got '${record.parentId}')`
      );
    }

    this.storeDesiredOverlay(record);

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
      for (const handle of record.handles ?? [])
        addHandle.run(record.id, handle.id, handle.role ?? null);
    })();
  }

  get(id: string): ThreadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM actors WHERE id = ?").get(id) as
      | ActorRow
      | undefined;
    return row ? this.fromRow(row) : undefined;
  }
  list(): ThreadRecord[] {
    return (
      this.db.prepare("SELECT * FROM actors ORDER BY created_at, id").all() as ActorRow[]
    ).map((row) => this.fromRow(row));
  }
  children(parentId: string): ThreadRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM actors WHERE parent_id = ? ORDER BY created_at, id")
        .all(parentId) as ActorRow[]
    ).map((row) => this.fromRow(row));
  }
  resolveHandle(
    handleOrId: string,
    handleForId: (id: string) => string = generateHandle
  ): string | null {
    if (this.get(handleOrId)) return handleOrId;
    return (
      this.list().find(
        (record) => record.status === "active" && handleForId(record.id) === handleOrId
      )?.id ?? null
    );
  }
  patch(id: string, changes: Partial<Omit<ThreadRecord, "id">>): void {
    const record = this.get(id);
    if (record) this.upsert({ ...record, ...changes, id });
  }

  /**
   * Replaces `record.id`'s overlay entry wholesale from whichever desired-*
   * keys are present as own properties of `record` (`in`, not `!== undefined`
   * — an explicit clear is a present key with value `undefined`). A record
   * with none of the three keys (a fresh spawn, or a boot-time `adopt` merge
   * that never touches them) clears the overlay entirely rather than leaving
   * stale desired-* state for that id.
   */
  private storeDesiredOverlay(record: ThreadRecord): void {
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

  private fromRow(row: ActorRow): ThreadRecord {
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
      ...parseModelConfig(row.model_config),
      ...parseContextConfig(row.context_config),
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
