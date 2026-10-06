import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Moves how an actor runs out of topology and out of `context_config` into a
 * versioned `actors.execution_config` document (#550):
 *
 *   { schemaVersion: 1, sandboxed: boolean, executionTarget?: string }
 *
 * `sandboxed` records requested managed sandboxing independently of where the
 * actor sits in the tree. It is neither an authorization grant nor proof of
 * effective isolation. `executionTarget` is the follower a remotely placed
 * actor runs on; absent, the actor runs on the leader.
 *
 * Per the database JSON policy the column carries no CHECK or json_* validator.
 * SqliteActorRepository enforces the shape by its version, refuses a write
 * that leaves the document out, and fails the read of a row without one.
 *
 * The backfill runs once, per row:
 * - `sandboxed` follows legacy topology: the sole parentless actor ran
 *   unsandboxed and every descendant sandboxed.
 * - A v2 `context_config` (#326) is the only place `executionTarget` was
 *   stored. The target is copied across verbatim, and the context document is
 *   rewritten as v1 with everything else unchanged. Only a strictly valid v2
 *   document is rewritten; malformed JSON and malformed v2 documents are
 *   left as they are so the new reader continues to fail closed.
 *
 * It also drops `actors_single_root_idx`, so the repository can store several
 * parentless actors. Until the forest-boot slice lands, running creation and
 * adoption paths enforce a single top-level actor.
 *
 * Rollback limits, once this has run:
 * - A pre-0056 binary reads no placement: it finds `executionTarget` only in
 *   `context_config`, so it runs a remotely placed actor on the leader. Its
 *   upserts never name `execution_config`, so the stored placement survives
 *   and returns when this binary is restored.
 * - An actor a pre-0056 binary inserts has no `execution_config`, and one it
 *   places writes a v2 `context_config`. This binary fails the read of either
 *   row rather than guess how it runs.
 */
export const actorExecutionConfig: Migration = {
  id: "0056_actor_execution_config",
  up: (db: Database) => {
    db.exec(`
      ALTER TABLE actors ADD COLUMN execution_config TEXT;
      DROP INDEX actors_single_root_idx;
    `);

    const rows = db.prepare("SELECT id, parent_id, context_config FROM actors").all() as Array<{
      id: string;
      parent_id: string | null;
      context_config: string | null;
    }>;
    const update = db.prepare(
      "UPDATE actors SET execution_config = ?, context_config = ? WHERE id = ?"
    );
    for (const row of rows) {
      let contextConfig = row.context_config;
      let executionTarget: string | undefined;
      const context = extractLegacyV2Context(row.context_config);
      if (context) {
        executionTarget = context.executionTarget;
        contextConfig = context.contextConfig;
      }
      update.run(
        JSON.stringify({
          schemaVersion: 1,
          sandboxed: row.parent_id !== null,
          ...(executionTarget !== undefined ? { executionTarget } : {}),
        }),
        contextConfig,
        row.id
      );
    }
  },
};

function extractLegacyV2Context(
  json: string | null
): { contextConfig: string; executionTarget?: string } | undefined {
  const context = parseObject(json);
  if (context?.schemaVersion !== 2) return undefined;

  const hasExecutionTarget = Object.hasOwn(context, "executionTarget");
  const executionTarget = context.executionTarget;
  if (hasExecutionTarget && typeof executionTarget !== "string") return undefined;

  const { executionTarget: _target, ...rest } = context;
  if (!isLegacyContext(rest)) return undefined;
  return {
    contextConfig: JSON.stringify({ ...rest, schemaVersion: 1 }),
    ...(typeof executionTarget === "string" ? { executionTarget } : {}),
  };
}

function isLegacyContext(context: Record<string, unknown>): boolean {
  const keys = Object.keys(context);
  if (
    context.schemaVersion !== 2 ||
    (context.type !== "native" && context.type !== "portable")
  ) {
    return false;
  }
  if (context.type === "native") {
    return (
      keys.every((key) => key === "schemaVersion" || key === "type" || key === "sessionId") &&
      (context.sessionId === undefined || typeof context.sessionId === "string")
    );
  }
  return (
    keys.every(
      (key) =>
        key === "schemaVersion" ||
        key === "type" ||
        key === "mode" ||
        key === "compactionModel"
    ) &&
    (context.mode === "tail" || context.mode === "ledger") &&
    (context.compactionModel === undefined || typeof context.compactionModel === "string")
  );
}

function parseObject(json: string | null): Record<string, unknown> | undefined {
  if (json === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
