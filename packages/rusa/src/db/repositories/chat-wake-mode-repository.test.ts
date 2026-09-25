import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../migrations/runner.js";
import { DbChatWakeModeStore } from "./chat-wake-mode-repository.js";

function makeStore() {
  const db = new Database(":memory:");
  runMigrations(db);
  return { db, store: new DbChatWakeModeStore(db) };
}

describe("DbChatWakeModeStore (#692)", () => {
  it("starts empty, so every existing space keeps its default", () => {
    const { store } = makeStore();
    expect(store.get("gchat:spaces/A")).toBeUndefined();
  });

  it("upserts one row per space and clears it back to the default", () => {
    const { store } = makeStore();
    store.set({ resource: "gchat:spaces/A", mode: "all", setBy: "root", setAt: "t1" });
    store.set({ resource: "gchat:spaces/B", mode: "mentions", setBy: "w", setAt: "t1" });
    store.set({ resource: "gchat:spaces/A", mode: "mentions", setBy: "w", setAt: "t2" });
    expect(store.get("gchat:spaces/A")).toEqual({
      resource: "gchat:spaces/A",
      mode: "mentions",
      setBy: "w",
      setAt: "t2",
    });
    expect(store.get("gchat:spaces/B")?.mode).toBe("mentions");
    store.clear("gchat:spaces/A");
    expect(store.get("gchat:spaces/A")).toBeUndefined();
    expect(store.get("gchat:spaces/B")?.mode).toBe("mentions");
  });

  it("refuses a mode outside mentions/all at the table", () => {
    const { db } = makeStore();
    expect(() =>
      db
        .prepare(
          "INSERT INTO chat_space_wake_modes (resource, mode, set_by, set_at) VALUES (?, ?, ?, ?)"
        )
        .run("gchat:spaces/A", "everything", "root", "t")
    ).toThrow(/CHECK constraint/);
  });
});
