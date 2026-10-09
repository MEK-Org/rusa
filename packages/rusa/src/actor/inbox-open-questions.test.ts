import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { Repositories } from "../db/repositories/index.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import { VOICE_INBOX_PAYLOAD_TYPE } from "../runtime/run-manager.js";
import {
  attachOpenQuestions,
  type InboxOpenQuestionSources,
  resolveInboxSenderPrincipal,
} from "./inbox-open-questions.js";

const AT = "2026-10-04T00:00:00.000Z";

function humanMessage(id: string, fromId: string, messageId = `msg-${id}`): InboxEntry {
  return {
    id,
    actorId: "asker",
    source: `mesh:${fromId}`,
    payload: { type: "mesh.message", messageId, fromId, sessionId: null },
    deliveredAt: new Date(AT),
    seenAt: null,
    handledAt: null,
    handledNote: null,
  };
}

// Synthetic Google account ids; never a real person's.
const ALICE_GOOGLE_ID = "100000000000000000001";
const BOB_GOOGLE_ID = "100000000000000000002";

function chatMessage(id: string, senderName: unknown, message = "M"): InboxEntry {
  return {
    id,
    actorId: "asker",
    source: "gchat:spaces/S",
    payload: {
      type: "gchat.message",
      messageName: `spaces/S/messages/${message}`,
      spaceName: "spaces/S",
      senderName,
      priority: "responsive",
    },
    deliveredAt: new Date(AT),
    seenAt: null,
    handledAt: null,
    handledNote: null,
  };
}

