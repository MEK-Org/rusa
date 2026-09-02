import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

interface TableColumn {
  name: string;
}

function hasColumns(db: Database, table: string, columns: string[]): boolean {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as TableColumn[]).map((column) => column.name)
  );
  return columns.every((column) => present.has(column));
}

/**
 * The event `kind` the regressed message_sent / message_received rows are
 * re-labelled to. Deliberately NOT a message kind: a mechanical notice is not a
 * mesh message (that is the whole point of ISSUE_NUM), so its historical event rows
 * must fall out of every message-scoped reader (portable-context assembly, the
 * conversation view). It is not `message_sent`/`message_received` and so no
 * kind-scoped query selects it; the raw all-kinds events log still shows it,
 * correctly labelled, as the durable record that a mechanical notice occurred.
 */
const NORMALIZED_MECHANICAL_KIND = "mechanical_note";

/**
 * One-shot cleanup of the durable rows the ISSUE_NUM regression window
 * (2026-07-26 → 2026-08-07) minted for every mechanical run-lifecycle notice
 * (yield / run-failure / scheduled-drop).
 *
 * ISSUE_NUM ("Make the inbox the actor worklist", commit `8f5112c40`) re-coupled
 * {@link deliverMechanicalInboxNotice} to `recordMessageEmitted`, which writes a
 * **three-part durable shape** per notice:
 *   1. a `mesh_chat` row (id = the minted messageId, body = the decorated note);
 *   2. `message_sent` + `message_received` events in `mesh_events`, each carrying
 *      that messageId in `payload.$.messageId`;
 *   3. an `actor_inbox_entries` row whose `mesh.mechanical_note` payload points at
 *      the chat row via `payload_json.$.messageId` (instead of storing the note
 *      inline).
 * The conversation view joins (1)+(2), so every notice resurfaced in the
 * root⇄child chat; and the orphan `message_received` events would pollute
 * portable-context with null-body pseudo-messages. The runtime fix drops the
 * `recordChat` call and stores the note inline in the inbox payload again
 * (restoring the 2833bde29 form). This migration retires the rows already recorded.
 *
 * **Scoped by durable provenance, not body prefix.** The regressed set is exactly
 * the `mesh.mechanical_note` inbox rows that still carry a `messageId` pointer
 * (the new inline form has `note`, never `messageId`). Their messageIds are the
 * precise chat-row ids and event `payload.$.messageId` values to retire — so a
 * genuine actor/human message that merely *begins* with a reserved tag is never
 * touched. ("Reserved by convention" is not provenance — seal's must-fix.)
 *
 * For each such notice we:
 *   1. rewrite the inbox payload to the new inline shape — `note` = the chat body,
 *      `messageId` removed — BEFORE deleting the chat row, so no reader is left
 *      resolving a dangling pointer;
 *   2. delete the `mesh_chat` row (removes it from the conversation view, whose
 *      2-actor predicate requires a matching chat row);
 *   3. re-label the paired `message_sent`/`message_received` events to
 *      {@link NORMALIZED_MECHANICAL_KIND}. We re-label rather than DELETE on
 *      purpose: at this migration's point in the upgrade chain, portable-context
 *      v2 still carried an event-id watermark. Re-labelling preserves that
 *      historical cursor until 0030 maps it onto durable chat/run sources, while
 *      dropping the row out of every `kind = 'message_received'` reader.
 *
 * Idempotent: after a run the inbox payloads no longer carry `messageId`, so a
 * re-run selects nothing and touches nothing.
 */
export const cleanupRegressedMechanicalChatRows: Migration = {
  id: "0014_cleanup_regressed_mechanical_chat_rows",
  up: (db: Database) => {
    if (
      !hasColumns(db, "actor_inbox_entries", ["id", "payload_json"]) ||
      !hasColumns(db, "mesh_chat", ["id", "body"]) ||
      !hasColumns(db, "mesh_events", ["kind", "payload"])
    ) {
      console.log("0014: skipped regressed-mechanical cleanup; a required table/column is absent.");
      return;
    }

    // Provenance anchor: mechanical-note inbox rows still holding a messageId
    // pointer. The new inline form carries `note` and no `messageId`, so this
    // selects exactly the regressed rows and re-selects none after the run.
    const regressed = db
      .prepare(
        `SELECT id AS inboxId, json_extract(payload_json, '$.messageId') AS mid
           FROM actor_inbox_entries
          WHERE json_extract(payload_json, '$.type') = 'mesh.mechanical_note'
            AND json_extract(payload_json, '$.messageId') IS NOT NULL`
      )
      .all() as { inboxId: string; mid: string }[];

    if (regressed.length === 0) {
      console.log("0014: no regressed mechanical notices to clean up.");
      return;
    }

    // 1. Migrate the inbox payload to the inline `note` form, reading the note
    //    from the chat row while it still exists. Remove the `messageId` pointer.
    const migrateInbox = db.prepare(
      `UPDATE actor_inbox_entries
          SET payload_json = json_set(
                json_remove(payload_json, '$.messageId'),
                '$.note',
                (SELECT body FROM mesh_chat WHERE id = ?)
              )
        WHERE id = ?`
    );
    // 2. Delete the regressed chat row (provenance-scoped by messageId).
    const deleteChat = db.prepare(`DELETE FROM mesh_chat WHERE id = ?`);
    // 3. Re-label the paired message events (id/rowid preserved: watermark-safe).
    const normalizeEvents = db.prepare(
      `UPDATE mesh_events
          SET kind = ?
        WHERE kind IN ('message_sent', 'message_received')
          AND json_extract(payload, '$.messageId') = ?`
    );

    let inboxMigrated = 0;
    let chatDeleted = 0;
    let eventsNormalized = 0;
    for (const { inboxId, mid } of regressed) {
      inboxMigrated += migrateInbox.run(mid, inboxId).changes;
      chatDeleted += deleteChat.run(mid).changes;
      eventsNormalized += normalizeEvents.run(NORMALIZED_MECHANICAL_KIND, mid).changes;
    }

    console.log(
      `0014: cleaned ${regressed.length} regressed mechanical notices — ` +
        `${inboxMigrated} inbox payloads inlined, ${chatDeleted} mesh_chat rows removed, ` +
        `${eventsNormalized} paired events re-labelled to ${NORMALIZED_MECHANICAL_KIND}.`
    );
  },
};
