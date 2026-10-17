import type { Database } from "better-sqlite3";
import type { Migration } from "./types.js";

/**
 * Stable local instance identity and boot identity (#1019).
 *
 * Each rusa instance (leader or follower) records its stable identity, role,
 * and current boot identity in its local mesh.db. The stable instance_id survives
 * process restart while boot_id is minted fresh on every boot.
 *
 * `role` is not configured directly: it is derived from config.yaml `peers`
 * (a `leader` entry makes the instance a follower, #1024) and recorded so a
 * database first booted as one role refuses to boot as the other.
 */
export const instanceIdentity: Migration = {
  id: "0061_instance_identity",
  up: (db: Database) => {
    db.exec(`
      CREATE TABLE instance_identity (
        singleton     INTEGER PRIMARY KEY NOT NULL DEFAULT 1 CHECK (singleton = 1),
        instance_id   TEXT NOT NULL CHECK (length(trim(instance_id)) > 0),
        role          TEXT NOT NULL CHECK (role IN ('leader', 'follower')),
        created_at    TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
        boot_id       TEXT NOT NULL CHECK (length(trim(boot_id)) > 0),
        updated_at    TEXT NOT NULL CHECK (length(trim(updated_at)) > 0)
      );
    `);
  },
};
