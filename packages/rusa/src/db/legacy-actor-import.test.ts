import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScheduledMessage, ScheduledMessageScheduler } from "../actor/os-scheduler.js";
import { importLegacyActorState } from "./legacy-actor-import.js";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";

describe("legacy actor import", () => {
  let home: string;
  let db: Database.Database;
  let repositories: Repositories;
  let scheduled: Map<string, ScheduledMessage>;
  let scheduledMessages: ScheduledMessageScheduler;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "legacy-actor-import-"));
    mkdirSync(join(home, "root-agent"), { recursive: true });
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    repositories = new Repositories(db);
    scheduled = new Map();
    scheduledMessages = {
      scheduleMessageDelivery: (message) => scheduled.set(message.id, structuredClone(message)),
      cancelMessageDelivery: (id) => {
        scheduled.delete(id);
      },
      listMessageDeliveries: () => [...scheduled.values()].map((message) => ({ ...message })),
    };
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function writeLegacy(charter = "root charter", provider = "codex", model = "gpt-5.6-sol"): void {
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify({
        threads: [
          {
            id: "root",
            charter,
            parentId: null,
            handles: [{ id: "worker", role: "reviewer" }],
            provider,
            model,
            sessionId: "stale-thread-session",
            status: "active",
            humanUnlocked: true,
            desiredModel: "discard-me",
            createdAt: "2026-09-01T00:00:00.000Z",
          },
          {
            id: "worker",
            charter: "review code",
            parentId: "root",
            status: "active",
            pendingDeliveries: [
              {
                id: "scheduled-1",
                fromId: "root",
                body: "check back later",
                deliverAt: "2026-09-05T00:00:00.000Z",
                sessionId: "chat-session",
              },
            ],
            createdAt: "2026-09-01T00:00:01.000Z",
          },
        ],
      })
    );
    writeFileSync(
      join(home, "root-agent", "session.json"),
      JSON.stringify({ sessionId: "root-session" })
    );
  }

  const importState = () =>
    importLegacyActorState({ mcHome: home, db, repositories, scheduledMessages });

  it("does nothing on a fresh install and does not recreate the retired file", () => {
    expect(importState()).toEqual({
      importedActors: 0,
      importedScheduledMessages: 0,
      backupFiles: [],
    });
    expect(existsSync(join(home, "threads.json"))).toBe(false);
  });

  it("defers a session-only install until startup creates the first root", () => {
    const sessionPath = join(home, "root-agent", "session.json");
    writeFileSync(sessionPath, JSON.stringify({ sessionId: "root-session" }));

    const result = importState();

    expect(result).toMatchObject({
      importedActors: 0,
      importedScheduledMessages: 0,
      deferredRootSessionId: "root-session",
    });
    expect(result.backupFiles).toEqual([]);
    expect(existsSync(sessionPath)).toBe(true);
  });

  it("imports and archives the legacy sources", () => {
    writeLegacy();
    const result = importState();

    expect(result).toMatchObject({ importedActors: 2, importedScheduledMessages: 1 });
    expect(result.backupFiles).toHaveLength(2);
    expect(result.backupFiles.every(existsSync)).toBe(true);
    expect(existsSync(join(home, "threads.json"))).toBe(false);
    expect(existsSync(join(home, "root-agent", "session.json"))).toBe(false);
    expect(repositories.actors.get("root")).toMatchObject({
      sessionId: "root-session",
      handles: [{ id: "worker", role: "reviewer" }],
    });
    expect(repositories.actors.get("root")).not.toHaveProperty("desiredModel");
    expect(repositories.actors.get("root")).not.toHaveProperty("humanUnlocked");
    expect(scheduled.get("scheduled-1")).toMatchObject({
      toId: "worker",
      body: "check back later",
    });
    expect(repositories.meshChat.getById("scheduled-1")?.body).toBe("check back later");
    expect(repositories.meshEvents.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "scheduled-1:sent", kind: "message_sent" }),
      ])
    );
  });

  it("normalizes legacy model effort qualifiers during import", () => {
    writeLegacy("root charter", "antigravity", "gemini-3.7-flash-high");

    importLegacyActorState({
      mcHome: home,
      db,
      repositories,
      scheduledMessages,
      providerCapabilityName: (provider) => (provider === "antigravity" ? "agy" : provider),
    });

    expect(repositories.actors.get("root")).toMatchObject({
      model: "gemini-3.7-flash",
      effort: "high",
    });
  });

  it("archives a matching source left behind after the database commit", () => {
    writeLegacy();
    const first = importState();
    copyFileSync(first.backupFiles[0], join(home, "threads.json"));
    copyFileSync(first.backupFiles[1], join(home, "root-agent", "session.json"));

    const retry = importState();

    expect(retry.importedActors).toBe(0);
    expect(retry.importedScheduledMessages).toBe(1);
    expect(existsSync(join(home, "threads.json"))).toBe(false);
  });

  it("retains the source and converges after host scheduling fails following the actor commit", () => {
    writeLegacy();
    scheduledMessages = {
      scheduleMessageDelivery: () => {
        throw new Error("at submission failed");
      },
      cancelMessageDelivery: () => {},
      listMessageDeliveries: () => [],
    };

    expect(() => importState()).toThrow("at submission failed");
    expect(repositories.actors.list()).toHaveLength(2);
    expect(repositories.meshChat.getById("scheduled-1")?.body).toBe("check back later");
    expect(existsSync(join(home, "threads.json"))).toBe(true);

    scheduledMessages = {
      scheduleMessageDelivery: (message) => scheduled.set(message.id, structuredClone(message)),
      cancelMessageDelivery: (id) => {
        scheduled.delete(id);
      },
      listMessageDeliveries: () => [...scheduled.values()],
    };
    const retry = importState();

    expect(retry).toMatchObject({ importedActors: 0, importedScheduledMessages: 1 });
    expect(scheduled.get("scheduled-1")?.toId).toBe("worker");
    expect(existsSync(join(home, "threads.json"))).toBe(false);
  });

  it("fails loudly instead of overwriting SQLite when a leftover file diverges", () => {
    writeLegacy();
    importState();
    writeLegacy("different charter");

    expect(() => importState()).toThrow("threads.json diverges from SQLite");
    expect(repositories.actors.get("root")?.charter).toBe("root charter");
  });

  it("accepts a legacy createdAt with an explicit ISO-8601 UTC offset and normalizes it to trailing-Z", () => {
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify({
        threads: [
          {
            id: "root",
            charter: "root charter",
            parentId: null,
            status: "active",
            createdAt: "2026-01-02T03:04:05.123456+00:00",
            pendingDeliveries: [
              {
                id: "scheduled-offset",
                fromId: "root",
                body: "check back later",
                deliverAt: "2026-01-03T03:04:05.123456+00:00",
              },
            ],
          },
        ],
      })
    );
    writeFileSync(
      join(home, "root-agent", "session.json"),
      JSON.stringify({ sessionId: "root-session" })
    );

    const result = importState();

    expect(result.importedActors).toBe(1);
    expect(repositories.actors.get("root")?.createdAt).toBe("2026-01-02T03:04:05.123Z");
    expect(scheduled.get("scheduled-offset")?.deliverAt).toBe("2026-01-03T03:04:05.123Z");
  });

  it("validates the complete graph before writing any rows", () => {
    writeFileSync(
      join(home, "threads.json"),
      JSON.stringify({
        threads: [
          {
            id: "worker",
            charter: "orphan",
            parentId: "missing",
            status: "active",
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      })
    );

    expect(() => importState()).toThrow();
    expect(repositories.actors.list()).toEqual([]);
  });
});
