import { Cupid, HLC, type LocalStore } from "@thkp-eng/goals-core";
import type { AnyOp, WireOp } from "@thkp-eng/goals-types";
import { compressOp, expandOp } from "@thkp-eng/goals-types";
import { getDb } from "../db/index.js";

export class SqliteLocalStore implements LocalStore {
  public clientId: string = "";
  public cursor: string | null = null;

  async init(): Promise<void> {
    const db = getDb();

    // Load or generate clientId
    const clientIdRow = db
      .prepare("SELECT value FROM understanding_sync_metadata WHERE key = 'client_id'")
      .get() as { value: string | null } | undefined;
    if (clientIdRow?.value) {
      this.clientId = clientIdRow.value;
    } else {
      this.clientId = Cupid.random().encode();
      db.prepare(
        "INSERT OR REPLACE INTO understanding_sync_metadata (key, value) VALUES ('client_id', ?)"
      ).run(this.clientId);
    }

    // Load cursor
    const cursorRow = db
      .prepare("SELECT value FROM understanding_sync_metadata WHERE key = 'cursor'")
      .get() as { value: string | null } | undefined;
    this.cursor = cursorRow?.value || null;
  }

  getUnsyncedOps(): AnyOp[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT data FROM understanding_sync_ops WHERE synced = 0 ORDER BY hlc ASC")
      .all() as { data: string }[];
    return rows.map((r) => expandOp(JSON.parse(r.data) as WireOp));
  }

  async setUnsyncedOps(ops: AnyOp[]): Promise<void> {
    const db = getDb();
    const insert = db.prepare(
      "INSERT OR REPLACE INTO understanding_sync_ops (id, hlc, version, type, data, synced) VALUES (?, ?, ?, ?, ?, 0)"
    );

    db.transaction(() => {
      for (const op of ops) {
        const wireOp = compressOp(op);
        insert.run(op.id, op.hlcTimestamp, op.version, op.type, JSON.stringify(wireOp));
      }
    })();
  }

  async storeSyncedOps(ops: AnyOp[]): Promise<void> {
    const db = getDb();
    const insert = db.prepare(
      "INSERT OR REPLACE INTO understanding_sync_ops (id, hlc, version, type, data, synced) VALUES (?, ?, ?, ?, ?, 1)"
    );

    db.transaction(() => {
      for (const op of ops) {
        const wireOp = compressOp(op);
        insert.run(op.id, op.hlcTimestamp, op.version, op.type, JSON.stringify(wireOp));
        if (this.cursor === null || HLC.unpack(op.hlcTimestamp).comesAfter(this.cursor)) {
          this.cursor = op.hlcTimestamp;
        }
      }
      if (this.cursor) {
        db.prepare(
          "INSERT OR REPLACE INTO understanding_sync_metadata (key, value) VALUES ('cursor', ?)"
        ).run(this.cursor);
      }
    })();
  }

  async getAllOps(): Promise<AnyOp[]> {
    const db = getDb();
    const rows = db.prepare("SELECT data FROM understanding_sync_ops ORDER BY hlc ASC").all() as {
      data: string;
    }[];
    return rows.map((r) => expandOp(JSON.parse(r.data) as WireOp));
  }
}
