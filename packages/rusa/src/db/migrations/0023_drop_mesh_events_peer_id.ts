import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Drop misleading `peer_id` column from `mesh_events` .
 *
 * `mesh_events.peer_id` was the second field in the legacy `message_sent` convention
 * (`actor_id` = recipient, `peer_id` = sender) — a convention the ISSUE_NUM spine
 * replaced with `actor_id` = author + direction in `payload.to/from`. Event-class-specific
 * fields belong in JSON `payload`, not as sparse top-level columns.
 */
export const dropMeshEventsPeerId: Migration = {
  id: "0023_drop_mesh_events_peer_id",
  up: (db: Database) => {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(mesh_events)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    );

    if (columns.has("peer_id")) {
      // Backfill historical counterparties into `payload` before dropping the column
      // to avoid permanent data loss for older events.
      db.exec(`
        UPDATE mesh_events 
        SET payload = json_object('parentId', peer_id)
        WHERE peer_id IS NOT NULL AND payload IS NULL 
          AND kind IN ('thread_spawned', 'thread_revived');
          
        UPDATE mesh_events 
        SET payload = json_object('toParentId', peer_id)
        WHERE peer_id IS NOT NULL AND payload IS NULL 
          AND kind = 'thread_reparented';
        
        UPDATE mesh_events 
        SET payload = json_object('handleId', peer_id)
        WHERE peer_id IS NOT NULL AND payload IS NULL 
          AND kind = 'handle_granted';
        
        UPDATE mesh_events 
        SET payload = json_object('grantedBy', peer_id)
        WHERE peer_id IS NOT NULL AND payload IS NULL 
          AND kind IN ('capability_granted', 'capability_revoked');
          
        UPDATE mesh_events 
        SET payload = json_object('from', peer_id)
        WHERE peer_id IS NOT NULL AND payload IS NULL 
          AND kind = 'message_sent';
      `);

      db.exec("ALTER TABLE mesh_events DROP COLUMN peer_id");
    }
  },
};
