import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import type { UserPrincipal } from "../principals/principal-ref.js";
import {
  eventAudience,
  type HumanChatViewer,
  humanChatScope,
  messageEventParticipants,
} from "./human-chat-scope.js";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";

function user(name: string, disabled = false): UserPrincipal {
  return {
    kind: "user",
    id: `${name}-id`,
    createdAt: "2026-01-01T00:00:00.000Z",
    email: `${name}@example.test`,
    ...(disabled ? { disabledAt: "2026-01-02T00:00:00.000Z" } : {}),
  };
}

/** An unauthenticated request: the scope falls back to the sole active user. */
const anonymous = {} as IncomingMessage;

function message(
  kind: "message_sent" | "message_received",
  actorId: string | null,
  payload: string | null
) {
  return { kind, actorId, payload };
}

describe("messageEventParticipants", () => {
  it("reads the sender and recipient the way each message kind documents them", () => {
    expect(
      messageEventParticipants(message("message_sent", ACTOR, JSON.stringify({ to: PEER })))
    ).toEqual([ACTOR, PEER]);
    expect(
      messageEventParticipants(
        message("message_received", ACTOR, JSON.stringify({ messageId: "m", from: PEER }))
      )
    ).toEqual([ACTOR, PEER]);
  });

  it("is undefined for every non-message kind", () => {
    expect(messageEventParticipants({ kind: "run_start", actorId: ACTOR, payload: null })).toBe(
      undefined
    );
  });

  it("is null when a message event's ends cannot be read", () => {
    expect(
      messageEventParticipants(message("message_sent", null, JSON.stringify({ to: PEER })))
    ).toBe(null);
    expect(messageEventParticipants(message("message_sent", ACTOR, null))).toBe(null);
    expect(messageEventParticipants(message("message_sent", ACTOR, "{not json"))).toBe(null);
    expect(
      messageEventParticipants(message("message_sent", ACTOR, JSON.stringify({ to: 42 })))
    ).toBe(null);
    // The peer named for the other direction does not count.
    expect(
      messageEventParticipants(message("message_sent", ACTOR, JSON.stringify({ from: PEER })))
    ).toBe(null);
    expect(
      messageEventParticipants(
        message("message_received", ACTOR, JSON.stringify({ messageId: "m" }))
      )
    ).toBe(null);
  });
});

describe("humanChatScope", () => {
  it("reads as the sole active user and the legacy alias that still resolves to them", () => {
    const alice = user("alice");
    const scope = humanChatScope(anonymous, [alice]);
    expect([...scope.viewerIds].sort()).toEqual([alice.id, HUMAN_OPERATOR].sort());
    expect(scope.canSee(ACTOR, alice.id)).toBe(true);
    expect(scope.canSee(ACTOR, HUMAN_OPERATOR)).toBe(true);
    expect(scope.canSee(ACTOR, PEER)).toBe(true);
  });

  it("treats a disabled colleague as another human, not as an actor", () => {
    const alice = user("alice");
    const bob = user("bob", true);
    const scope = humanChatScope(anonymous, [alice, bob]);
    expect([...scope.viewerIds].sort()).toEqual([alice.id, HUMAN_OPERATOR].sort());
    expect(scope.canSee(ACTOR, bob.id)).toBe(false);
  });

  it("reads as the alias alone before any durable user exists", () => {
    const scope = humanChatScope(anonymous, []);
    expect([...scope.viewerIds]).toEqual([HUMAN_OPERATOR]);
    expect(scope.canSee(ACTOR, HUMAN_OPERATOR)).toBe(true);
  });

  it("identifies nobody, and so reads no human's side, among several unauthenticated users", () => {
    const scope = humanChatScope(anonymous, [user("alice"), user("bob")]);
    expect(scope.viewerIds.size).toBe(0);
    expect(scope.canSee(ACTOR, "alice-id")).toBe(false);
    expect(scope.canSee(ACTOR, HUMAN_OPERATOR)).toBe(false);
    expect(scope.canSee(ACTOR, PEER)).toBe(true);
  });
});

describe("eventAudience", () => {
  const alice = user("alice");
  const bob = user("bob");
  const viewerFor =
    (id: string): HumanChatViewer =>
    (users) => ({
      viewerIds: new Set([id]),
      canSee: (...participants) =>
        participants.every((p) => p === id || !users.some((u) => u.id === p)),
    });

  function counting(users: UserPrincipal[]) {
    let reads = 0;
    return {
      principals: {
        listUsers: () => {
          reads += 1;
          return users;
        },
      },
      reads: () => reads,
    };
  }

  it("admits every viewer to a non-message event without consulting principals", () => {
    const source = counting([alice, bob]);
    const admits = eventAudience(
      { kind: "run_start", actorId: ACTOR, payload: null },
      source.principals
    );
    expect(admits(viewerFor(alice.id))).toBe(true);
    expect(admits(viewerFor(bob.id))).toBe(true);
    expect(source.reads()).toBe(0);
  });

  it("withholds a message event whose ends cannot be read from every viewer", () => {
    const source = counting([alice, bob]);
    const admits = eventAudience(message("message_sent", ACTOR, "{not json"), source.principals);
    expect(admits(viewerFor(alice.id))).toBe(false);
    expect(admits(viewerFor(bob.id))).toBe(false);
    expect(source.reads()).toBe(0);
  });

  it("reads the user list once for a whole fan-out and decides per viewer", () => {
    const source = counting([alice, bob]);
    const admits = eventAudience(
      message("message_received", ACTOR, JSON.stringify({ messageId: "m", from: alice.id })),
      source.principals
    );
    expect(admits(viewerFor(alice.id))).toBe(true);
    expect(admits(viewerFor(bob.id))).toBe(false);
    expect(admits(viewerFor(alice.id))).toBe(true);
    expect(source.reads()).toBe(1);
  });

  it("reads the list fresh for the next event, so a newly admitted colleague counts", () => {
    const users: UserPrincipal[] = [alice];
    const principals = { listUsers: () => [...users] };
    const later = () =>
      eventAudience(
        message("message_received", ACTOR, JSON.stringify({ from: bob.id })),
        principals
      )((u) => humanChatScope(anonymous, u));
    // With alice the sole user, `bob-id` is not a known human and reads as an actor.
    expect(later()).toBe(true);
    users.push(bob);
    expect(later()).toBe(false);
  });
});
