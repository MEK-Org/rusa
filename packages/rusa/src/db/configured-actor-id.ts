import type Database from "better-sqlite3";

/** Actor/principal identity columns, including attribution without a foreign key. */
export const CONFIGURED_ACTOR_ID_COLUMNS = {
  actors: ["id", "parent_id"],
  principals: ["id"],
  actor_handles: ["actor_id", "target_id"],
  users: ["root_actor_id"],
  capability_grants: ["actor_id", "granted_by"],
  event_source_owners: ["actor_id", "subscribed_by"],
  event_source_subscriptions: ["actor_id", "subscribed_by"],
  actor_experiments: ["actor_id", "enrolled_by"],
  host_jobs: ["actor_id"],
  chat_room_participants: ["actor_id", "added_by"],
  actor_inbox_entries: ["actor_id"],
  inbox_entry_obligations: ["actor_id"],
  obligation_capture_receipts: ["actor_id"],
  actor_runs: ["actor_id"],
  mesh_chat: ["sender_id", "recipient_id"],
  mesh_events: ["actor_id"],
  obligations: ["owner_id", "creator_id", "checkpoint_by"],
  obligation_artifacts: ["attached_by"],
  obligation_history: ["acting_principal"],
  portable_context_snapshots: ["actor_id"],
  portable_brief_revisions: ["actor_id", "acting_principal"],
  legacy_import_receipts: ["actor_id"],
} as const;

/**
 * Rekey the legacy literal inside the configured import's transaction. Deferring
 * FKs lets the existing actor row move without a second top-level actor or
 * deleting/recreating its dependent state. Commit still checks every FK.
 */
export function rekeyConfiguredActor(
  db: Database.Database,
  previousId: string,
  actorId: string
): void {
  if (!db.inTransaction) throw new Error("configured actor rekey requires an import transaction");
  if (db.prepare("SELECT 1 FROM principals WHERE id = ?").get(actorId)) {
    throw new Error(`configured actor id ${actorId} already belongs to a principal`);
  }
  db.pragma("defer_foreign_keys = ON");
  for (const [table, columns] of Object.entries(CONFIGURED_ACTOR_ID_COLUMNS)) {
    for (const column of columns) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(actorId, previousId);
    }
  }

  // A snapshot duplicates its actor key in the versioned document. Preserve the
  // version, cursors, item ids, statements, quotes and unknown fields verbatim.
  rewriteDocuments(db, "portable_context_snapshots", "snapshot", (value) => {
    replaceId(value, "actorId", previousId, actorId);
    if (Array.isArray(value.items)) {
      for (const item of value.items) {
        if (!isObject(item) || !Array.isArray(item.evidence)) continue;
        for (const evidence of item.evidence) {
          if (isObject(evidence)) replaceId(evidence, "sender", previousId, actorId);
        }
      }
    }
  });
  rewriteDocuments(db, "actor_inbox_entries", "payload_json", (value) => {
    // Directed mesh payloads carry the sender separately from mesh_chat.
    if (typeof value.type === "string" && value.type.startsWith("mesh.")) {
      replaceId(value, "fromId", previousId, actorId);
      replaceId(value, "toId", previousId, actorId);
    }
  });
  db.prepare("UPDATE actor_inbox_entries SET source = ? WHERE source = ?").run(
    `mesh:${actorId}`,
    `mesh:${previousId}`
  );
  db.prepare("UPDATE actor_inbox_entries SET source = ? WHERE source = ?").run(
    `mesh:mechanical:${actorId}`,
    `mesh:mechanical:${previousId}`
  );
  // Historical owner metadata is typed; prose and source references
  // keep their original bytes. Old inbox citations resolve via the import receipt.
  rewriteDocuments(db, "obligation_history", "payload", (value) => {
    for (const side of [value.before, value.after]) {
      if (!isObject(side)) continue;
      replaceId(side, "ownerId", previousId, actorId);
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function replaceId(value: Record<string, unknown>, key: string, from: string, to: string): void {
  if (value[key] === from) value[key] = to;
}
function rewriteDocuments(
  db: Database.Database,
  table: string,
  column: string,
  rewrite: (value: Record<string, unknown>) => void
): void {
  const update = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
  const projection = `SELECT rowid AS migration_rowid, ${column} AS document FROM ${table}`;
  const firstPage = db.prepare(`${projection} ORDER BY rowid LIMIT 256`).safeIntegers();
  const nextPage = db
    .prepare(`${projection} WHERE rowid > ? ORDER BY rowid LIMIT 256`)
    .safeIntegers();
  type Row = { migration_rowid: bigint; document: string };
  let rows = firstPage.all() as Row[];
  while (rows.length > 0) {
    for (const row of rows) {
      const value: unknown = JSON.parse(row.document);
      if (!isObject(value))
        throw new Error(`invalid ${table}.${column} during configured actor rekey`);
      const before = JSON.stringify(value);
      rewrite(value);
      const after = JSON.stringify(value);
      if (after !== before) update.run(after, row.migration_rowid);
    }
    rows = nextPage.all(rows[rows.length - 1].migration_rowid) as Row[];
  }
}
