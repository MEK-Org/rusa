// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import type { DecodedIdToken } from "firebase-admin/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorMesh } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import { runMigrations } from "../db/migrations/runner.js";
import { InboxRepository } from "../db/repositories/inbox-repository.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { createDashboardRequestHandler } from "../webhook/server.js";
import type { DashboardDataDeps } from "./api.js";
import { DashboardAuth, SESSION_MS } from "./auth.js";
import { DashboardIdentityResolver } from "./identity.js";
import { MeshEventEmitter } from "./mesh-event-emitter.js";
import { SseHub } from "./sse.js";

/**
 * Two authenticated humans talking to the same actor must each see only their
 * own conversation (#590): dashboard mesh chat is pairwise between the actor
 * and the durable human principal behind the request, on the history read,
 * the events feed, the inbox projections and the live stream alike.
 */

const PROJECT = "project";
const ACTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const PEER = "bbbbbbbb-0000-4000-8000-000000000002";

const firebaseConfig = {
  projectId: PROJECT,
  apiKey: "public-key",
  authDomain: "project.firebaseapp.com",
  appId: "app-id",
  messagingSenderId: "sender-id",
  serviceAccountKeyPath: "/private/credential.json",
};

interface Person {
  name: string;
  email: string;
  token: DecodedIdToken;
}

function person(name: string, now: number): Person {
  const email = `${name}@example.com`;
  return {
    name,
    email,
    token: {
      uid: `${name}-uid`,
      sub: `${name}-uid`,
      aud: PROJECT,
      iss: `https://securetoken.google.com/${PROJECT}`,
      iat: now / 1000,
      exp: (now + SESSION_MS) / 1000,
      auth_time: Math.floor(now / 1000),
      email,
      email_verified: true,
      firebase: { identities: {}, sign_in_provider: "google.com" },
    },
  };
}

function rec(id: string, parentId: string | null): ActorRecord {
  return {
    id,
    charter: `charter ${id}`,
    parentId,
    status: "active",
    createdAt: "2026-06-21T00:00:00.000Z",
  };
}

