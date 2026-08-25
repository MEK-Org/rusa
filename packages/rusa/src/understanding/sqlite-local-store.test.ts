import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, initDb } from "../db/index";
import { SqliteLocalStore } from "./sqlite-local-store";

describe("SqliteLocalStore", () => {
  let store: SqliteLocalStore;
  let mcHome: string;

  beforeEach(() => {
    mcHome = join(tmpdir(), `rusa-test-${Math.random().toString(36).slice(2)}`);
    initDb(mcHome);
    store = new SqliteLocalStore();
  });

  afterEach(() => {
    closeDb();
    try {
      rmSync(mcHome, { recursive: true, force: true });
    } catch (_e) {
      // Ignored
    }
  });

  it("should initialize client ID and cursor", async () => {
    await store.init();
    expect(store.clientId).toBeDefined();
    expect(store.clientId.length).toBeGreaterThan(0);
    expect(store.cursor).toBeNull();
  });

  it("should persist and load unsynced ops", async () => {
    await store.init();
    const op = { hlcTimestamp: "H1", id: "I1", version: 1, type: "delta", delta: { id: "G1" } };
    await store.setUnsyncedOps([op]);

    const unsynced = store.getUnsyncedOps();
    expect(unsynced).toHaveLength(1);
    expect(unsynced[0].hlcTimestamp).toBe("H1");

    const newStore = new SqliteLocalStore();
    await newStore.init();
    expect(newStore.getUnsyncedOps()).toHaveLength(1);
  });

  it("should persist and load synced ops and update cursor", async () => {
    await store.init();
    const op = { hlcTimestamp: "H2", id: "I2", version: 1, type: "delta", delta: { id: "G2" } };
    await store.storeSyncedOps([op]);

    expect(store.cursor).toBe("H2");

    const all = await store.getAllOps();
    expect(all).toHaveLength(1);
    expect(all[0].hlcTimestamp).toBe("H2");

    const newStore = new SqliteLocalStore();
    await newStore.init();
    expect(newStore.cursor).toBe("H2");
  });
});