describe("attachOpenQuestions", () => {
  let db: Database.Database;
  let repos: Repositories;
  let sources: InboxOpenQuestionSources;
  let alice: string;
  let bob: string;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    const insertActor = db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'c', ?, ?)"
    );
    insertActor.run("asker", null, AT);
    insertActor.run("other-actor", "asker", AT);
    repos = new Repositories(db);
    alice = repos.principals.createUser({ email: "alice@example.test", createdAt: AT }).id;
    bob = repos.principals.createUser({ email: "bob@example.test", createdAt: AT }).id;
    sources = {
      resolveSenderPrincipal: (entry) => resolveInboxSenderPrincipal(entry, repos.principals),
      listOpenQuestions: (ownerId, creatorId, limit) =>
        repos.obligations.listOwnedPage(ownerId, { creatorId, openOnly: true, limit }),
      listArtifacts: (obligationId) => repos.obligations.listArtifacts(obligationId),
    };
  });

  const ask = (id: string, ownerId: string, creatorId = "asker") =>
    repos.obligations.create({ id, ownerId, creatorId, title: `Question ${id}` });

  it("lists only open questions the receiving actor filed for the authenticated sender", () => {
    ask("mine", alice);
    ask("other-creator", alice, "other-actor");
    ask("other-owner", bob);
    ask("done", alice);
    ask("cancelled", alice);
    repos.obligations.setTerminalStatus("done", "done", "answered", null, "asker");
    repos.obligations.setTerminalStatus("cancelled", "cancelled", "moot", null, "asker");

    const [entry] = attachOpenQuestions([humanMessage("e1", alice, "m-1")], "asker", sources);

    expect(entry.openQuestions).toEqual({
      principalId: alice,
      resolutionRef: "mesh:messages/m-1",
      reminder: expect.stringContaining('resolution_ref "mesh:messages/m-1"'),
      questions: [{ id: "mine", title: "Question mine" }],
      total: 1,
      truncated: false,
    });
  });

  it("names the earliest attached message as the ask", () => {
    ask("q", alice);
    let clock = Date.parse(AT);
    const stepping = new ObligationRepository(db, undefined, () => (clock += 1000));
    stepping.attachArtifact("q", "github:MEK-Org/rusa/issues/1");
    stepping.attachArtifact("q", "gchat:spaces/S/messages/M");
    stepping.attachArtifact("q", "mesh:messages/later");

    const [entry] = attachOpenQuestions([humanMessage("e1", alice)], "asker", sources);

    expect(entry.openQuestions).toMatchObject({
      questions: [{ id: "q", askRef: "gchat:spaces/S/messages/M" }],
    });
  });

  it("resolves a voice message sender the same way", () => {
    ask("q", alice);
    const voice = humanMessage("v1", alice);
    voice.payload = { ...voice.payload, type: VOICE_INBOX_PAYLOAD_TYPE };

    const [entry] = attachOpenQuestions([voice], "asker", sources);

    expect(entry.openQuestions).toMatchObject({ principalId: alice, total: 1 });
  });

  it("leaves unmatched senders without questions", () => {
    ask("q", alice);
    ask("bobs", bob);
    repos.principals.setDisabled(bob, AT);
    const disabledUser = humanMessage("disabled", bob);
    const legacyOperator = humanMessage("legacy", "00000000-0000-4000-8000-000000000001");
    const unknownUser = humanMessage("unknown", "00000000-0000-4000-8000-000000000000");
    const actorSent: InboxEntry = {
      ...humanMessage("actor", "other-actor"),
      payload: { type: "mesh.message", messageId: "m", fromId: "other-actor" },
    };
    const spoofedSource: InboxEntry = {
      ...humanMessage("spoof", alice),
      source: "mesh:other-actor",
    };
    const gchat: InboxEntry = {
      ...humanMessage("chat", alice),
      source: "gchat:spaces/S",
      payload: {
        type: "gchat.message",
        messageName: "spaces/S/messages/M",
        spaceName: "spaces/S",
        senderName: "users/123",
      },
    };

    const result = attachOpenQuestions(
      [legacyOperator, unknownUser, disabledUser, actorSent, spoofedSource, gchat],
      "asker",
      sources
    );

    for (const entry of result) {
      expect(entry).not.toHaveProperty("openQuestions");
      expect(entry).not.toHaveProperty("openQuestionsError");
    }
  });

  it("resolves a Google Chat sender through the Google account id recorded at sign-in", () => {
    ask("q", alice);
    ask("bobs", bob);
    repos.principals.setGoogleAccountId(alice, ALICE_GOOGLE_ID);

    const [entry] = attachOpenQuestions(
      [chatMessage("c1", `users/${ALICE_GOOGLE_ID}`, "M1")],
      "asker",
      sources
    );

    expect(entry.openQuestions).toEqual({
      principalId: alice,
      resolutionRef: "gchat:spaces/S/messages/M1",
      reminder: expect.stringContaining('resolution_ref "gchat:spaces/S/messages/M1"'),
      questions: [{ id: "q", title: "Question q" }],
      total: 1,
      truncated: false,
    });
  });

  it("leaves Chat senders unmatched without a recorded, enabled Google account id", () => {
    ask("q", alice);
    ask("bobs", bob);
    repos.principals.setGoogleAccountId(bob, BOB_GOOGLE_ID);
    repos.principals.setDisabled(bob, AT);

    const result = attachOpenQuestions(
      [
        // Alice has open questions but has not signed in since the column appeared.
        chatMessage("unrecorded", `users/${ALICE_GOOGLE_ID}`),
        chatMessage("disabled", `users/${BOB_GOOGLE_ID}`),
        chatMessage("bare-id", BOB_GOOGLE_ID),
        chatMessage("nested", `users/${BOB_GOOGLE_ID}/extra`),
        chatMessage("missing", undefined),
        { ...chatMessage("not-chat", `users/${BOB_GOOGLE_ID}`), source: `mesh:${bob}` },
      ],
      "asker",
      sources
    );

    for (const entry of result) {
      expect(entry).not.toHaveProperty("openQuestions");
      expect(entry).not.toHaveProperty("openQuestionsError");
    }
  });

  it("omits the list when the sender has nothing open", () => {
    const [entry] = attachOpenQuestions([humanMessage("e1", alice)], "asker", sources);
    expect(entry).not.toHaveProperty("openQuestions");
  });

  it("bounds the list and reports the true total", () => {
    for (const id of ["a", "b", "c"]) ask(id, alice);

    const [entry] = attachOpenQuestions([humanMessage("e1", alice)], "asker", sources, 2);

    expect(entry.openQuestions).toMatchObject({ total: 3, truncated: true });
    expect(entry.openQuestions && "questions" in entry.openQuestions).toBe(true);
    if (entry.openQuestions && "questions" in entry.openQuestions) {
      expect(entry.openQuestions.questions).toHaveLength(2);
    }
  });

  it("lists once per sender and gives each later message its own resolution ref", () => {
    ask("q", alice);

    const [first, second] = attachOpenQuestions(
      [humanMessage("e1", alice, "m-1"), humanMessage("e2", alice, "m-2")],
      "asker",
      sources
    );

    expect(first.openQuestions).toMatchObject({ resolutionRef: "mesh:messages/m-1", total: 1 });
    expect(second.openQuestions).toEqual({
      principalId: alice,
      resolutionRef: "mesh:messages/m-2",
      reminder: expect.stringContaining('resolution_ref "mesh:messages/m-2"'),
      sameAsEntryId: "e1",
    });
  });

  it("reports a failed read on the entry without failing the selection", () => {
    ask("q", alice);
    const failing: InboxOpenQuestionSources = {
      ...sources,
      listOpenQuestions: () => {
        throw new Error("database is locked");
      },
    };

    const result = attachOpenQuestions(
      [humanMessage("e1", alice), humanMessage("e2", "00000000-0000-4000-8000-000000000001")],
      "asker",
      failing
    );

    expect(result[0]).toMatchObject({ id: "e1", openQuestionsError: "database is locked" });
    expect(result[1]).not.toHaveProperty("openQuestionsError");

    // A later message from the same sender never points at a list that failed.
    const failingArtifacts: InboxOpenQuestionSources = {
      ...sources,
      listArtifacts: () => {
        throw new Error("database is locked");
      },
    };
    const sameSender = attachOpenQuestions(
      [humanMessage("e3", alice), humanMessage("e4", alice)],
      "asker",
      failingArtifacts
    );
    for (const entry of sameSender) {
      expect(entry).toMatchObject({ openQuestionsError: "database is locked" });
      expect(entry).not.toHaveProperty("openQuestions");
    }
  });
});
