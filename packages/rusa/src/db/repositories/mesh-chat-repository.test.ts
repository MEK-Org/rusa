import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MeshChatRepository } from "./mesh-chat-repository.js";

describe("MeshChatRepository.listForActor", () => {
  it("lists only the actor's messages and can narrow them to one peer", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mesh_chat (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        body TEXT NOT NULL,
        session_id TEXT
      )
    `);
    const repo = new MeshChatRepository(db);
    repo.record({
      id: "older",
      ts: "2026-07-26T00:00:00Z",
      senderId: "root",
      recipientId: "worker",
      body: "start",
    });
    repo.record({
      id: "newer",
      ts: "2026-07-26T00:01:00Z",
      senderId: "worker",
      recipientId: "root",
      body: "done",
    });
    repo.record({
      id: "foreign",
      ts: "2026-07-26T00:02:00Z",
      senderId: "other-a",
      recipientId: "other-b",
      body: "private",
    });

    expect(repo.listForActor("worker").map((message) => message.id)).toEqual(["newer", "older"]);
    expect(repo.listForActor("worker", { peerId: "root" }).map((message) => message.id)).toEqual([
      "newer",
      "older",
    ]);
    expect(repo.listForActor("worker", { peerId: "other-a" })).toEqual([]);
  });
});

describe("MeshChatRepository.listChatByActors", () => {
  it("excludes self-directed messages from an actor conversation", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE mesh_chat (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        body TEXT NOT NULL,
        session_id TEXT
      )
    `);
    const repo = new MeshChatRepository(db);
    repo.record({ id: "root-to-worker", senderId: "root", recipientId: "worker", body: "go" });
    repo.record({ id: "root-self", senderId: "root", recipientId: "root", body: "wake" });
    repo.record({ id: "worker-self", senderId: "worker", recipientId: "worker", body: "later" });
    repo.record({ id: "worker-to-root", senderId: "worker", recipientId: "root", body: "done" });

    const page = repo.listChatByActors(["root", "worker"], { limit: 10 });

    expect(page.chat.map((message) => message.id)).toEqual(["worker-to-root", "root-to-worker"]);
    expect(page.nextCursor).toBeNull();
  });
});
