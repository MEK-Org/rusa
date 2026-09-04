import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ScheduledDelivery } from "../../actor/scheduled-delivery-store.js";
import { migrations } from "../migrations/index.js";
import { ScheduledMessageRepository } from "./scheduled-message-repository.js";

describe("ScheduledMessageRepository", () => {
  function setupDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(
      "CREATE TABLE _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    for (const migration of migrations) {
      if (migration.noTransaction) {
        migration.up(db);
      } else {
        db.transaction(() => {
          migration.up(db);
        })();
      }
      db.prepare("INSERT INTO _migrations (id) VALUES (?)").run(migration.id);
    }
    return db;
  }

  function delivery(overrides: Partial<ScheduledDelivery> = {}): ScheduledDelivery {
    return {
      id: "msg-1",
      toId: "actor:t2",
      fromId: "actor:t1",
      body: "hello later",
      deliverAt: "2026-09-05T00:00:00Z",
      ...overrides,
    };
  }

  it("inserts and gets a delivery, including an optional sessionId", () => {
    const db = setupDb();
    const repo = new ScheduledMessageRepository(db);

    repo.insert(delivery({ sessionId: "session-1" }));

    expect(repo.get("msg-1")).toEqual(delivery({ sessionId: "session-1" }));
  });

  it("omits sessionId from the result when it was never set", () => {
    const db = setupDb();
    const repo = new ScheduledMessageRepository(db);

    repo.insert(delivery());

    expect(repo.get("msg-1")).toEqual(delivery());
  });

  it("returns undefined for an unknown id", () => {
    const db = setupDb();
    const repo = new ScheduledMessageRepository(db);

    expect(repo.get("does-not-exist")).toBeUndefined();
  });

  it("insert is idempotent on id — a retry after a crash converges instead of duplicating", () => {
    const db = setupDb();
    const repo = new ScheduledMessageRepository(db);

    repo.insert(delivery({ body: "first write" }));
    // A retried scheduling attempt reusing the same stable id, e.g. after a
    // crash between the durable write and the OS-job arm, must not clobber
    // or duplicate the original row.
    repo.insert(delivery({ body: "retried write with different body" }));

    expect(repo.get("msg-1")?.body).toBe("first write");
    expect(repo.listAll()).toHaveLength(1);
  });

  it("removes a delivery by id", () => {
    const db = setupDb();
    const repo = new ScheduledMessageRepository(db);

    repo.insert(delivery());
    repo.remove("msg-1");

    expect(repo.get("msg-1")).toBeUndefined();
  });

  it("removing an unknown id is a no-op", () => {
    const db = setupDb();
    const repo = new ScheduledMessageRepository(db);

    expect(() => repo.remove("does-not-exist")).not.toThrow();
  });

  it("lists deliveries for a recipient ordered by deliver_at, excluding other recipients", () => {
    const db = setupDb();
    const repo = new ScheduledMessageRepository(db);

    repo.insert(delivery({ id: "a", toId: "actor:t2", deliverAt: "2026-09-05T02:00:00Z" }));
    repo.insert(delivery({ id: "b", toId: "actor:t2", deliverAt: "2026-09-05T01:00:00Z" }));
    repo.insert(delivery({ id: "c", toId: "actor:t3", deliverAt: "2026-09-05T00:30:00Z" }));

    const forT2 = repo.listForRecipient("actor:t2");
    expect(forT2.map((d) => d.id)).toEqual(["b", "a"]);
  });

  it("counts deliveries for a recipient", () => {
    const db = setupDb();
    const repo = new ScheduledMessageRepository(db);

    repo.insert(delivery({ id: "a", toId: "actor:t2" }));
    repo.insert(delivery({ id: "b", toId: "actor:t2" }));
    repo.insert(delivery({ id: "c", toId: "actor:t3" }));

    expect(repo.countForRecipient("actor:t2")).toBe(2);
    expect(repo.countForRecipient("actor:t3")).toBe(1);
    expect(repo.countForRecipient("actor:t4")).toBe(0);
  });

  it("lists all deliveries across recipients ordered by deliver_at", () => {
    const db = setupDb();
    const repo = new ScheduledMessageRepository(db);

    repo.insert(delivery({ id: "a", toId: "actor:t2", deliverAt: "2026-09-05T02:00:00Z" }));
    repo.insert(delivery({ id: "b", toId: "actor:t3", deliverAt: "2026-09-05T01:00:00Z" }));

    expect(repo.listAll().map((d) => d.id)).toEqual(["b", "a"]);
  });

  it("rolls back the insert when it is part of a transaction that later throws", () => {
    const db = setupDb();
    const repo = new ScheduledMessageRepository(db);

    expect(() =>
      db.transaction(() => {
        repo.insert(delivery());
        throw new Error("boom");
      })()
    ).toThrow("boom");

    expect(repo.get("msg-1")).toBeUndefined();
  });
});
