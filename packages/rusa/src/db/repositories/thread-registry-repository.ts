import type Database from "better-sqlite3";
import { generateHandle } from "../../actor/handle-generator.js";
import type { ThreadRecord, ThreadRegistry } from "../../actor/thread-registry.js";

type ThreadRow = {
  id: string;
  charter: string;
  parent_id: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  desired_provider: string | null;
  desired_model: string | null;
  desired_effort: string | null;
  desired_effort_is_set: number;
  session_id: string | null;
  context_type: "native" | "portable" | null;
  context_mode: "tail" | "ledger" | null;
  context_compaction_model: string | null;
  title: string | null;
  is_root: number;
  status: ThreadRecord["status"];
  budget_max_runs: number | null;
  budget_runs_used: number | null;
  human_unlocked: number;
  last_chat_session_id: string | null;
  created_at: string;
};

/** SQLite implementation of the existing registry interface. */
export class DbThreadRegistry implements ThreadRegistry {
  constructor(private readonly db: Database.Database) {}

  upsert(record: ThreadRecord): void {
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO actor_threads (
        id, charter, parent_id, provider, model, effort, desired_provider, desired_model, desired_effort, desired_effort_is_set,
        session_id, context_type, context_mode, context_compaction_model, title, is_root, status,
        budget_max_runs, budget_runs_used, human_unlocked, last_chat_session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET charter=excluded.charter, parent_id=excluded.parent_id,
        provider=excluded.provider, model=excluded.model, effort=excluded.effort,
        desired_provider=excluded.desired_provider, desired_model=excluded.desired_model,
        desired_effort=excluded.desired_effort, desired_effort_is_set=excluded.desired_effort_is_set, session_id=excluded.session_id,
        context_type=excluded.context_type, context_mode=excluded.context_mode,
        context_compaction_model=excluded.context_compaction_model, title=excluded.title,
        is_root=excluded.is_root, status=excluded.status, budget_max_runs=excluded.budget_max_runs,
        budget_runs_used=excluded.budget_runs_used, human_unlocked=excluded.human_unlocked,
        last_chat_session_id=excluded.last_chat_session_id, created_at=excluded.created_at`)
        .run(
          record.id,
          record.charter,
          record.parentId,
          record.provider ?? null,
          record.model ?? null,
          record.effort ?? null,
          record.desiredProvider ?? null,
          record.desiredModel ?? null,
          record.desiredEffort ?? null,
          record.desiredEffort === undefined ? 0 : 1,
          record.sessionId ?? null,
          record.context?.type ?? null,
          record.context?.type === "portable" ? record.context.mode : null,
          record.context?.type === "portable" ? (record.context.compactionModel ?? null) : null,
          record.title ?? null,
          record.isRoot ? 1 : 0,
          record.status,
          record.budget?.maxRuns ?? null,
          record.budget?.runsUsed ?? null,
          record.humanUnlocked ? 1 : 0,
          record.lastChatSessionId ?? null,
          record.createdAt
        );
      this.db.prepare("DELETE FROM actor_handles WHERE actor_id = ?").run(record.id);
      const addHandle = this.db.prepare(
        "INSERT INTO actor_handles (actor_id, target_id, role) VALUES (?, ?, ?)"
      );
      for (const handle of record.handles ?? [])
        addHandle.run(record.id, handle.id, handle.role ?? null);
      this.db.prepare("DELETE FROM actor_pending_deliveries WHERE actor_id = ?").run(record.id);
      const addDelivery = this.db.prepare(
        "INSERT INTO actor_pending_deliveries (actor_id, id, from_id, body, deliver_at, session_id) VALUES (?, ?, ?, ?, ?, ?)"
      );
      for (const delivery of record.pendingDeliveries ?? [])
        addDelivery.run(
          record.id,
          delivery.id,
          delivery.fromId,
          delivery.body,
          delivery.deliverAt,
          delivery.sessionId ?? null
        );
    })();
  }

  get(id: string): ThreadRecord | undefined {
    const row = this.db.prepare("SELECT * FROM actor_threads WHERE id = ?").get(id) as
      | ThreadRow
      | undefined;
    return row ? this.fromRow(row) : undefined;
  }
  list(): ThreadRecord[] {
    return (
      this.db.prepare("SELECT * FROM actor_threads ORDER BY created_at, id").all() as ThreadRow[]
    ).map((row) => this.fromRow(row));
  }
  children(parentId: string): ThreadRecord[] {
    return (
      this.db
        .prepare("SELECT * FROM actor_threads WHERE parent_id = ? ORDER BY created_at, id")
        .all(parentId) as ThreadRow[]
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

  private fromRow(row: ThreadRow): ThreadRecord {
    const handles = this.db
      .prepare("SELECT target_id, role FROM actor_handles WHERE actor_id = ? ORDER BY target_id")
      .all(row.id) as Array<{ target_id: string; role: string | null }>;
    const deliveries = this.db
      .prepare(
        "SELECT id, from_id, body, deliver_at, session_id FROM actor_pending_deliveries WHERE actor_id = ? ORDER BY deliver_at, id"
      )
      .all(row.id) as Array<{
      id: string;
      from_id: string;
      body: string;
      deliver_at: string;
      session_id: string | null;
    }>;
    return {
      id: row.id,
      charter: row.charter,
      parentId: row.parent_id,
      status: row.status,
      createdAt: row.created_at,
      ...(row.provider === null ? {} : { provider: row.provider }),
      ...(row.model === null ? {} : { model: row.model }),
      ...(row.effort === null ? {} : { effort: row.effort }),
      ...(row.desired_provider === null ? {} : { desiredProvider: row.desired_provider }),
      ...(row.desired_model === null ? {} : { desiredModel: row.desired_model }),
      ...(row.desired_effort_is_set ? { desiredEffort: row.desired_effort } : {}),
      ...(row.session_id === null ? {} : { sessionId: row.session_id }),
      ...(row.context_type === "portable"
        ? {
            context: {
              type: "portable" as const,
              mode: row.context_mode ?? "tail",
              ...(row.context_compaction_model
                ? { compactionModel: row.context_compaction_model }
                : {}),
            },
          }
        : row.context_type === "native"
          ? { context: { type: "native" as const } }
          : {}),
      ...(row.title === null ? {} : { title: row.title }),
      ...(row.is_root ? { isRoot: true } : {}),
      ...(row.budget_max_runs === null && row.budget_runs_used === null
        ? {}
        : {
            budget: {
              ...(row.budget_max_runs === null ? {} : { maxRuns: row.budget_max_runs }),
              ...(row.budget_runs_used === null ? {} : { runsUsed: row.budget_runs_used }),
            },
          }),
      ...(handles.length
        ? {
            handles: handles.map((handle) => ({
              id: handle.target_id,
              ...(handle.role ? { role: handle.role } : {}),
            })),
          }
        : {}),
      ...(deliveries.length
        ? {
            pendingDeliveries: deliveries.map((delivery) => ({
              id: delivery.id,
              fromId: delivery.from_id,
              body: delivery.body,
              deliverAt: delivery.deliver_at,
              ...(delivery.session_id ? { sessionId: delivery.session_id } : {}),
            })),
          }
        : {}),
      ...(row.human_unlocked ? { humanUnlocked: true } : {}),
      ...(row.last_chat_session_id === null ? {} : { lastChatSessionId: row.last_chat_session_id }),
    };
  }
}