describe("human chat isolation (#590)", () => {
  let now: number;
  let db: Database.Database;
  let meshEvents: MeshEventRepository;
  let meshChat: MeshChatRepository;
  let inbox: InboxRepository;
  let principals: PrincipalRepository;
  let emitter: MeshEventEmitter;
  let auth: DashboardAuth;
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let alice: Person;
  let bob: Person;
  /** Session cookie → the person it authenticates. */
  const cookies = new Map<string, Person>();

  /**
   * Mirror the production mesh's durable message spine: one mesh_chat row plus
   * a `message_sent` (actor = sender, payload.to) and a `message_received`
   * (actor = recipient, payload.from) event, each re-read and fanned out to
   * the SSE hub exactly as the composition root does.
   */
  function record(fromId: string, toId: string, body: string, sessionId = "s"): string {
    const messageId = meshChat.record({ senderId: fromId, recipientId: toId, body, sessionId });
    for (const event of [
      {
        kind: "message_sent",
        actorId: fromId,
        detail: sessionId,
        payload: JSON.stringify({ messageId, to: toId }),
      },
      {
        kind: "message_received",
        actorId: toId,
        detail: sessionId,
        payload: JSON.stringify({ messageId, from: fromId }),
      },
    ]) {
      const stored = meshEvents.getById(meshEvents.record(event));
      if (stored) emitter.emitMeshEvent(stored);
    }
    return messageId;
  }

  beforeEach(async () => {
    now = Date.now();
    alice = person("alice", now);
    bob = person("bob", now);
    cookies.clear();
    db = new Database(":memory:");
    runMigrations(db);
    meshEvents = new MeshEventRepository(db);
    meshChat = new MeshChatRepository(db);
    inbox = new InboxRepository(db);
    principals = new PrincipalRepository(db);
    emitter = new MeshEventEmitter();
    const actors = new InMemoryActorRepository();
    actors.upsert(rec(ACTOR, null));
    actors.upsert(rec(PEER, ACTOR));

    const byIdToken = new Map<string, Person>([
      ["alice-token", alice],
      ["bob-token", bob],
    ]);
    const firebase = {
      verifyIdToken: async (value: string) => {
        const who = byIdToken.get(value);
        if (!who) throw new Error("unknown id token");
        return who.token;
      },
      verifySessionCookie: async (value: string) => {
        const who = cookies.get(value);
        if (!who) throw new Error("unknown session");
        return {
          ...who.token,
          iss: `https://session.firebase.google.com/${PROJECT}`,
        };
      },
      createSessionCookie: async (value: string) => {
        const who = byIdToken.get(value);
        if (!who) throw new Error("unknown id token");
        const name = `cookie-${who.name}-${cookies.size + 1}`;
        cookies.set(name, who);
        return name;
      },
    };
    auth = new DashboardAuth(
      { firebase: firebaseConfig, allowedEmails: [alice.email, bob.email] },
      firebase,
      new DashboardIdentityResolver(() => principals, PROJECT),
      () => now
    );
    const mesh = {
      sendHumanMessage: (
        toId: string,
        body: string,
        sessionId: string,
        opts?: { fromId?: string }
      ) => {
        const fromId = opts?.fromId ?? HUMAN_OPERATOR;
        const messageId = record(fromId, toId, body, sessionId);
        inbox.append([
          {
            actorId: toId,
            source: `mesh:${fromId}`,
            payload: {
              type: "human.message",
              priority: "responsive",
              messageId,
              fromId,
              sessionId,
            },
          },
        ]);
        return { delivered: true };
      },
      getSelection: () => undefined,
    };
    const deps: DashboardDataDeps = {
      actors,
      principals,
      meshEvents,
      meshChat,
      inbox,
      obligations: new ObligationRepository(db),
      sseHub: new SseHub(emitter),
      mesh: mesh as unknown as ActorMesh,
    };
    server = createServer(
      createDashboardRequestHandler(
        { port: 0, auth: { firebase: firebaseConfig, allowedEmails: [alice.email, bob.email] } },
        deps,
        null,
        auth
      )
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await auth.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  async function csrf(cookie?: string): Promise<{ cookie: string; header: string }> {
    const bootstrap = await fetch(`${origin}/api/auth/csrf`, {
      headers: { "X-Rusa-CSRF-Bootstrap": "1", ...(cookie ? { Cookie: cookie } : {}) },
    });
    const csrfCookie = bootstrap.headers.getSetCookie()[0].split(";")[0];
    return { cookie: csrfCookie, header: csrfCookie.slice(csrfCookie.indexOf("=") + 1) };
  }

  async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
    const token = await csrf(cookie);
    return fetch(origin + path, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: [cookie, token.cookie].filter(Boolean).join("; "),
        "X-Rusa-CSRF": token.header,
      },
      body: JSON.stringify(body),
    });
  }

  /** Sign a person in and return their session cookie plus durable principal id. */
  async function login(who: Person): Promise<{ cookie: string; id: string }> {
    const res = await post("/api/auth/session", { idToken: `${who.name}-token` });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) throw new Error("Expected a session cookie");
    const principal = principals.findUserByExternalIdentity({
      issuer: who.token.iss,
      subject: who.token.sub,
    });
    if (!principal) throw new Error(`Expected a durable principal for ${who.name}`);
    return { cookie: setCookie.split(";")[0], id: principal.id };
  }

  async function getJson<T>(path: string, cookie: string): Promise<{ status: number; body: T }> {
    const res = await fetch(origin + path, { headers: { Cookie: cookie } });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
  }

  type ChatPage = { chat: Array<{ senderId: string; recipientId: string; body: string }> };
  type EventPage = { events: Array<{ kind: string; actorId: string | null; body: string | null }> };
  type InboxPage = {
    entries: Array<{
      payload: Record<string, unknown>;
      reference?: { body: string | null; unavailable: string | null };
    }>;
  };

  /** Two humans each talk to the actor and the actor answers each of them. */
  async function seedBothConversations(a: { cookie: string; id: string }, b: typeof a) {
    expect(
      (await post(`/api/mesh/actors/${ACTOR}/chat`, { body: "alice asks" }, a.cookie)).status
    ).toBe(200);
    record(ACTOR, a.id, "reply to alice");
    expect(
      (await post(`/api/mesh/actors/${ACTOR}/chat`, { body: "bob asks" }, b.cookie)).status
    ).toBe(200);
    record(ACTOR, b.id, "reply to bob");
  }

  it("shows each human only their own conversation with the actor", async () => {
    const a = await login(alice);
    const b = await login(bob);
    expect(a.id).not.toBe(b.id);
    await seedBothConversations(a, b);

    // The dashboard's query as shipped: selected actor, the legacy alias, and
    // the viewer's own id.
    const bodies = (page: ChatPage) => page.chat.map((m) => m.body).sort();
    const aliceView = await getJson<ChatPage>(
      `/api/mesh/chat?actors=${ACTOR},${HUMAN_OPERATOR},${a.id}`,
      a.cookie
    );
    expect(aliceView.status).toBe(200);
    expect(bodies(aliceView.body)).toEqual(["alice asks", "reply to alice"]);
    const bobView = await getJson<ChatPage>(
      `/api/mesh/chat?actors=${ACTOR},${HUMAN_OPERATOR},${b.id}`,
      b.cookie
    );
    expect(bodies(bobView.body)).toEqual(["bob asks", "reply to bob"]);
  });

  it("pairs a reload that has not yet learned the viewer's id with the viewer, not everyone", async () => {
    const a = await login(alice);
    const b = await login(bob);
    await seedBothConversations(a, b);

    // Before `/api/dashboard/config` answers, the client only knows the alias.
    const view = await getJson<ChatPage>(
      `/api/mesh/chat?actors=${ACTOR},${HUMAN_OPERATOR}`,
      a.cookie
    );
    expect(view.status).toBe(200);
    expect(view.body.chat.map((m) => m.body).sort()).toEqual(["alice asks", "reply to alice"]);
    for (const m of view.body.chat) {
      expect([m.senderId, m.recipientId]).toContain(a.id);
    }
  });

  it("refuses a direct request for another human's conversation", async () => {
    const a = await login(alice);
    const b = await login(bob);
    await seedBothConversations(a, b);

    const stolen = await getJson<{ error: string }>(
      `/api/mesh/chat?actors=${ACTOR},${b.id}`,
      a.cookie
    );
    expect(stolen.status).toBe(403);
    expect(stolen.body.error).toContain("another human principal");
    // Naming both humans is still asking for the other one.
    expect((await getJson(`/api/mesh/chat?actors=${ACTOR},${a.id},${b.id}`, a.cookie)).status).toBe(
      403
    );
  });

  it("keeps actor↔actor chat shared mesh visibility for every human", async () => {
    const a = await login(alice);
    const b = await login(bob);
    await seedBothConversations(a, b);
    record(ACTOR, PEER, "root to child");
    record(PEER, ACTOR, "child to root");

    for (const who of [a, b]) {
      const view = await getJson<ChatPage>(`/api/mesh/chat?actors=${ACTOR},${PEER}`, who.cookie);
      expect(view.status).toBe(200);
      expect(view.body.chat.map((m) => m.body).sort()).toEqual(["child to root", "root to child"]);
    }
  });

  it("keeps another human's message bodies out of the actor's event feed", async () => {
    const a = await login(alice);
    const b = await login(bob);
    await seedBothConversations(a, b);
    record(ACTOR, PEER, "root to child");

    const feed = await getJson<EventPage>(`/api/mesh/events?actors=${ACTOR}`, a.cookie);
    expect(feed.status).toBe(200);
    const bodies = feed.body.events.map((e) => e.body);
    expect(bodies).toContain("alice asks");
    expect(bodies).toContain("reply to alice");
    expect(bodies).toContain("root to child");
    expect(bodies).not.toContain("bob asks");
    expect(bodies).not.toContain("reply to bob");
    // Not merely redacted: the other human's message events are not in the feed.
    expect(JSON.stringify(feed.body)).not.toContain(b.id);
  });

  it("redacts another human's message in the actor's inbox and thread projections", async () => {
    const a = await login(alice);
    const b = await login(bob);
    await seedBothConversations(a, b);

    const page = await getJson<InboxPage>(`/api/mesh/inbox?actor=${ACTOR}&status=all`, a.cookie);
    expect(page.status).toBe(200);
    expect(page.body.entries).toHaveLength(2);
    const mine = page.body.entries.find((e) => e.payload.fromId === a.id);
    const theirs = page.body.entries.find((e) => e.payload.fromId === b.id);
    expect(mine?.payload.content).toBe("alice asks");
    expect(mine?.reference?.body).toBe("alice asks");
    expect(theirs).toBeDefined();
    expect(theirs?.payload.content).toBeUndefined();
    expect(theirs?.reference?.body).toBeNull();
    expect(theirs?.reference?.unavailable).toContain("another human principal");
    expect(JSON.stringify(page.body)).not.toContain("bob asks");
  });

  it("streams live message frames only to the human they belong to", async () => {
    const a = await login(alice);
    const b = await login(bob);

    const controller = new AbortController();
    const stream = await fetch(`${origin}/api/mesh/stream?actors=${ACTOR}`, {
      headers: { Cookie: a.cookie },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    const reader = stream.body?.getReader();
    if (!reader) throw new Error("Expected a readable SSE body");
    const decoder = new TextDecoder();
    let received = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    })().catch(() => undefined);

    try {
      await seedBothConversations(a, b);
      record(ACTOR, PEER, "root to child");
      // A non-message event is shared mesh visibility and still arrives.
      const spawned = meshEvents.getById(
        meshEvents.record({ kind: "actor_spawned", actorId: PEER, detail: "spawned" })
      );
      if (spawned) emitter.emitMeshEvent(spawned);

      const deadline = Date.now() + 5_000;
      while (!received.includes('"actor_spawned"') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(received).toContain('"actor_spawned"');
      expect(received).toContain("alice asks");
      expect(received).toContain("reply to alice");
      expect(received).toContain("root to child");
      expect(received).not.toContain("bob asks");
      expect(received).not.toContain("reply to bob");
      expect(received).not.toContain(b.id);
    } finally {
      controller.abort();
      await pump;
    }
  });
});
