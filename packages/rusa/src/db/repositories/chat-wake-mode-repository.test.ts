import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { DbChatWakeModeStore } from "./chat-wake-mode-repository.js";
import { DbEventSourceOwnerStore } from "./event-source-owner-repository.js";

function makeStore() {
  const db = new Database(":memory:");
  runMigrations(db);
  db.pragma("foreign_keys = ON");
  db.prepare(
    "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'root', NULL, '2026-09-26T00:00:00Z')"
  ).run("root");
  db.prepare(
    "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'child', 'root', '2026-09-26T00:00:00Z')"
  ).run("child");
  return { db, store: new DbChatWakeModeStore(db), owners: new DbEventSourceOwnerStore(db) };
}

describe("DbChatWakeModeStore (#692)", () => {
  it("starts empty, so every existing space keeps its default", () => {
    const { store } = makeStore();
    expect(store.get("gchat:spaces/A")).toBeUndefined();
  });

  it("stores a versioned mode in the active event-source row and clears it back to the default", () => {
    const { db, store, owners } = makeStore();
    owners.subscribe({
      resource: "gchat:spaces/A",
      actorId: "root",
      subscribedBy: "root",
      subscribedAt: "2026-09-26T00:00:00Z",
    });
    owners.subscribe({
      resource: "gchat:spaces/B",
      actorId: "root",
      subscribedBy: "root",
      subscribedAt: "2026-09-26T00:00:00Z",
    });
    store.set({ resource: "gchat:spaces/A", mode: "all" });
    store.set({ resource: "gchat:spaces/B", mode: "mentions" });
    store.set({ resource: "gchat:spaces/A", mode: "mentions" });
    expect(store.get("gchat:spaces/A")).toEqual({
      resource: "gchat:spaces/A",
      mode: "mentions",
    });
    expect(store.get("gchat:spaces/B")?.mode).toBe("mentions");
    store.clear("gchat:spaces/A");
    expect(store.get("gchat:spaces/A")).toBeUndefined();
    expect(store.get("gchat:spaces/B")?.mode).toBe("mentions");
    expect(
      db
        .prepare("SELECT config FROM event_source_owners WHERE resource = ? AND actor_id = ?")
        .get("gchat:spaces/A", "root")
    ).toEqual({ config: null });
  });

  it("carries the event-source config to a delegated owner", () => {
    const { store, owners } = makeStore();
    owners.subscribe({
      resource: "gchat:spaces/A",
      actorId: "root",
      subscribedBy: "root",
      subscribedAt: "2026-09-26T00:00:00Z",
    });
    store.set({ resource: "gchat:spaces/A", mode: "all" });

    owners.unsubscribe("gchat:spaces/A", "root", "2026-09-26T00:01:00Z");
    owners.subscribe({
      resource: "gchat:spaces/A",
      actorId: "child",
      subscribedBy: "root",
      subscribedAt: "2026-09-26T00:01:00Z",
    });

    expect(store.get("gchat:spaces/A")).toEqual({ resource: "gchat:spaces/A", mode: "all" });
  });

  it("fails closed for malformed, wrong-version, or invalid event-source config", () => {
    const { db, store, owners } = makeStore();
    owners.subscribe({
      resource: "gchat:spaces/A",
      actorId: "root",
      subscribedBy: "root",
      subscribedAt: "2026-09-26T00:00:00Z",
    });
    const setConfig = db.prepare(
      "UPDATE event_source_owners SET config = ? WHERE resource = ? AND actor_id = ?"
    );
    for (const config of [
      "not json",
      '{"version":2,"chatWakeMode":"all"}',
      '{"version":1,"chatWakeMode":"everything"}',
    ]) {
      setConfig.run(config, "gchat:spaces/A", "root");
      expect(store.get("gchat:spaces/A")).toBeUndefined();
    }
  });

  it("refuses to write a setting without an active exact event source", () => {
    const { store } = makeStore();
    expect(() => store.set({ resource: "gchat:spaces/A", mode: "all" })).toThrow(
      /active event-source owner/
    );
  });
});
