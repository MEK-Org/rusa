// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import type { DecodedIdToken } from "firebase-admin/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActorMesh } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import { runMigrations } from "../db/migrations/runner.js";
import { createActorRunModelConfig } from "../db/repositories/actor-run-model-config.js";
import { ActorRunRepository } from "../db/repositories/actor-run-repository.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { RunPromptRepository } from "../db/repositories/run-prompt-repository.js";
import { SqliteInboxRepository } from "../db/repositories/sqlite-inbox-repository.js";
import { createAgentExecMcpServer } from "../mcp/agent-exec-mcp.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import { VoiceService } from "../voice/voice-service.js";
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

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic input fixture");
  return value;
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
  let inbox: SqliteInboxRepository;
  let principals: PrincipalRepository;
  let obligations: ObligationRepository;
  let emitter: MeshEventEmitter;
  let auth: DashboardAuth;
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let deps: DashboardDataDeps;
  let alice: Person;
  let bob: Person;
  let firebase: ConstructorParameters<typeof DashboardAuth>[1];
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
    inbox = new SqliteInboxRepository(db);
    principals = new PrincipalRepository(db);
    obligations = new ObligationRepository(db);
    emitter = new MeshEventEmitter();
    const actors = new InMemoryActorRepository();
    actors.upsert(rec(ACTOR, null));
    actors.upsert(rec(PEER, ACTOR));

    const byIdToken = new Map<string, Person>([
      ["alice-token", alice],
      ["bob-token", bob],
    ]);
    firebase = {
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
    deps = {
      actors,
      runPrompts: new RunPromptRepository(db),
      principals,
      meshEvents,
      meshChat,
      inbox,
      obligations,
      sseHub: new SseHub(emitter, { principals, routedReplies: { inbox, chatStore: meshChat } }),
      mesh: mesh as unknown as ActorMesh,
      // The actor is queued, so its thread card projects its prioritized
      // inbox item.
      queuedThreadIds: () => new Set([ACTOR]),
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
  type WindowPage = EventPage & { hasMore: boolean };
  type InboxPage = {
    entries: Array<{
      payload: Record<string, unknown>;
      reference?: { body: string | null; unavailable: string | null };
    }>;
  };
  type ObligationDetail = {
    artifacts: Array<{
      artifact: { ref: string };
      reference: {
        title: string;
        body: string | null;
        author: string | null;
        timestamp: string | null;
        unavailable: string | null;
        entity?: unknown;
      };
    }>;
  };
  type ThreadsPage = {
    threads: Array<{
      id: string;
      selectedInboxItem?: { payload: Record<string, unknown> };
      moreInboxItemsCount?: number;
    }>;
  };

  it("#866 withholds complete launch prompts from both allowedEmails viewers", async () => {
    const a = await login(alice);
    const b = await login(bob);
    const runs = new ActorRunRepository(db);
    const prompts = new RunPromptRepository(db);
    const runId = runs.start({
      actorId: ACTOR,
      modelConfig: createActorRunModelConfig({ provider: "claude", model: "fixture" }),
    });
    const prompt = `# Synthetic charter\n\n  Preserve whitespace ✓\r\n${"x".repeat(300_000)}`;
    prompts.recordForActor(ACTOR, runId, prompt);
    meshEvents.record({ kind: "run_start", actorId: ACTOR, payload: JSON.stringify({ runId }) });
    const path = `/api/mesh/runs/${runId}/prompt`;
    const anonymous = await fetch(origin + path);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).not.toContain("Synthetic charter");
    for (const cookie of [a.cookie, b.cookie]) {
      const response = await fetch(origin + path, { headers: { Cookie: cookie } });
      expect(response.status).toBe(404);
      const unavailable = await response.text();
      expect(unavailable).toBe(JSON.stringify({ error: "prompt not retained" }));
      expect(unavailable).not.toContain(prompt);
      expect(unavailable).not.toContain("provider");
      expect(unavailable).not.toContain("createdAt");
      const missing = await fetch(origin + "/api/mesh/runs/pre-feature/prompt", {
        headers: { Cookie: cookie },
      });
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe(unavailable);
    }
    expect(prompts.getById(runId)?.prompt).toBe(prompt);
    const feed = await fetch(`${origin}/api/mesh/events?actors=${ACTOR}`, {
      headers: { Cookie: a.cookie },
    });
    expect(JSON.stringify(await feed.json())).not.toContain("Synthetic charter");
  });

  it("#866 serves exact bytes through sole-email auth and the supported auth-disabled local path", async () => {
    // Engineering boundary: #866 comment5972967230; no multi-human exception to #590.
    // Rebuild this fixture as a real sole-email instance: authenticator and options agree.
    await auth.close();
    const soleEmail = { firebase: firebaseConfig, email: alice.email };
    auth = new DashboardAuth(
      soleEmail,
      firebase,
      new DashboardIdentityResolver(() => principals, PROJECT),
      () => now
    );
    server.removeAllListeners("request");
    server.on(
      "request",
      createDashboardRequestHandler({ port: 0, auth: soleEmail }, deps, null, auth)
    );
    const a = await login(alice);
    expect((await post("/api/auth/session", { idToken: "bob-token" })).status).toBe(401);
    const runId = new ActorRunRepository(db).start({
      actorId: ACTOR,
      modelConfig: createActorRunModelConfig({ provider: "claude", model: "fixture" }),
    });
    const prompt = `# Synthetic charter\n\n  Preserve whitespace ✓\r\n${"x".repeat(300_000)}`;
    const prompts = new RunPromptRepository(db);
    prompts.recordForActor(ACTOR, runId, prompt);
    const path = `/api/mesh/runs/${runId}/prompt`;
    expect((await fetch(origin + path)).status).toBe(401);
    const authenticated = await fetch(origin + path, { headers: { Cookie: a.cookie } });
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual({ prompt });
    // Incomplete authenticated adapters refuse before touching retained prompt storage.
    const config = Object.getOwnPropertyDescriptor(auth, "config");
    const readPrompt = vi.spyOn(prompts, "getById");
    Object.defineProperty(auth, "config", { value: undefined, configurable: true });
    try {
      expect((await fetch(origin + path, { headers: { Cookie: a.cookie } })).status).toBe(404);
      expect(readPrompt).not.toHaveBeenCalled();
    } finally {
      if (config) Object.defineProperty(auth, "config", config);
      readPrompt.mockRestore();
    }
    // Replace only this isolated fixture's request handler; Alice is its sole durable user.
    server.removeAllListeners("request");
    server.on("request", createDashboardRequestHandler({ port: 0 }, deps));
    const local = await fetch(origin + path);
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({ prompt });
    // A second active user leaves auth-disabled mode unable to identify its viewer.
    principals.createUser({ email: "second@example.com", createdAt: new Date(now).toISOString() });
    const ambiguous = await fetch(origin + path);
    expect(ambiguous.status).toBe(404);
    const unavailable = await ambiguous.text();
    expect(unavailable).toBe(JSON.stringify({ error: "prompt not retained" }));
    expect(unavailable).not.toContain("Synthetic charter");
    expect(prompts.getById(runId)?.prompt).toBe(prompt);
  });

  it("binds leased voice streams to the authenticated human across matching and mismatched reconnects", async () => {
    const a = await login(alice);
    const b = await login(bob);
    const home = mkdtempSync(join(tmpdir(), "voice-auth-fixture-"));
    const service = new VoiceService({
      home,
      sessionLeaseMs: 1000,
      speech: {
        transcribe: async () => "",
        synthesize: async () => ({ pcm: Buffer.alloc(0), sampleRate: 24000 }),
        streamSynthesize: async () => ({
          sampleRate: 24000,
          pcmStream: (async function* () {
            yield Buffer.alloc(0);
          })(),
        }),
      },
    });
    server.removeAllListeners("request");
    server.on(
      "request",
      createDashboardRequestHandler(
        { port: 0, auth: auth.config },
        deps,
        { actors: deps.actors, mesh: deps.mesh, principals, sseHub: deps.sseHub, service },
        auth
      )
    );
    const path = `${origin}/api/mesh/voice/stream?actors=${ACTOR}&sessionId=synthetic-voice-lease`;
    const streams: AbortController[] = [];
    const open = (cookie: string) => {
      const controller = new AbortController();
      streams.push(controller);
      return {
        controller,
        response: fetch(path, { headers: { Cookie: cookie }, signal: controller.signal }),
      };
    };
    try {
      expect((await fetch(path)).status).toBe(401);
      const first = open(a.cookie);
      expect((await first.response).status).toBe(200);
      const binding = { sessionId: "synthetic-voice-lease", principalId: a.id };
      expect(service.activeSessionFor(ACTOR)).toEqual(binding);
      first.controller.abort();
      await vi.waitFor(() => expect(deps.sseHub.connectionCount).toBe(0));
      const matching = open(a.cookie);
      expect((await matching.response).status).toBe(200);
      expect(service.activeSessionFor(ACTOR)).toEqual(binding);
      matching.controller.abort();
      await vi.waitFor(() => expect(deps.sseHub.connectionCount).toBe(0));
      const mismatch = await fetch(path, { headers: { Cookie: b.cookie } });
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toEqual({
        error: "sessionId is already bound to a different principal",
      });
      expect(deps.sseHub.connectionCount).toBe(0);
      expect(service.activeSessionFor(ACTOR)).toEqual(binding);
    } finally {
      for (const controller of streams) controller.abort();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses another human's typed input before write, wake and actual reply while a voice lease is held (#597)", async () => {
    const a = await login(alice);
    const b = await login(bob);
    const home = mkdtempSync(join(tmpdir(), "typed-voice-auth-fixture-"));
    let voiceNow = Date.now();
    const service = new VoiceService({
      home,
      now: () => voiceNow,
      sessionLeaseMs: 1000,
      speech: {
        transcribe: async () => "synthetic saved memo",
        synthesize: async () => ({ pcm: Buffer.alloc(0), sampleRate: 24000 }),
        streamSynthesize: async () => ({
          sampleRate: 24000,
          pcmStream: (async function* () {
            yield Buffer.alloc(0);
          })(),
        }),
      },
    });
    const mesh = new ActorMesh({
      actors: deps.actors,
      principals,
      inboxStore: inbox,
      recordChat: (entry) => meshChat.record(entry),
      recordRoutedReply: (entry) =>
        meshChat.recordRoutedReply(entry, meshEvents, (event) => emitter.emitMeshEvent(event)),
      voiceSessionTransfer: service,
      createActor: () => {
        throw new Error("synthetic fixture must not spawn providers");
      },
    });
    // Retain the actual durable admission/dispatch spine while observing wakes.
    const dispatch = vi.spyOn(mesh, "dispatch").mockImplementation(() => false);
    deps.mesh = mesh;
    server.removeAllListeners("request");
    server.on(
      "request",
      createDashboardRequestHandler(
        { port: 0, auth: auth.config },
        deps,
        { actors: deps.actors, mesh, principals, sseHub: deps.sseHub, service },
        auth
      )
    );
    const onWrite = vi.fn();
    let newestHumanInput: string | undefined;
    const unsubscribe = inbox.onItemsAppended((entries) => {
      for (const entry of entries) {
        if (
          entry.actorId === ACTOR &&
          ["human.message", "human.voice"].includes(entry.payload.type)
        ) {
          newestHumanInput = entry.id;
        }
      }
    });
    const reply = async (
      body: string,
      beforeReply?: () => Promise<void>,
      checkSuccess = true,
      inputRef: string | null | undefined = newestHumanInput,
      actorId = ACTOR,
      omitInputRef = false
    ) => {
      const server = createAgentExecMcpServer(mesh, actorId, ACTOR, undefined, { onWrite });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "synthetic-reply-fixture", version: "1" });
      await client.connect(clientTransport);
      try {
        await beforeReply?.();
        const args: { message: string; input_ref?: string } = { message: body };
        if (!omitInputRef && inputRef !== null) {
          args.input_ref = inputRef;
        }
        const result = await client.callTool({
          name: "reply",
          arguments: args,
        });
        if (checkSuccess) expect(result.isError).not.toBe(true);
        return result;
      } finally {
        await client.close();
        await server.close();
      }
    };
    // A live recipient makes accepted admission observable without any provider run.
    mesh.adopt(rec(ACTOR, null), {
      id: ACTOR,
      isRunning: false,
      requestRun: () => {},
      markUnkillable: () => {},
      close: () => {},
      preemptForResponsive: () => ({ preempted: false as const }),
    } as Parameters<ActorMesh["adopt"]>[1]);
    const lease = "synthetic-alice-lease";
    service.openSession(lease, ACTOR, a.id);
    dispatch.mockClear();
    try {
      const refused = await post(
        `/api/mesh/actors/${ACTOR}/chat`,
        {
          body: "synthetic bob private input",
          sessionId: "synthetic-bob-text",
        },
        b.cookie
      );
      // On the unfixed product this executes the real reply tool after Bob's
      // admitted input, exposing that the recorded reply goes to Alice.
      if (refused.ok) await reply("synthetic response to bob private input");
      expect({
        status: refused.status,
        leakedReply: db
          .prepare(
            "SELECT COUNT(*) AS n FROM mesh_chat WHERE sender_id = ? AND recipient_id = ? AND body = ?"
          )
          .get(ACTOR, a.id, "synthetic response to bob private input"),
        persisted: db.prepare("SELECT COUNT(*) AS n FROM mesh_chat").get(),
        wakes: dispatch.mock.calls.length,
        conversation: deps.actors.lastHumanChat(ACTOR),
        inbox: inbox.list(ACTOR, { status: "all" }).entries.length,
      }).toEqual({
        status: 409,
        leakedReply: { n: 0 },
        persisted: { n: 0 },
        wakes: 0,
        conversation: undefined,
        inbox: 0,
      });
      expect(await refused.json()).toEqual({
        error: "voice session is held by a different principal",
      });
      expect(() =>
        mesh.sendHumanMessage(ACTOR, "synthetic bob direct", "direct", { fromId: b.id })
      ).toThrow("voice session is held by a different principal");
      expect(service.activeSessionFor(ACTOR)).toEqual({ sessionId: lease, principalId: a.id });

      expect(
        (await post(`/api/mesh/actors/${ACTOR}/chat`, { body: "synthetic alice input" }, a.cookie))
          .status
      ).toBe(200);
      await reply("synthetic alice reply");
      expect(
        meshChat.listForSession(lease, { limit: 100 }).map((m) => [m.recipientId, m.body])
      ).toEqual([[a.id, "synthetic alice reply"]]);
      service.closeSession(lease);
      expect(
        (
          await post(
            `/api/mesh/actors/${ACTOR}/chat`,
            { body: "synthetic bob unheld", sessionId: "synthetic-unheld" },
            b.cookie
          )
        ).status
      ).toBe(200);
      await reply("synthetic bob unheld reply");
      expect(
        meshChat
          .listForSession("synthetic-unheld", { limit: 100 })
          .map((m) => [m.senderId, m.recipientId, m.body])
      ).toEqual([
        [b.id, ACTOR, "synthetic bob unheld"],
        [ACTOR, b.id, "synthetic bob unheld reply"],
      ]);
      expect(dispatch).toHaveBeenCalled();

      const outcomes = [];
      for (const mode of [
        "unheld-to-alice",
        "bob-lease-to-alice",
        "intervening-alice-chat",
      ] as const) {
        service.closeSession(lease);
        const bobLease = `synthetic-bob-${mode}`;
        if (mode === "bob-lease-to-alice") service.openSession(bobLease, ACTOR, b.id);
        expect(
          (
            await post(
              `/api/mesh/actors/${ACTOR}/chat`,
              {
                body: `synthetic accepted bob ${mode}`,
                sessionId: `synthetic-text-${mode}`,
              },
              b.cookie
            )
          ).status
        ).toBe(200);
        let rowsBefore = 0;
        let writesBefore = 0;
        let wakesBefore = 0;
        let inboxBefore = 0;
        let emitsBefore = 0;
        const emitted = vi.spyOn(mesh, "recordMessageEmitted");
        const result = await reply(
          `synthetic pending bob response ${mode}`,
          async () => {
            service.closeSession(bobLease);
            service.openSession(lease, ACTOR, a.id);
            if (mode === "intervening-alice-chat") {
              expect(
                (
                  await post(
                    `/api/mesh/actors/${ACTOR}/chat`,
                    {
                      body: "synthetic alice intervenes before pending bob response",
                    },
                    a.cookie
                  )
                ).status
              ).toBe(200);
            }
            rowsBefore = (db.prepare("SELECT COUNT(*) AS n FROM mesh_chat").get() as { n: number })
              .n;
            writesBefore = onWrite.mock.calls.length;
            wakesBefore = dispatch.mock.calls.length;
            inboxBefore = inbox.list(ACTOR, { status: "all" }).entries.length;
            emitsBefore = emitted.mock.calls.length;
          },
          false
        );
        outcomes.push({
          mode,
          refused: result.isError === true,
          aliceReplies: (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM mesh_chat WHERE sender_id = ? AND recipient_id = ? AND body = ?"
              )
              .get(ACTOR, a.id, `synthetic pending bob response ${mode}`) as { n: number }
          ).n,
          replyRows:
            (db.prepare("SELECT COUNT(*) AS n FROM mesh_chat").get() as { n: number }).n -
            rowsBefore,
          writeSignals: onWrite.mock.calls.length - writesBefore,
          emits: emitted.mock.calls.length - emitsBefore,
          wakes: dispatch.mock.calls.length - wakesBefore,
          inbox: inbox.list(ACTOR, { status: "all" }).entries.length - inboxBefore,
        });
        emitted.mockRestore();
        if (mode === "intervening-alice-chat") {
          await reply("synthetic explicit later alice reply");
          expect(
            meshChat
              .listForSession(lease, { limit: 100 })
              .find((entry) => entry.body === "synthetic explicit later alice reply")
          ).toMatchObject({ recipientId: a.id });
        }
        service.closeSession(lease);
      }
      expect(outcomes).toEqual(
        ["unheld-to-alice", "bob-lease-to-alice", "intervening-alice-chat"].map((mode) => ({
          mode,
          refused: true,
          aliceReplies: 0,
          replyRows: 0,
          writeSignals: 0,
          emits: 0,
          wakes: 0,
          inbox: 0,
        }))
      );

      // A later same-human lease cannot retarget an unheld accepted input.
      expect(
        (
          await post(
            `/api/mesh/actors/${ACTOR}/chat`,
            {
              body: "synthetic frozen unheld alice",
              sessionId: lease,
            },
            a.cookie
          )
        ).status
      ).toBe(200);
      const frozenTextRef = required(newestHumanInput);
      service.openSession(lease, ACTOR, a.id);
      await reply("synthetic frozen text reply");
      expect(
        meshChat
          .listForSession(lease, { limit: 100 })
          .find((entry) => entry.body === "synthetic frozen text reply")
      ).toMatchObject({ recipientId: a.id });

      // Actual typed voice acceptance freezes the voice route rather than the text route.
      expect(
        (
          await post(
            `/api/mesh/actors/${ACTOR}/chat`,
            {
              body: "synthetic transfer input",
              sessionId: "synthetic-text-during-voice",
            },
            a.cookie
          )
        ).status
      ).toBe(200);
      const sourceRef = required(newestHumanInput);
      await reply("synthetic accepted voice reply", undefined, true, sourceRef);
      expect(
        meshChat
          .listForSession(lease, { limit: 100 })
          .find((entry) => entry.body === "synthetic accepted voice reply")
      ).toMatchObject({ recipientId: a.id });
      mesh.adopt(rec(PEER, ACTOR), {
        id: PEER,
        isRunning: false,
        requestRun: () => {},
        markUnkillable: () => {},
        close: () => {},
        preemptForResponsive: () => ({ preempted: false as const }),
      } as Parameters<ActorMesh["adopt"]>[1]);
      mesh.grantHandle(ACTOR, { id: PEER });
      mesh.grantHandle(PEER, { id: ACTOR });
      // A later same-ID lease cannot confer transfer authority on an unheld typed input.
      mesh.selectInboxEntries(ACTOR, [frozenTextRef]);
      const rebind = vi.spyOn(service, "transferActiveSession");
      const peerBefore = inbox.list(PEER, { status: "all" }).entries;
      const writesBeforeUnsupported = onWrite.mock.calls.length;
      expect(() => mesh.transferVoiceSession(ACTOR, PEER)).toThrow("unambiguous");
      expect(rebind).not.toHaveBeenCalled();
      expect(service.activeSessionFor(ACTOR)).toEqual({ sessionId: lease, principalId: a.id });
      expect(inbox.list(PEER, { status: "all" }).entries).toEqual(peerBefore);
      expect(onWrite.mock.calls).toHaveLength(writesBeforeUnsupported);
      rebind.mockRestore();
      mesh.selectInboxEntries(ACTOR, [sourceRef]);
      mesh.transferVoiceSession(ACTOR, PEER);
      const handoff = required(
        inbox.list(PEER).entries.find((entry) => entry.payload.type === "voice.transfer")
      );
      expect(handoff.payload.replyInput).toEqual({ actorId: ACTOR, entryId: sourceRef });
      await reply("synthetic target reply", undefined, true, handoff.id, PEER);
      mesh.selectInboxEntries(PEER, [handoff.id]);
      mesh.transferVoiceSession(PEER, ACTOR);
      const returned = required(
        inbox.list(ACTOR).entries.find((entry) => entry.payload.type === "voice.transfer")
      );
      await reply("synthetic returned reply", undefined, true, returned.id);

      const emittedObserver = vi.spyOn(mesh, "recordMessageEmitted");
      const snapshot = () => ({
        rows: (db.prepare("SELECT COUNT(*) AS n FROM mesh_chat").get() as { n: number }).n,
        events: (db.prepare("SELECT COUNT(*) AS n FROM mesh_events").get() as { n: number }).n,
        writes: onWrite.mock.calls.length,
        wakes: dispatch.mock.calls.length,
        entries: (
          db.prepare("SELECT COUNT(*) AS n FROM actor_inbox_entries").get() as { n: number }
        ).n,
        emits: emittedObserver.mock.calls.length,
      });
      const assertRefused = async (
        ref: string | null | undefined,
        actorId = ACTOR,
        omitRef = false
      ) => {
        await Promise.resolve(); // Drain the admission/append nudge before measuring reply effects.
        const before = snapshot();
        const result = await reply(
          "synthetic must not emit",
          undefined,
          false,
          ref,
          actorId,
          omitRef
        );
        expect(result.isError).toBe(true);
        expect(snapshot()).toEqual(before);
      };

      // Delayed completion: caller's own handled entry remains usable by explicit input_ref.
      inbox.markHandled(ACTOR, [sourceRef]);
      await reply("synthetic delayed response to handled input", undefined, true, sourceRef);
      expect(
        meshChat
          .listForSession(lease, { limit: 100 })
          .find((entry) => entry.body === "synthetic delayed response to handled input")
      ).toMatchObject({ recipientId: a.id });

      // Refusal when unhandled candidate is missing/ambiguous/foreign
      await assertRefused(undefined, ACTOR, true);
      await assertRefused("", ACTOR, false);
      await assertRefused(null, ACTOR, false);
      await assertRefused("unknown-input");
      await assertRefused(handoff.id); // foreign entry from PEER

      // Unique selected unhandled candidate defaults without input_ref
      mesh.selectInboxEntries(ACTOR, [returned.id]);
      await reply(
        "synthetic implicit reply from unique selection",
        undefined,
        true,
        undefined,
        ACTOR,
        true
      );
      expect(
        meshChat
          .listForSession(lease, { limit: 100 })
          .find((entry) => entry.body === "synthetic implicit reply from unique selection")
      ).toMatchObject({ recipientId: a.id });

      // Multiple selected entries refuse implicit reply (ambiguity)
      const [secondHandoff] = inbox.append([
        {
          actorId: ACTOR,
          source: `voice:transfer:${PEER}`,
          payload: {
            ...handoff.payload,
            fromId: PEER,
            sessionId: lease,
            replyInput: { actorId: PEER, entryId: handoff.id },
            replyBinding: handoff.payload.replyBinding,
          },
        },
      ]);
      mesh.selectInboxEntries(ACTOR, [returned.id, secondHandoff.id]);
      await assertRefused(undefined, ACTOR, true);
      mesh.selectInboxEntries(ACTOR, [returned.id]);
      const cyclicId = "synthetic-cyclic-input";
      inbox.append([
        {
          id: cyclicId,
          actorId: ACTOR,
          source: `voice:transfer:${ACTOR}`,
          payload: {
            ...handoff.payload,
            fromId: ACTOR,
            replyInput: { actorId: ACTOR, entryId: cyclicId },
          },
        },
      ]);
      await assertRefused(cyclicId);
      const deep = Array.from({ length: 101 }, (_, index) => ({
        id: `synthetic-deep-${index}`,
        actorId: ACTOR,
        source: `voice:transfer:${ACTOR}`,
        payload: {
          ...handoff.payload,
          fromId: ACTOR,
          replyInput: {
            actorId: ACTOR,
            entryId: index === 100 ? sourceRef : `synthetic-deep-${index + 1}`,
          },
        },
      }));
      inbox.append(deep);
      await assertRefused(required(deep[0]).id);
      // A handled ancestor keeps its proof; the still-unhandled own handoff works.
      principals.setDisabled(a.id, new Date().toISOString());
      await assertRefused(returned.id);
      principals.setDisabled(a.id, null);

      // Losing local ownership is not proof that the accepted lease ended.
      service.transferActiveSession(ACTOR, PEER, { sessionId: lease, principalId: a.id });
      await assertRefused(sourceRef);
      service.revertActiveSessionTransfer(lease, ACTOR, PEER);
      const missingLiveness = vi
        .spyOn(service, "acceptedSessionExists")
        .mockReturnValue(undefined as unknown as boolean);
      service.closeSession(lease);
      await assertRefused(sourceRef);
      missingLiveness.mockRestore();
      Object.defineProperty(service, "acceptedSessionExists", {
        value: undefined,
        configurable: true,
      });
      await assertRefused(sourceRef); // A voice port without global liveness evidence fails closed.
      delete (service as { acceptedSessionExists?: unknown }).acceptedSessionExists;
      service.openSession(lease, ACTOR, a.id);
      // Expiry, unlike a transfer, ends the lease and permits its original typed route.
      service.disconnectSession(lease);
      voiceNow += 2000;
      expect(service.acceptedSessionExists(lease)).toBe(false);
      // Ended voice lease fallback: typed input falls back to its original frozen text route.
      // Verified typed handoffs retain the original admission route through transfer and return.
      service.closeSession(lease);
      await reply("synthetic ended returned typed reply", undefined, true, returned.id);
      expect(
        meshChat
          .listForSession("synthetic-text-during-voice", { limit: 100 })
          .find((entry) => entry.body === "synthetic ended returned typed reply")
      ).toMatchObject({ senderId: ACTOR, recipientId: a.id });
      // The routed reply is published after chat and authoritative proof commit, once.
      const routedStreamController = new AbortController();
      const routedStream = await fetch(`${origin}/api/mesh/stream?actors=${ACTOR}`, {
        headers: { Cookie: a.cookie },
        signal: routedStreamController.signal,
      });
      const routedReader = required(routedStream.body?.getReader());
      const routedFrames = (async () => {
        let text = "";
        const decoder = new TextDecoder();
        while (!text.includes("synthetic ended peer typed reply")) {
          const frame = await routedReader.read();
          if (frame.done) break;
          text += decoder.decode(frame.value, { stream: true });
        }
        return text;
      })();
      await reply("synthetic ended peer typed reply", undefined, true, handoff.id, PEER);
      const routedText = await routedFrames;
      routedStreamController.abort();
      const sentFrame = routedText
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .find((event) => event.kind === "message_sent");
      expect(JSON.parse(sentFrame.payload)).toMatchObject({ originalActorId: ACTOR });
      expect(routedText).toContain(`"actorId":"${PEER}"`);
      const routeHistory = await getJson<{
        chat: { id: string; body: string; senderId: string; sessionId: string }[];
      }>(`/api/mesh/chat?actors=${ACTOR},${a.id}`, a.cookie);
      const routedRows = routeHistory.body.chat.filter(
        (row) => row.body === "synthetic ended peer typed reply"
      );
      expect(routedRows).toHaveLength(1);
      expect(routedRows[0]).toMatchObject({
        senderId: PEER,
        sessionId: "synthetic-text-during-voice",
      });
      const bobHistory = await getJson<{ chat: { body: string }[] }>(
        `/api/mesh/chat?actors=${ACTOR},${b.id}`,
        b.cookie
      );
      expect(
        bobHistory.body.chat.some((row) => row.body === "synthetic ended peer typed reply")
      ).toBe(false);
      const routedID = required(routedRows[0]).id;
      const rawProof = required(meshChat.routedReplyProof(routedID) ?? undefined);
      const published = vi.fn();
      const unobserve = emitter.onMeshEvent(published);
      try {
        const beforeRollback = snapshot();
        const eventWrite = vi.spyOn(meshEvents, "record").mockImplementation(() => {
          throw new Error("synthetic proof write failure");
        });
        const refusedWrite = await reply(
          "synthetic must roll back",
          undefined,
          false,
          handoff.id,
          PEER
        );
        eventWrite.mockRestore();
        expect(refusedWrite.isError).toBe(true);
        const afterRollback = snapshot();
        expect({ ...afterRollback, emits: beforeRollback.emits }).toEqual(beforeRollback);
        expect(published).not.toHaveBeenCalled();
      } finally {
        unobserve();
      }
      // Metadata never broadens history without an independently verified actor-owned chain.
      for (const invalid of [
        {
          ...JSON.parse(required(rawProof.payload ?? undefined)),
          replyInput: { actorId: PEER, entryId: sourceRef },
        },
        {
          ...JSON.parse(required(rawProof.payload ?? undefined)),
          originalActorId: "foreign-actor",
        },
        { ...JSON.parse(required(rawProof.payload ?? undefined)), replyInput: null },
        {},
      ]) {
        db.prepare("UPDATE mesh_events SET payload = ? WHERE id = ?").run(
          JSON.stringify(invalid),
          rawProof.id
        );
        const hidden = await getJson<{ chat: { id: string }[] }>(
          `/api/mesh/chat?actors=${ACTOR},${a.id}`,
          a.cookie
        );
        expect(hidden.body.chat.some((row) => row.id === routedID)).toBe(false);
        const events = await getJson<{ events: { payload: string | null }[] }>(
          `/api/mesh/events?since=2000-01-01&limit=500`,
          a.cookie
        );
        expect(
          events.body.events.some((event) =>
            event.payload?.includes(`"originalActorId":"${ACTOR}"`)
          )
        ).toBe(false);
      }
      // Malformed proof grants no added history; live foreign proof is stripped too.
      db.prepare("UPDATE mesh_events SET payload = ? WHERE id = ?").run("{malformed", rawProof.id);
      const malformedHistory = await getJson<{ chat: { id: string }[] }>(
        `/api/mesh/chat?actors=${ACTOR},${a.id}`,
        a.cookie
      );
      expect(malformedHistory.status).toBe(200);
      expect(malformedHistory.body.chat.some((row) => row.id === routedID)).toBe(false);
      const forgedStreamController = new AbortController();
      const forgedStream = await fetch(`${origin}/api/mesh/stream?actors=${ACTOR}`, {
        headers: { Cookie: a.cookie },
        signal: forgedStreamController.signal,
      });
      const forgedReader = required(forgedStream.body?.getReader());
      const forgedFrames = (async () => {
        let text = "";
        const decoder = new TextDecoder();
        while (!text.includes(rawProof.id)) {
          const frame = await forgedReader.read();
          if (frame.done) break;
          text += decoder.decode(frame.value, { stream: true });
        }
        return text;
      })();
      const foreignProof = {
        ...JSON.parse(required(rawProof.payload ?? undefined)),
        replyInput: { actorId: PEER, entryId: sourceRef },
      };
      db.prepare("UPDATE mesh_events SET payload = ? WHERE id = ?").run(
        JSON.stringify(foreignProof),
        rawProof.id
      );
      emitter.emitMeshEvent(required(meshEvents.getById(rawProof.id) ?? undefined));
      const forgedText = await forgedFrames;
      forgedStreamController.abort();
      const forgedFrame = forgedText
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)))
        .find((event) => event.id === rawProof.id);
      expect(JSON.parse(forgedFrame.payload).originalActorId).toBeUndefined();
      expect(JSON.parse(forgedFrame.payload).replyInput).toBeUndefined();
      db.prepare("UPDATE mesh_events SET payload = ? WHERE id = ?").run(
        rawProof.payload,
        rawProof.id
      );
      expect(
        meshChat
          .listForSession("synthetic-text-during-voice", { limit: 100 })
          .find((entry) => entry.body === "synthetic ended peer typed reply")
      ).toMatchObject({ senderId: PEER, recipientId: a.id });
      expect(
        meshChat
          .listForSession(lease, { limit: 100 })
          .some((entry) => entry.body === "synthetic ended peer typed reply")
      ).toBe(false);

      // But typed input falls back to its original frozen text route:
      await reply("synthetic ended voice lease fallback", undefined, true, sourceRef);
      expect(
        meshChat
          .listForSession("synthetic-text-during-voice", { limit: 100 })
          .find((entry) => entry.body === "synthetic ended voice lease fallback")
      ).toMatchObject({ recipientId: a.id });
      // Route evidence is stamped at authenticated admission, not inferred from payload type/prefix.
      for (const kind of ["memo", "typed-prefix", "spoken"] as const) {
        service.openSession(lease, ACTOR, a.id);
        const memoCsrf = await csrf(a.cookie);
        const accepted =
          kind === "memo"
            ? await fetch(`${origin}/api/mesh/actors/${ACTOR}/voice-memo?sessionId=${lease}`, {
                method: "POST",
                headers: {
                  Cookie: `${a.cookie}; ${memoCsrf.cookie}`,
                  Origin: origin,
                  "X-Rusa-CSRF": memoCsrf.header,
                  "Content-Type": "audio/webm",
                },
                body: Buffer.from("synthetic audio fixture"),
              })
            : await post(
                `/api/mesh/actors/${ACTOR}/chat`,
                {
                  body: "🎙️ [voice memo synthetic typed prefix",
                  sessionId: `synthetic-${kind}-text`,
                  voice: kind === "spoken",
                },
                a.cookie
              );
        expect(accepted.status).toBe(200);
        const ref = required(newestHumanInput);
        const acceptedEntry = required(inbox.read(ACTOR, ref) ?? undefined);
        expect(acceptedEntry.payload.type).toBe("human.voice");
        service.closeSession(lease);
        if (kind === "spoken") {
          await assertRefused(ref); // Genuine live voice has no independently accepted text route.
          continue;
        }
        await reply(`synthetic ended ${kind} reply`, undefined, true, ref);
        expect(
          meshChat
            .listForSession(String(acceptedEntry.payload.sessionId), { limit: 100 })
            .find((entry) => entry.body === `synthetic ended ${kind} reply`)
        ).toMatchObject({ senderId: ACTOR, recipientId: a.id });
        const acceptedBinding = acceptedEntry.payload.replyBinding as Record<string, unknown>;
        const textRoute = acceptedBinding.textRoute as Record<string, unknown>;
        for (const invalid of [
          undefined,
          { ...textRoute, actorId: PEER },
          { ...textRoute, sessionId: "foreign-session" },
          { ...textRoute, messageId: "foreign-message" },
        ]) {
          const [bad] = inbox.append([
            {
              actorId: ACTOR,
              source: acceptedEntry.source,
              payload: {
                ...acceptedEntry.payload,
                replyBinding: { ...acceptedBinding, textRoute: invalid },
              },
            },
          ]);
          await assertRefused(bad.id);
        }
        service.openSession("synthetic-bob-conflict", ACTOR, b.id);
        await assertRefused(ref);
        service.closeSession("synthetic-bob-conflict");
      }
      service.openSession(lease, ACTOR, a.id);

      // Valid 100-record input resolves, but its next handoff must refuse before rebind.
      const depthChain = Array.from({ length: 99 }, (_, index) => ({
        id: `synthetic-boundary-${index}`,
        actorId: ACTOR,
        source: `voice:transfer:${ACTOR}`,
        payload: {
          ...handoff.payload,
          fromId: ACTOR,
          replyInput: {
            actorId: ACTOR,
            entryId: index === 98 ? sourceRef : `synthetic-boundary-${index + 1}`,
          },
        },
      }));
      inbox.append(depthChain);
      mesh.selectInboxEntries(ACTOR, [required(depthChain[0]).id]);
      expect(mesh.resolveHumanReplyInput(ACTOR, required(depthChain[0]).id).binding).toMatchObject({
        principalId: a.id,
        sessionId: lease,
        leaseBound: true,
      });
      const beforeDepth = snapshot();
      const depthRebind = vi.spyOn(service, "transferActiveSession");
      const depthControl = vi.spyOn(service, "notifySessionTransferred");
      expect(() => mesh.transferVoiceSession(ACTOR, PEER)).toThrow("too deep");
      expect(depthRebind).not.toHaveBeenCalled();
      expect(depthControl).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(beforeDepth);
      expect(service.activeSessionFor(ACTOR)).toEqual({ sessionId: lease, principalId: a.id });

      // Adjacent valid 99-record source produces a resolvable 100-record target handoff.
      mesh.selectInboxEntries(ACTOR, [required(depthChain[1]).id]);
      mesh.transferVoiceSession(ACTOR, PEER);
      expect(depthRebind).toHaveBeenCalledTimes(1);
      expect(service.activeSessionFor(PEER)).toEqual({ sessionId: lease, principalId: a.id });
      const boundaryHandoff = required(
        inbox
          .list(PEER)
          .entries.find(
            (entry) =>
              entry.payload.type === "voice.transfer" &&
              (entry.payload.replyInput as { entryId: string }).entryId === depthChain[1].id
          )
      );
      expect(mesh.resolveHumanReplyInput(PEER, boundaryHandoff.id).binding).toMatchObject({
        principalId: a.id,
        sessionId: lease,
        leaseBound: true,
      });
      service.revertActiveSessionTransfer(lease, ACTOR, PEER);
      depthRebind.mockRestore();
      depthControl.mockRestore();

      // The selected source must be unambiguous and current, before any rebind/write.
      mesh.selectInboxEntries(ACTOR, [returned.id]);
      const append = vi.spyOn(inbox, "append").mockImplementation(() => {
        throw new Error("synthetic disk full");
      });
      expect(() => mesh.transferVoiceSession(ACTOR, PEER)).toThrow("synthetic disk full");
      append.mockRestore();
      expect(service.activeSessionFor(ACTOR)).toEqual({ sessionId: lease, principalId: a.id });
      expect(
        (
          await post(
            `/api/mesh/actors/${ACTOR}/chat`,
            {
              body: "synthetic second matching voice input",
            },
            a.cookie
          )
        ).status
      ).toBe(200);
      mesh.selectInboxEntries(ACTOR, [returned.id, required(newestHumanInput)]);
      const beforeAmbiguous = snapshot();
      expect(() => mesh.transferVoiceSession(ACTOR, PEER)).toThrow("unambiguous");
      expect(snapshot()).toEqual(beforeAmbiguous);
      // Cyclic and over-depth selected proofs confer no transfer authority.
      mesh.selectInboxEntries(ACTOR, [cyclicId]);
      expect(() => mesh.transferVoiceSession(ACTOR, PEER)).toThrow("cyclic");
      mesh.selectInboxEntries(ACTOR, [required(deep[0]).id]);
      expect(() => mesh.transferVoiceSession(ACTOR, PEER)).toThrow("too deep");
      mesh.selectInboxEntries(ACTOR, [returned.id]);
      service.openSession("synthetic-ambiguous-alice", ACTOR, a.id);
      const beforeAmbiguousLease = snapshot();
      expect(() =>
        mesh.sendHumanMessage(ACTOR, "synthetic must not admit", "text", { fromId: a.id })
      ).toThrow("multiple active");
      await assertRefused(returned.id);
      expect(snapshot()).toEqual(beforeAmbiguousLease);
      service.closeSession("synthetic-ambiguous-alice");
      // Mutate the lease at the context-render seam. Expected snapshot rejects it.
      const raced = vi
        .spyOn(service, "transferActiveSession")
        .mockImplementation((from, to, expected) => {
          service.closeSession(lease);
          service.openSession("synthetic-replacement", ACTOR, b.id);
          raced.mockRestore();
          return service.transferActiveSession(from, to, expected);
        });
      const beforeRace = snapshot();
      expect(() => mesh.transferVoiceSession(ACTOR, PEER)).toThrow("changed before transfer");
      expect(snapshot()).toEqual(beforeRace);
      await assertRefused(returned.id);
      service.closeSession("synthetic-replacement");
      service.openSession("synthetic-new-alice", ACTOR, a.id);
      await assertRefused(returned.id);
      service.closeSession("synthetic-new-alice");
      await reply("synthetic ended replacement typed reply", undefined, true, returned.id);
      service.openSession("synthetic-unbound-lease", ACTOR);
      // Optional voice ports can return an unbound lease without rejecting in the all-lease check.
      const unboundAllLease = vi.spyOn(service, "heldByOtherPrincipal").mockReturnValue(false);
      try {
        await Promise.resolve();
        const beforeUnbound = snapshot();
        const unbound = await post(
          `/api/mesh/actors/${ACTOR}/chat`,
          {
            body: "synthetic unbound lease must refuse",
            sessionId: "synthetic-unbound-text",
          },
          a.cookie
        );
        expect(unbound.status).toBe(409);
        expect(snapshot()).toEqual(beforeUnbound);
      } finally {
        service.closeSession("synthetic-unbound-lease");
        unboundAllLease.mockRestore();
      }
    } finally {
      unsubscribe();
      service.closeSession(lease);
      rmSync(home, { recursive: true, force: true });
    }
  });

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

    // A two-actor query reads the pair plus the viewer's own side with each of
    // them, as #469 established — never the other human's side.
    for (const [who, own] of [
      [a, ["alice asks", "reply to alice"]],
      [b, ["bob asks", "reply to bob"]],
    ] as const) {
      const view = await getJson<ChatPage>(`/api/mesh/chat?actors=${ACTOR},${PEER}`, who.cookie);
      expect(view.status).toBe(200);
      expect(view.body.chat.map((m) => m.body).sort()).toEqual(
        ["child to root", "root to child", ...own].sort()
      );
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

  it("keeps another human's messages out of the since-window event feed", async () => {
    const a = await login(alice);
    const b = await login(bob);
    await seedBothConversations(a, b);
    record(ACTOR, PEER, "root to child");
    meshEvents.record({ kind: "actor_spawned", actorId: PEER, detail: "spawned" });

    // The window read spans every actor with no `actors` filter, so it is the
    // obvious way around the actor path's scoping if it goes unscoped.
    const window = "2000-01-01T00:00:00.000Z";
    const feed = await getJson<WindowPage>(`/api/mesh/events?since=${window}`, a.cookie);
    expect(feed.status).toBe(200);
    const bodies = feed.body.events.map((e) => e.body);
    expect(bodies).toContain("alice asks");
    expect(bodies).toContain("reply to alice");
    expect(bodies).toContain("root to child");
    expect(feed.body.events.map((e) => e.kind)).toContain("actor_spawned");
    expect(bodies).not.toContain("bob asks");
    expect(bodies).not.toContain("reply to bob");
    // Not merely body-redacted: bob's message events are not in the window at
    // all, so nothing says he talks to this actor or how often.
    expect(JSON.stringify(feed.body)).not.toContain(b.id);

    // And the same window read is bob's own conversation for bob.
    const bobFeed = await getJson<WindowPage>(`/api/mesh/events?since=${window}`, b.cookie);
    expect(bobFeed.body.events.map((e) => e.body)).toContain("bob asks");
    expect(JSON.stringify(bobFeed.body)).not.toContain(a.id);
  });

  it("keeps a legacy message event with no mesh_chat row out of another human's feed", async () => {
    const a = await login(alice);
    const b = await login(bob);
    // Rows that pre-date mesh_chat keep their body in mesh_events and name
    // their peer only through the event itself: the subject, or a payload
    // peer with no messageId to join on.
    meshEvents.record({
      kind: "message_received",
      actorId: ACTOR,
      detail: "s",
      body: "legacy from bob",
      payload: JSON.stringify({ from: b.id }),
    });
    meshEvents.record({
      kind: "message_sent",
      actorId: ACTOR,
      detail: "s",
      body: "legacy to alice",
      payload: JSON.stringify({ to: a.id }),
    });
    meshEvents.record({
      kind: "message_received",
      actorId: ACTOR,
      detail: "s",
      body: "legacy from peer",
      payload: null,
    });
    // A backfilled row whose mesh_chat row is gone names nobody and, as
    // before, resolves no body from anywhere.
    meshEvents.record({
      kind: "message_sent",
      actorId: ACTOR,
      detail: "s",
      body: "legacy unpaired",
      payload: JSON.stringify({ messageId: "gone" }),
    });

    const aliceFeed = await getJson<EventPage>(`/api/mesh/events?actors=${ACTOR}`, a.cookie);
    expect(aliceFeed.body.events.map((e) => e.body).sort()).toEqual([
      "legacy from peer",
      "legacy to alice",
      null,
    ]);
    expect(JSON.stringify(aliceFeed.body)).not.toContain(b.id);
    expect(JSON.stringify(aliceFeed.body)).not.toContain("legacy unpaired");
    const bobFeed = await getJson<EventPage>(`/api/mesh/events?actors=${ACTOR}`, b.cookie);
    expect(bobFeed.body.events.map((e) => e.body).sort()).toEqual([
      "legacy from bob",
      "legacy from peer",
      null,
    ]);
    expect(JSON.stringify(bobFeed.body)).not.toContain(a.id);
  });

  it("hides another human's cited message on an obligation without hiding the citation", async () => {
    const a = await login(alice);
    const b = await login(bob);
    const fromAlice = record(a.id, ACTOR, "alice decided it");
    const fromBob = record(b.id, ACTOR, "bob decided it");
    const fromPeer = record(PEER, ACTOR, "child reported in");
    const obligation = obligations.create({ ownerId: ACTOR, title: "Shared work" });
    for (const messageId of [fromAlice, fromBob, fromPeer]) {
      obligations.attachArtifact(obligation.id, `mesh:messages/${messageId}`);
    }

    const detail = await getJson<ObligationDetail>(
      `/api/mesh/obligations/${obligation.id}`,
      a.cookie
    );
    expect(detail.status).toBe(200);
    const cited = new Map(detail.body.artifacts.map((e) => [e.artifact.ref, e.reference]));
    expect(cited.get(`mesh:messages/${fromAlice}`)?.body).toBe("alice decided it");
    // Actor↔actor citations are shared mesh visibility, as before.
    expect(cited.get(`mesh:messages/${fromPeer}`)?.body).toBe("child reported in");
    // Bob's citation is still listed — the obligation's own record of what
    // settled it — but says nothing about whose conversation it was.
    const hidden = cited.get(`mesh:messages/${fromBob}`);
    expect(hidden).toBeDefined();
    expect(hidden).toMatchObject({
      body: null,
      author: null,
      timestamp: null,
      title: "Mesh chat",
    });
    expect(hidden?.unavailable).not.toBeNull();
    expect(hidden?.entity).toBeUndefined();
    const serialized = JSON.stringify(detail.body);
    expect(serialized).not.toContain("bob decided it");
    expect(serialized).not.toContain(b.id);

    // The same obligation is bob's own citation for bob.
    const bobDetail = await getJson<ObligationDetail>(
      `/api/mesh/obligations/${obligation.id}`,
      b.cookie
    );
    const bobCited = new Map(bobDetail.body.artifacts.map((e) => [e.artifact.ref, e.reference]));
    expect(bobCited.get(`mesh:messages/${fromBob}`)?.body).toBe("bob decided it");
    expect(bobCited.get(`mesh:messages/${fromAlice}`)?.body).toBeNull();
    expect(JSON.stringify(bobDetail.body)).not.toContain(a.id);
  });

  it("omits another human's message from the actor's inbox and thread projections", async () => {
    const a = await login(alice);
    const b = await login(bob);
    await seedBothConversations(a, b);

    const page = await getJson<InboxPage>(`/api/mesh/inbox?actor=${ACTOR}&status=all`, a.cookie);
    expect(page.status).toBe(200);
    // Not a redacted placeholder: nothing says who else talks to this actor
    // or how often.
    expect(page.body.entries).toHaveLength(1);
    expect(page.body.entries[0].payload.fromId).toBe(a.id);
    expect(page.body.entries[0].payload.content).toBe("alice asks");
    expect(page.body.entries[0].reference?.body).toBe("alice asks");
    const serialized = JSON.stringify(page.body);
    expect(serialized).not.toContain("bob asks");
    expect(serialized).not.toContain(b.id);

    // The queued actor's thread card projects its prioritized item — alice's
    // message, the earliest responsive one — to alice alone. Bob's card shows
    // nothing in that slot: no redacted placeholder and no "+N more" beside it
    // that would still reveal that someone else is talking to this actor.
    const aliceThreads = await getJson<ThreadsPage>("/api/mesh/threads", a.cookie);
    const aliceCard = aliceThreads.body.threads.find((t) => t.id === ACTOR);
    expect(aliceCard?.selectedInboxItem?.payload.fromId).toBe(a.id);
    expect(JSON.stringify(aliceThreads.body)).not.toContain(b.id);
    const bobThreads = await getJson<ThreadsPage>("/api/mesh/threads", b.cookie);
    const bobCard = bobThreads.body.threads.find((t) => t.id === ACTOR);
    expect(bobCard).toBeDefined();
    expect(bobCard?.selectedInboxItem).toBeUndefined();
    expect(bobCard?.moreInboxItemsCount).toBeUndefined();
    expect(JSON.stringify(bobThreads.body)).not.toContain(a.id);
    expect(JSON.stringify(bobThreads.body)).not.toContain("alice asks");
  });

  it("streams live message frames only to the human they belong to", async () => {
    const a = await login(alice);
    // Bob is admitted only after alice's stream is open: the stream must
    // learn about him from the next frame on, not from its opening scope.
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
      const b = await login(bob);
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
