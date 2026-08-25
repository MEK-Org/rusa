import type { Database } from "better-sqlite3";
import { CHAT_EXCLUDED_BODY_PREFIXES, DROPPED_MESSAGE_DETAIL } from "../../actor/mesh-events.js";
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

export const backfillMeshChatFromLegacyEvents: Migration = {
  id: "0006_backfill_mesh_chat_from_legacy_events",
  up: (db: Database) => {
    if (
      !hasColumns(db, "mesh_events", [
        "id",
        "ts",
        "kind",
        "actor_id",
        "peer_id",
        "detail",
        "body",
        "payload",
      ])
    ) {
      console.log(
        "Skipped 0 dropped message_sent rows during legacy mesh_chat backfill; mesh_events lacks the legacy message columns."
      );
      for (const prefix of CHAT_EXCLUDED_BODY_PREFIXES) {
        console.log(
          `Skipped 0 ${JSON.stringify(prefix)} message rows during legacy mesh_chat backfill.`
        );
      }
      return;
    }

    const excludedBodyPredicates = notLikePrefixPredicates("body");
    const excludedBodyPredicatesForEvents = notLikePrefixPredicates("e.body");
    const excludedBodyLikeParams = CHAT_EXCLUDED_BODY_PREFIXES.map((prefix) => `${prefix}%`);

    const droppedSkipped = (
      db
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM mesh_events
          WHERE kind = 'message_sent'
            AND detail = ?
            AND body IS NOT NULL
            AND payload IS NULL
        `
        )
        .get(DROPPED_MESSAGE_DETAIL) as { count: number }
    ).count;

    console.log(
      `Skipped ${droppedSkipped} dropped message_sent rows during legacy mesh_chat backfill.`
    );

    const countSkippedByPrefix = db.prepare(
      `
          SELECT COUNT(*) AS count
          FROM mesh_events e
          WHERE e.kind IN ('message_sent', 'message_received')
            AND e.body IS NOT NULL
            AND e.payload IS NULL
            AND (e.kind != 'message_sent' OR e.detail IS NULL OR e.detail != ?)
            AND e.body LIKE ?
        `
    );

    for (const prefix of CHAT_EXCLUDED_BODY_PREFIXES) {
      const skipped = (
        countSkippedByPrefix.get(DROPPED_MESSAGE_DETAIL, `${prefix}%`) as { count: number }
      ).count;
      console.log(
        `Skipped ${skipped} ${JSON.stringify(prefix)} message rows during legacy mesh_chat backfill.`
      );
    }

    db.prepare(
      `
      INSERT OR IGNORE INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id)
      SELECT 'bf:' || e.id, e.ts, e.peer_id, e.actor_id, e.body, e.detail
      FROM mesh_events e
      WHERE e.kind IN ('message_sent', 'message_received')
        AND e.body IS NOT NULL
        AND e.payload IS NULL
        AND (e.kind != 'message_sent' OR e.detail IS NULL OR e.detail != ?)
        ${excludedBodyPredicatesForEvents}
    `
    ).run(DROPPED_MESSAGE_DETAIL, ...excludedBodyLikeParams);

    db.prepare(
      `
      UPDATE mesh_events
      SET payload = json_object('messageId', 'bf:' || id)
      WHERE kind IN ('message_sent', 'message_received')
        AND body IS NOT NULL
        AND payload IS NULL
        AND (kind != 'message_sent' OR detail IS NULL OR detail != ?)
        ${excludedBodyPredicates}
    `
    ).run(DROPPED_MESSAGE_DETAIL, ...excludedBodyLikeParams);
  },
};

function notLikePrefixPredicates(column: string): string {
  return CHAT_EXCLUDED_BODY_PREFIXES.map(() => `AND ${column} NOT LIKE ?`).join("\n        ");
}
