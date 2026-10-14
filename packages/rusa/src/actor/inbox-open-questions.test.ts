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

// Synthetic Slack ids; not a real workspace, channel or user.
const HOME = "T0HOME";
const OTHER = "T0OTHER";
const ALICE_SLACK = "U0ALICE";
const BOB_SLACK = "U0BOB";
const SLACK_TS = "1720000000.000001";

function slackMessage(
  id: string,
  senderName: unknown,
  // null omits the field, as ingress does when it cannot prove the workspace.
  workspaceId: unknown = HOME,
  ts = SLACK_TS,
  actorId = "asker"
): InboxEntry {
  return {
    id,
    actorId,
    source: "slack:channels/C1",
    payload: {
      type: "slack.message",
      messageRef: `slack:channels/C1/messages/${ts}`,
      channel: "C1",
      ts,
      senderName,
      ...(workspaceId === null ? {} : { workspaceId }),
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
  let operator: string;
  let activeWorkspace: string | undefined;

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
    operator = repos.principals.createUser({ email: "operator@example.test", createdAt: AT }).id;
    activeWorkspace = HOME;
    sources = {
      resolveSenderPrincipal: (entry) =>
        resolveInboxSenderPrincipal(entry, repos.principals, {
          activeWorkspaceId: () => activeWorkspace,
          activePrincipalId: (workspaceId, slackUserId) =>
            repos.slackPrincipalBindings.activePrincipalId(workspaceId, slackUserId),
        }),
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

  const bindSlack = (principalId: string, slackUserId: string, workspaceId = HOME) =>
    repos.slackPrincipalBindings.grant({
      workspaceId,
      slackUserId,
      principalId,
      operatorId: operator,
      decisionRef: "mesh:messages/decision",
      at: AT,
    });
  const unbindSlack = (slackUserId: string, workspaceId = HOME) =>
    repos.slackPrincipalBindings.revoke({
      workspaceId,
      slackUserId,
      operatorId: operator,
      decisionRef: "mesh:messages/revoked",
      at: AT,
    });
  const resolved = (entries: InboxEntry[], actorId = "asker") =>
    attachOpenQuestions(entries, actorId, sources).map((entry) =>
      entry.openQuestions === undefined ? undefined : entry.openQuestions.principalId
    );

  it("resolves a Slack sender through an operator's binding of the exact workspace and user (#1038)", () => {
    ask("q", alice);
    ask("bobs", bob);
    bindSlack(alice, ALICE_SLACK);

    const [entry] = attachOpenQuestions([slackMessage("s1", ALICE_SLACK)], "asker", sources);

    expect(entry.openQuestions).toEqual({
      principalId: alice,
      resolutionRef: `slack:channels/C1/messages/${SLACK_TS}`,
      reminder: expect.stringContaining(`resolution_ref "slack:channels/C1/messages/${SLACK_TS}"`),
      questions: [{ id: "q", title: "Question q" }],
      total: 1,
      truncated: false,
    });
  });

  // Each case breaks one condition on a message that would otherwise resolve;
  // the resolving message is the test above.
  it.each<[string, () => InboxEntry]>([
    [
      "the same Slack user id in a workspace no operator bound",
      () => slackMessage("other-workspace", ALICE_SLACK, OTHER),
    ],
    [
      "ingress could not prove the workspace (shared channel, Grid, mismatch)",
      () => slackMessage("no-workspace", ALICE_SLACK, null),
    ],
    ["a workspace that is not a Slack id", () => slackMessage("bad-workspace", ALICE_SLACK, 42)],
    ["a sender no operator bound", () => slackMessage("unbound", "U0NOBODY")],
    ["a sender bound to a disabled user", () => slackMessage("disabled", BOB_SLACK)],
    ["a display name as sender", () => slackMessage("display-name", "Alice Example")],
    ["an email as sender", () => slackMessage("email", "alice@example.test")],
    ["a principal id as sender", () => slackMessage("principal-id", alice)],
    ["no sender", () => slackMessage("missing-sender", undefined)],
    ["a timestamp that is not Slack's", () => slackMessage("bad-ts", ALICE_SLACK, HOME, "now")],
    [
      "a message ref naming another message",
      () => {
        const entry = slackMessage("spoofed-ref", ALICE_SLACK);
        entry.payload = { ...entry.payload, messageRef: "slack:channels/C2/messages/1.2" };
        return entry;
      },
    ],
    [
      "a source naming another channel",
      () => ({ ...slackMessage("spoofed-source", ALICE_SLACK), source: "slack:channels/C2" }),
    ],
    [
      "a payload that is not a Slack message",
      () => ({
        ...slackMessage("not-slack", ALICE_SLACK),
        payload: { ...slackMessage("x", ALICE_SLACK).payload, type: "gchat.message" },
      }),
    ],
  ])("leaves a Slack sender unmatched: %s (#1038)", (_name, entry) => {
    ask("q", alice);
    ask("bobs", bob);
    bindSlack(alice, ALICE_SLACK);
    bindSlack(bob, BOB_SLACK);
    repos.principals.setDisabled(bob, AT);
    expect(resolved([entry()])).toEqual([undefined]);
  });

  it("re-reads a Slack binding at every selection (#1038)", () => {
    ask("q", alice);
    bindSlack(alice, ALICE_SLACK);
    // Delivered while bound, selected after the operator revoked it.
    const delivered = slackMessage("s1", ALICE_SLACK);
    unbindSlack(ALICE_SLACK);
    expect(resolved([delivered])).toEqual([undefined]);

    bindSlack(alice, ALICE_SLACK);
    expect(resolved([delivered])).toEqual([alice]);

    repos.principals.setDisabled(alice, AT);
    expect(resolved([delivered])).toEqual([undefined]);
    repos.principals.setDisabled(alice, null);
    expect(resolved([delivered])).toEqual([alice]);
  });

  it("keeps Slack bindings across a same-workspace reconnect and never across a changed one (#1038)", () => {
    ask("q", alice);
    bindSlack(alice, ALICE_SLACK);
    const delivered = slackMessage("s1", ALICE_SLACK);

    // Reconnect: unknown until auth.test answers, then the same workspace again.
    activeWorkspace = undefined;
    expect(resolved([delivered])).toEqual([undefined]);
    activeWorkspace = HOME;
    expect(resolved([delivered])).toEqual([alice]);

    // The install moves to another workspace: rows from either side stay unmatched
    // until an operator binds identities in the new workspace.
    activeWorkspace = OTHER;
    expect(resolved([delivered, slackMessage("s2", ALICE_SLACK, OTHER)])).toEqual([
      undefined,
      undefined,
    ]);
    bindSlack(alice, ALICE_SLACK, OTHER);
    expect(resolved([delivered, slackMessage("s2", ALICE_SLACK, OTHER)])).toEqual([
      undefined,
      alice,
    ]);
  });

  it("contains Slack resolution to the bound human and the receiving actor's own questions (#1038)", () => {
    ask("alice-asker", alice);
    ask("bob-asker", bob);
    ask("alice-other", alice, "other-actor");
    ask("bob-other", bob, "other-actor");
    bindSlack(alice, ALICE_SLACK);
    bindSlack(bob, BOB_SLACK);
    const titles = (entries: InboxEntry[], actorId: string) =>
      attachOpenQuestions(entries, actorId, sources).map((entry) =>
        entry.openQuestions && "questions" in entry.openQuestions
          ? entry.openQuestions.questions.map((question) => question.id)
          : undefined
      );

    expect(
      titles(
        [
          slackMessage("a", ALICE_SLACK, HOME, "1720000000.000001"),
          slackMessage("b", BOB_SLACK, HOME, "1720000000.000002"),
        ],
        "asker"
      )
    ).toEqual([["alice-asker"], ["bob-asker"]]);
    expect(
      titles(
        [
          slackMessage("a", ALICE_SLACK, HOME, "1720000000.000001", "other-actor"),
          slackMessage("b", BOB_SLACK, HOME, "1720000000.000002", "other-actor"),
        ],
        "other-actor"
      )
    ).toEqual([["alice-other"], ["bob-other"]]);
  });

  it("leaves Slack senders unmatched when the host wires no binding source (#1038)", () => {
    ask("q", alice);
    bindSlack(alice, ALICE_SLACK);
    expect(resolveInboxSenderPrincipal(slackMessage("s1", ALICE_SLACK), repos.principals)).toBe(
      undefined
    );
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
