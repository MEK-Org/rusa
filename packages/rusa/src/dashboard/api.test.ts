import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActorMesh } from "../actor/actor-mesh.js";
import { generateHandle } from "../actor/handle-generator.js";
import type { RootChildRequest, RootControlService } from "../actor/root-control.js";
import { InMemoryThreadRegistry, type ThreadRecord } from "../actor/thread-registry.js";
import { readAvatar } from "../avatar/avatars.js";
import { runMigrations } from "../db/migrations/runner.js";
import { InboxRepository } from "../db/repositories/inbox-repository.js";
import { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import { type DashboardDataDeps, handleMeshApiRequest } from "./api.js";
import { MeshEventEmitter } from "./mesh-event-emitter.js";
import { SseHub } from "./sse.js";

class MockReq extends EventEmitter {
  method = "GET";
  headers: Record<string, string> = {};
  url = "";
}

class MockRes extends EventEmitter {
  req: EventEmitter & { headers?: Record<string, string> } = new EventEmitter();
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";
  writes: string[] = [];
  ended = false;
  /** Unstringified, so a compressed body survives for round-tripping. */
  raw: Buffer | undefined;

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headers = headers ?? {};
    return this;
  }
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(body?: string | Buffer): this {
    if (body) {
      this.raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
      this.body += body;
    }
    this.ended = true;
    // A real ServerResponse emits this; without it a caller awaiting a
    // response that lands off the threadpool has nothing to wait on but the
    // clock. See `settled`.
    this.emit("finish");
    return this;
  }
}

function call(
  deps: DashboardDataDeps | null,
  method: string,
  path: string,
  body?: string,
  acceptEncoding?: string
): { handled: boolean; res: MockRes; req: MockReq } {
  const req = new MockReq();
  req.method = method;
  req.url = path;
  const res = new MockRes();
  // Production reads the header off `res.req`; mirror that wiring rather than
  // adding a second path into sendJson that only tests would use.
  if (acceptEncoding !== undefined) res.req.headers = { "accept-encoding": acceptEncoding };
  const url = new URL(path, "http://localhost");
  const handled = handleMeshApiRequest(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    url,
    deps
  );
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit("data", Buffer.from(body));
      req.emit("end");
    });
  }
  return { handled, res, req };
}

function rec(id: string, parentId: string | null, status: "active" | "retired"): ThreadRecord {
  return { id, charter: `charter ${id}`, parentId, status, createdAt: "2026-06-21T00:00:00.000Z" };
}

const UUID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const UUID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const UUID_RETIRED = "rrrrrrrr-0000-4000-8000-000000000003";

describe("handleMeshApiRequest", () => {
  let db: Database.Database;
  let meshEvents: MeshEventRepository;
  let meshChat: MeshChatRepository;
  let inbox: InboxRepository;
  let obligations: ObligationRepository;
  let registry: InMemoryThreadRegistry;
  let deps: DashboardDataDeps;
  let rootSpawns: Array<{ request: unknown; principal: string }>;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    meshEvents = new MeshEventRepository(db);
    meshChat = new MeshChatRepository(db);
    inbox = new InboxRepository(db);
    obligations = new ObligationRepository(db);
    registry = new InMemoryThreadRegistry();
    rootSpawns = [];
    const mockMesh = {
      sendHumanMessage: (toId: string, body: string, sessionId: string) => {
        meshEvents.record({
          kind: "message_sent",
          actorId: toId,
          detail: sessionId,
          body,
          payload: JSON.stringify({ from: HUMAN_OPERATOR, to: toId }),
        });
        return { delivered: true };
      },
    };
    deps = {
      registry,
      meshEvents,
      meshChat,
      inbox,
      obligations,
      sseHub: new SseHub(new MeshEventEmitter()),
      mesh: mockMesh as unknown as ActorMesh,
      rootControl: {
        providers: ["agy", "codex"],
        spawnChild: (request: unknown, principal: string) => {
          rootSpawns.push({ request, principal });
          return UUID_A;
        },
      } as unknown as RootControlService,
    };
  });

  it("ignores non-/api/mesh paths (returns false)", () => {
    const { handled } = call(deps, "GET", "/dashboard");
    expect(handled).toBe(false);
  });

  it("503s every mesh route when no mesh is bound", () => {
    const { handled, res } = call(null, "GET", "/api/mesh/threads");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(503);
  });

  it("405s a non-GET mesh request", () => {
    const { res } = call(deps, "POST", "/api/mesh/threads");
    expect(res.statusCode).toBe(405);
  });

  it("404s an unknown mesh endpoint", () => {
    const { res } = call(deps, "GET", "/api/mesh/nope");
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/mesh/control/options lists configured providers", () => {
    const { res } = call(deps, "GET", "/api/mesh/control/options");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ providers: ["agy", "codex"] });
  });

  it("POST /api/mesh/actors delegates a root child spawn to the human principal", async () => {
    const { res } = call(
      deps,
      "POST",
      "/api/mesh/actors",
      JSON.stringify({
        charter: "Investigate the flaky build",
        provider: "agy",
        model: "gemini-3.5-flash-medium",
        maxRuns: 4,
        title: "Build investigator",
      })
    );
    await new Promise((resolve) => process.nextTick(resolve));
    await new Promise((resolve) => process.nextTick(resolve));

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body)).toEqual({ id: UUID_A });
    expect(rootSpawns).toEqual([
      {
        principal: "human:operator",
        request: {
          charter: "Investigate the flaky build",
          provider: "agy",
          model: "gemini-3.5-flash-medium",
          maxRuns: 4,
          title: "Build investigator",
        },
      },
    ]);
  });

  it("POST /api/mesh/actors forwards a portable context selection ", async () => {
    const { res } = call(
      deps,
      "POST",
      "/api/mesh/actors",
      JSON.stringify({
        charter: "own a small issue",
        provider: "agy",
        model: "gemini-3.5-flash-medium",
        contextMode: "ledger",
      })
    );
    await new Promise((resolve) => process.nextTick(resolve));
    await new Promise((resolve) => process.nextTick(resolve));

    expect(res.statusCode).toBe(201);
    expect(rootSpawns[0]?.request).toMatchObject({
      provider: "agy",
      model: "gemini-3.5-flash-medium",
      context: { type: "portable", mode: "ledger" },
    });
  });

  it("POST /api/mesh/actors 400s an unknown context selection instead of spawning native", async () => {
    // Silently falling back to native is the failure mode that matters here: the
    // operator would get an ordinary actor and believe it was portable.
    const { res } = call(
      deps,
      "POST",
      "/api/mesh/actors",
      JSON.stringify({ charter: "own a small issue", contextMode: "portible" })
    );
    await new Promise((resolve) => process.nextTick(resolve));
    await new Promise((resolve) => process.nextTick(resolve));

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain("unknown context selection");
    expect(rootSpawns).toEqual([]);
  });

  it("POST /api/mesh/actors rejects an empty charter", async () => {
    const control = deps.rootControl;
    deps.rootControl = {
      providers: [],
      spawnChild: () => {
        throw new Error("charter is required");
      },
    } as unknown as RootControlService;
    const { res } = call(deps, "POST", "/api/mesh/actors", JSON.stringify({ charter: "" }));
    await new Promise((resolve) => process.nextTick(resolve));
    await new Promise((resolve) => process.nextTick(resolve));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "charter is required" });
    deps.rootControl = control;
  });

  it("POST /api/mesh/actors rejects missing provider or model ", async () => {
    const control = deps.rootControl;
    deps.rootControl = {
      providers: [],
      spawnChild: (req: RootChildRequest) => {
        if (!req.provider) throw new Error("provider is required");
        if (!req.model) throw new Error("model is required");
        return UUID_A;
      },
    } as unknown as RootControlService;

    const res1 = call(
      deps,
      "POST",
      "/api/mesh/actors",
      JSON.stringify({ charter: "work", model: "claude-sonnet-4-6" })
    ).res;
    await new Promise((resolve) => process.nextTick(resolve));
    await new Promise((resolve) => process.nextTick(resolve));
    expect(res1.statusCode).toBe(400);
    expect(JSON.parse(res1.body)).toEqual({ error: "provider is required" });

    const res2 = call(
      deps,
      "POST",
      "/api/mesh/actors",
      JSON.stringify({ charter: "work", provider: "claude" })
    ).res;
    await new Promise((resolve) => process.nextTick(resolve));
    await new Promise((resolve) => process.nextTick(resolve));
    expect(res2.statusCode).toBe(400);
    expect(JSON.parse(res2.body)).toEqual({ error: "model is required" });

    deps.rootControl = control;
  });

  describe("response compression", () => {
    /** Enough threads that the JSON clears MIN_COMPRESS_BYTES several times over. */
    const seedBulk = (): void => {
      registry.upsert(rec("root", null, "active"));
      for (let i = 0; i < 60; i++) {
        const id = `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`;
        registry.upsert({
          id,
          charter: `charter ${id} `.repeat(40),
          parentId: "root",
          status: "active",
          createdAt: "2026-06-21T00:00:00.000Z",
        });
      }
    };

    /**
     * Wait for the response itself, not for a number of event-loop turns.
     *
     * Compression resolves on the threadpool, so the response lands after the
     * handler returns. Spinning a fixed count of `setImmediate`s to cover that
     * is not a timeout — the turns drain in well under a millisecond, while
     * zlib takes tens of them on a loaded box. That budget held locally and
     * ran out on CI, where it read as `Content-Encoding: undefined` and looked
     * like a negotiation bug rather than a test that stopped waiting.
     */
    const settled = (res: MockRes): Promise<void> =>
      res.ended ? Promise.resolve() : new Promise((resolve) => res.once("finish", () => resolve()));

    it("compresses a large body with brotli, preferring it over gzip", async () => {
      seedBulk();
      const { res } = call(deps, "GET", "/api/mesh/threads", undefined, "gzip, deflate, br");
      await settled(res);

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Encoding"]).toBe("br");
      expect(res.raw).toBeDefined();
      // The bytes are really brotli, and really the same document.
      const decoded = brotliDecompressSync(res.raw as Buffer).toString("utf-8");
      expect(JSON.parse(decoded).threads).toHaveLength(61);
      expect((res.raw as Buffer).byteLength).toBeLessThan(Buffer.byteLength(decoded));
    });

    it("falls back to gzip for a client that does not speak brotli", async () => {
      seedBulk();
      const { res } = call(deps, "GET", "/api/mesh/threads", undefined, "gzip, deflate");
      await settled(res);

      expect(res.headers["Content-Encoding"]).toBe("gzip");
      const decoded = gunzipSync(res.raw as Buffer).toString("utf-8");
      expect(JSON.parse(decoded).threads).toHaveLength(61);
    });

    it("sends a large body uncompressed when the client accepts nothing", async () => {
      seedBulk();
      const { res } = call(deps, "GET", "/api/mesh/threads", undefined, "identity");
      await settled(res);

      expect(res.headers["Content-Encoding"]).toBeUndefined();
      expect(JSON.parse(res.body).threads).toHaveLength(61);
    });

    it("leaves a small body alone even when the client would take brotli", async () => {
      registry.upsert(rec("root", null, "active"));
      const { res } = call(deps, "GET", "/api/mesh/threads", undefined, "br");
      await settled(res);

      // Below the threshold a round trip through the threadpool buys nothing.
      expect(res.headers["Content-Encoding"]).toBeUndefined();
      expect(JSON.parse(res.body).threads).toHaveLength(1);
    });

    it("always varies on Accept-Encoding, including when it did not compress", async () => {
      registry.upsert(rec("root", null, "active"));
      const { res } = call(deps, "GET", "/api/mesh/threads");
      await settled(res);

      // A cache that missed this header could hand a br body to a client that
      // never asked for one.
      expect(res.headers.Vary).toBe("Accept-Encoding");
    });

    it("honours a codec the client explicitly refused with q=0", async () => {
      seedBulk();
      // The case a substring test gets exactly backwards: this header offers
      // gzip and *forbids* brotli, and reading it as "mentions br" ships a
      // body the client said it cannot accept.
      const { res } = call(deps, "GET", "/api/mesh/threads", undefined, "br;q=0, gzip");
      await settled(res);

      expect(res.headers["Content-Encoding"]).toBe("gzip");
      const decoded = gunzipSync(res.raw as Buffer).toString("utf-8");
      expect(JSON.parse(decoded).threads).toHaveLength(61);
    });

    it("sends identity when every codec it can produce is refused", async () => {
      seedBulk();
      const { res } = call(
        deps,
        "GET",
        "/api/mesh/threads",
        undefined,
        "br;q=0, gzip;q=0.0, *;q=0"
      );
      await settled(res);

      expect(res.headers["Content-Encoding"]).toBeUndefined();
      expect(JSON.parse(res.body).threads).toHaveLength(61);
    });

    it("does not read a codec name out of a longer token", async () => {
      seedBulk();
      // `xbr` and `gzipped` are not offers of `br` and `gzip`.
      const { res } = call(deps, "GET", "/api/mesh/threads", undefined, "xbr, gzipped");
      await settled(res);

      expect(res.headers["Content-Encoding"]).toBeUndefined();
      expect(JSON.parse(res.body).threads).toHaveLength(61);
    });

    it("takes the wildcard as permission for a codec the client did not name", async () => {
      seedBulk();
      const { res } = call(deps, "GET", "/api/mesh/threads", undefined, "*");
      await settled(res);

      expect(res.headers["Content-Encoding"]).toBe("br");
      const decoded = brotliDecompressSync(res.raw as Buffer).toString("utf-8");
      expect(JSON.parse(decoded).threads).toHaveLength(61);
    });

    it("lets an explicit refusal beat a permissive wildcard", async () => {
      seedBulk();
      // `*` allows everything unnamed; `br;q=0` names brotli to refuse it.
      const { res } = call(deps, "GET", "/api/mesh/threads", undefined, "*, br;q=0");
      await settled(res);

      expect(res.headers["Content-Encoding"]).toBe("gzip");
      const decoded = gunzipSync(res.raw as Buffer).toString("utf-8");
      expect(JSON.parse(decoded).threads).toHaveLength(61);
    });

    it("keeps a codec whose q is merely low, or unreadable", async () => {
      seedBulk();
      // Only an explicit zero disqualifies. A low q is still a yes, and a
      // malformed one falls back to the spec's default of 1 rather than
      // silently costing the client its compression.
      const { res } = call(
        deps,
        "GET",
        "/api/mesh/threads",
        undefined,
        "br;q=0.01, gzip;q=nonsense"
      );
      await settled(res);

      expect(res.headers["Content-Encoding"]).toBe("br");
      const decoded = brotliDecompressSync(res.raw as Buffer).toString("utf-8");
      expect(JSON.parse(decoded).threads).toHaveLength(61);
    });

    it("reads tokens through whitespace and case the way clients send them", async () => {
      seedBulk();
      const { res } = call(deps, "GET", "/api/mesh/threads", undefined, "  GZIP ;  Q=1.0 ");
      await settled(res);

      expect(res.headers["Content-Encoding"]).toBe("gzip");
      const decoded = gunzipSync(res.raw as Buffer).toString("utf-8");
      expect(JSON.parse(decoded).threads).toHaveLength(61);
    });

    it("does not compress when no request is reachable from the response", async () => {
      seedBulk();
      // MockRes's default `req` carries no headers at all — the shape an
      // embedder's double can have. Negotiation must read that as "no
      // encoding offered" rather than throwing.
      const { res } = call(deps, "GET", "/api/mesh/threads");
      await settled(res);

      expect(res.statusCode).toBe(200);
      expect(res.headers["Content-Encoding"]).toBeUndefined();
      expect(JSON.parse(res.body).threads).toHaveLength(61);
    });
  });

  it("GET /api/mesh/threads lists threads with deterministic handles", () => {
    registry.upsert(rec("root", null, "active"));
    registry.upsert(rec(UUID_A, "root", "active"));
    registry.upsert(rec(UUID_B, "root", "retired"));

    const { res } = call(deps, "GET", "/api/mesh/threads");
    expect(res.statusCode).toBe(200);
    const { threads } = JSON.parse(res.body);
    expect(threads).toHaveLength(3);
    const a = threads.find((t: { id: string }) => t.id === UUID_A);
    expect(a.handle).toBe(generateHandle(UUID_A));
    expect(threads.find((t: { id: string }) => t.id === UUID_B).status).toBe("retired");
  });

  it("GET /api/mesh/threads surfaces one model and does not leak a stale bound-model readback", () => {
    // A registry record that still carries the removed `boundModel` key. The cast is the
    // point, not a workaround: the field is gone from `ThreadRecord`, but the registry is
    // a JSON file loaded with a cast and rewritten whole, so every record written before
    // this change still carries the key on disk. This is that record.
    //
    // It is the shape that produced the old "MODEL DIVERGED" badge — an actor moved off
    // codex, its codex readback outliving the move because nothing ever cleared it. The
    // API must publish the configured model, prefer nothing to it, and expose nothing to
    // compare it against.
    registry.upsert({
      ...rec(UUID_A, "root", "active"),
      provider: "codex",
      model: "gpt-5-codex",
      boundModel: "gpt-5.5",
    } as ThreadRecord);

    const { res } = call(deps, "GET", "/api/mesh/threads");
    expect(res.statusCode).toBe(200);
    const { threads } = JSON.parse(res.body);
    const actor = threads.find((t: { id: string }) => t.id === UUID_A);
    expect(actor.provider).toBe("codex");
    expect(actor.model).toBe("gpt-5-codex");
    expect(actor.requestedModel).toBeUndefined();
    expect(actor.boundModel).toBeUndefined();
  });

  it("GET /api/mesh/threads surfaces pending desiredModel and desiredProvider when staged", () => {
    registry.upsert({
      ...rec(UUID_A, "root", "active"),
      provider: "claude",
      model: "claude-sonnet-5",
      desiredModel: "claude-opus-4-8",
      desiredProvider: "codex",
    });

    const { res } = call(deps, "GET", "/api/mesh/threads");
    expect(res.statusCode).toBe(200);
    const { threads } = JSON.parse(res.body);
    const actor = threads.find((t: { id: string }) => t.id === UUID_A);
    expect(actor.provider).toBe("claude");
    expect(actor.model).toBe("claude-sonnet-5");
    expect(actor.desiredModel).toBe("claude-opus-4-8");
    expect(actor.desiredProvider).toBe("codex");
  });

  it("GET /api/mesh/threads shows the default root handle when no identity is configured", () => {
    registry.upsert({ ...rec("root", null, "active"), isRoot: true });
    const { res } = call(deps, "GET", "/api/mesh/threads");
    const { threads } = JSON.parse(res.body);
    expect(threads.find((t: { id: string }) => t.id === "root").handle).toBe("root-actor");
  });

  it("GET /api/mesh/threads shows the configured root handle, leaving worker handles alone ", () => {
    registry.upsert({ ...rec("root", null, "active"), isRoot: true });
    registry.upsert(rec(UUID_A, "root", "active"));
    const configuredDeps: DashboardDataDeps = {
      ...deps,
      rootIdentity: { id: "root", handle: "ember-familiar" },
    };

    const { res } = call(configuredDeps, "GET", "/api/mesh/threads");
    const { threads } = JSON.parse(res.body);
    expect(threads.find((t: { id: string }) => t.id === "root").handle).toBe("ember-familiar");
    expect(threads.find((t: { id: string }) => t.id === UUID_A).handle).toBe(
      generateHandle(UUID_A)
    );
  });

  it("GET /api/mesh/threads identifies a generated-id root from isRoot", () => {
    registry.upsert({ ...rec(UUID_A, null, "active"), isRoot: true });
    const configuredDeps: DashboardDataDeps = {
      ...deps,
      rootIdentity: { id: UUID_A, handle: "ember-familiar" },
    };

    const { res } = call(configuredDeps, "GET", "/api/mesh/threads");
    const { threads } = JSON.parse(res.body);
    expect(threads.find((t: { id: string }) => t.id === UUID_A).handle).toBe("ember-familiar");
  });

  it("GET /api/mesh/threads maps title and falls back on summarizeCharter", () => {
    registry.upsert({
      id: "root",
      charter: "root charter\nline 2",
      parentId: null,
      status: "active",
      createdAt: "2026-06-21T00:00:00.000Z",
    });
    registry.upsert({
      id: UUID_A,
      charter: "child charter\nline 2",
      title: "Custom Title",
      parentId: "root",
      status: "active",
      createdAt: "2026-06-21T00:00:00.000Z",
    });

    const { res } = call(deps, "GET", "/api/mesh/threads");
    expect(res.statusCode).toBe(200);
    const { threads } = JSON.parse(res.body);
    const root = threads.find((t: { id: string }) => t.id === "root");
    const child = threads.find((t: { id: string }) => t.id === UUID_A);

    expect(root.title).toBe("root charter");
    expect(child.title).toBe("Custom Title");
  });

  it("GET /api/mesh/threads sends a clipped charter preview, not the whole charter", () => {
    // A charter well past the preview budget, with a distinctive tail so the
    // assertion is about the bytes on the wire rather than about a length.
    const long = `${"pursue the objective. ".repeat(60)}TAIL-MARKER`;
    registry.upsert({
      id: UUID_A,
      charter: long,
      parentId: null,
      status: "active",
      createdAt: "2026-06-21T00:00:00.000Z",
    });

    const { res } = call(deps, "GET", "/api/mesh/threads");
    const { threads } = JSON.parse(res.body);
    const dto = threads.find((t: { id: string }) => t.id === UUID_A);

    expect(dto.charter).toBeUndefined();
    expect(dto.charterPreview.startsWith("pursue the objective.")).toBe(true);
    expect(dto.charterPreview.endsWith("\u2026")).toBe(true);
    expect(dto.charterPreview.length).toBeLessThanOrEqual(281);
    // The point of the change: the tail never reaches the client on this route.
    expect(res.body.includes("TAIL-MARKER")).toBe(false);
  });

  it("GET /api/mesh/threads leaves a charter inside the budget exactly as it is", () => {
    registry.upsert({
      id: UUID_A,
      charter: "short charter\nline 2",
      parentId: null,
      status: "active",
      createdAt: "2026-06-21T00:00:00.000Z",
    });

    const { res } = call(deps, "GET", "/api/mesh/threads");
    const { threads } = JSON.parse(res.body);
    const dto = threads.find((t: { id: string }) => t.id === UUID_A);

    // No ellipsis, no trimming: a charter that fits is not a truncated one, and
    // the detail panel must not be told to go fetch a longer version.
    expect(dto.charterPreview).toBe("short charter\nline 2");
  });

  it("GET /api/mesh/threads clips a charter on a character, not a code unit", () => {
    // Emoji are two UTF-16 code units each, so a code-unit slice at 280 lands
    // inside the 140th one and ends the excerpt on half a character.
    registry.upsert({
      id: UUID_A,
      charter: "\u{1F9ED}".repeat(400),
      parentId: null,
      status: "active",
      createdAt: "2026-06-21T00:00:00.000Z",
    });

    const { res } = call(deps, "GET", "/api/mesh/threads");
    const { threads } = JSON.parse(res.body);
    const dto = threads.find((t: { id: string }) => t.id === UUID_A);

    // 280 characters plus the ellipsis, the same budget the test above asserts.
    expect([...dto.charterPreview]).toHaveLength(281);
    expect(dto.charterPreview.endsWith("\u{1F9ED}\u2026")).toBe(true);
    // No lone surrogate: re-encoding is lossless only if every pair survived.
    expect(Buffer.from(dto.charterPreview, "utf8").toString("utf8")).toBe(dto.charterPreview);
  });

  it("GET /api/mesh/threads/charter serves the one actor's full charter", () => {
    const long = `${"pursue the objective. ".repeat(60)}TAIL-MARKER`;
    registry.upsert({
      id: UUID_A,
      charter: long,
      parentId: null,
      status: "active",
      createdAt: "2026-06-21T00:00:00.000Z",
    });

    const { res } = call(deps, "GET", `/api/mesh/threads/charter?id=${UUID_A}`);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: UUID_A, charter: long });
  });

  it("GET /api/mesh/threads/charter 404s for an unknown or missing id", () => {
    registry.upsert(rec(UUID_A, null, "active"));

    const unknown = call(deps, "GET", "/api/mesh/threads/charter?id=nope").res;
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body)).toEqual({ error: "thread not found" });

    // No `id` at all must not fall through to the list route below it.
    const missing = call(deps, "GET", "/api/mesh/threads/charter").res;
    expect(missing.statusCode).toBe(404);
  });

  it("GET /api/mesh/threads reports halted:false and every thread idle by default", () => {
    registry.upsert(rec("root", null, "active"));
    registry.upsert(rec(UUID_A, "root", "active"));

    const { res } = call(deps, "GET", "/api/mesh/threads");
    const body = JSON.parse(res.body);
    expect(body.halted).toBe(false);
    expect(body.threads.every((t: { runState: string }) => t.runState === "idle")).toBe(true);
  });

  it("GET /api/mesh/threads surfaces halt, queued, and running snapshots", () => {
    registry.upsert(rec("root", null, "active"));
    registry.upsert(rec(UUID_A, "root", "active"));
    registry.upsert(rec(UUID_B, "root", "active"));
    deps = {
      ...deps,
      isHalted: () => true,
      runningThreadIds: () => new Set([UUID_A]),
      queuedThreadIds: () => new Set([UUID_B]),
    };

    const { res } = call(deps, "GET", "/api/mesh/threads");
    const body = JSON.parse(res.body);
    expect(body.halted).toBe(true);
    const byId = (id: string) => body.threads.find((t: { id: string }) => t.id === id);
    expect(byId(UUID_A).runState).toBe("running");
    expect(byId(UUID_B).runState).toBe("queued");
    expect(byId("root").runState).toBe("idle");
  });

  it("GET /api/mesh/threads surfaces winding_down when a running actor is yielded", () => {
    registry.upsert(rec("root", null, "active"));
    registry.upsert(rec(UUID_A, "root", "active"));
    deps = {
      ...deps,
      runningThreadIds: () => new Set([UUID_A]),
      isYielded: (id) => id === UUID_A,
    };

    const { res } = call(deps, "GET", "/api/mesh/threads");
    const body = JSON.parse(res.body);
    const byId = (id: string) => body.threads.find((t: { id: string }) => t.id === id);
    expect(byId(UUID_A).runState).toBe("winding_down");
  });

  it("GET /api/mesh/threads exposes lastActiveAt from mesh_events", () => {
    registry.upsert(rec("root", null, "active"));
    registry.upsert(rec(UUID_A, "root", "active"));
    registry.upsert(rec(UUID_B, "root", "retired"));

    meshEvents.record({ kind: "run_start", actorId: UUID_A, ts: "2026-06-21T00:00:00.000Z" });
    meshEvents.record({
      kind: "run_end",
      actorId: UUID_A,
      success: true,
      ts: "2026-06-22T00:00:00.000Z",
    });

    const { res } = call(deps, "GET", "/api/mesh/threads");
    const body = JSON.parse(res.body);
    const byId = (id: string) => body.threads.find((t: { id: string }) => t.id === id);
    expect(byId(UUID_A).lastActiveAt).toBe("2026-06-22T00:00:00.000Z");
    expect(byId(UUID_B).lastActiveAt).toBeNull();
    expect(byId("root").lastActiveAt).toBeNull();
  });

  it("GET /api/mesh/events merges actors newest-first and paginates by rowid", () => {
    meshEvents.record({ kind: "run_start", actorId: UUID_A, detail: "1" });
    meshEvents.record({ kind: "run_start", actorId: UUID_B, detail: "2" });
    meshEvents.record({ kind: "run_end", actorId: UUID_A, success: true, detail: "3" });

    const first = call(deps, "GET", `/api/mesh/events?actors=${UUID_A},${UUID_B}&limit=2`);
    const page1 = JSON.parse(first.res.body);
    expect(page1.events.map((e: { detail: string }) => e.detail)).toEqual(["3", "2"]);
    expect(page1.nextCursor).not.toBeNull();

    const second = call(
      deps,
      "GET",
      `/api/mesh/events?actors=${UUID_A},${UUID_B}&limit=2&before=${page1.nextCursor}`
    );
    expect(JSON.parse(second.res.body).events.map((e: { detail: string }) => e.detail)).toEqual([
      "1",
    ]);
  });

  it("GET /api/mesh/events?since= returns ALL actors, oldest-first, forward (distiller read)", () => {
    meshEvents.record({
      kind: "run_start",
      actorId: UUID_A,
      detail: "old",
      ts: "2026-06-16T00:00:00.000Z",
    });
    meshEvents.record({
      kind: "run_start",
      actorId: UUID_B,
      detail: "in",
      ts: "2026-06-18T00:00:00.000Z",
    });

    const { res } = call(deps, "GET", "/api/mesh/events?since=2026-06-17T00:00:00.000Z");
    const body = JSON.parse(res.body);
    expect(body.events.map((e: { detail: string }) => e.detail)).toEqual(["in"]); // all actors, since-floored
    expect(body.hasMore).toBe(false);
  });

  it("GET /api/mesh/events?since=&until= bounds the window (half-open)", () => {
    meshEvents.record({
      kind: "run_start",
      actorId: UUID_A,
      detail: "in",
      ts: "2026-06-18T00:00:00.000Z",
    });
    meshEvents.record({
      kind: "run_start",
      actorId: UUID_B,
      detail: "edge",
      ts: "2026-06-20T00:00:00.000Z",
    });

    const { res } = call(
      deps,
      "GET",
      "/api/mesh/events?since=2026-06-17T00:00:00.000Z&until=2026-06-20T00:00:00.000Z"
    );
    expect(JSON.parse(res.body).events.map((e: { detail: string }) => e.detail)).toEqual(["in"]);
  });

  it("GET /api/mesh/events?since=&kinds= filters events by kind", () => {
    meshEvents.record({
      kind: "run_start",
      actorId: UUID_A,
      detail: "start",
      ts: "2026-06-18T00:00:00.000Z",
    });
    meshEvents.record({
      kind: "run_yielded",
      actorId: UUID_A,
      detail: "yielded",
      ts: "2026-06-18T00:00:01.000Z",
    });

    const { res } = call(
      deps,
      "GET",
      "/api/mesh/events?since=2026-06-17T00:00:00.000Z&kinds=run_yielded"
    );
    const body = JSON.parse(res.body);
    expect(body.events.map((e: { detail: string }) => e.detail)).toEqual(["yielded"]);
  });

  it("GET /api/mesh/events?since=&order= respects ordering parameter", () => {
    meshEvents.record({
      kind: "run_start",
      actorId: UUID_A,
      detail: "oldest",
      ts: "2026-06-18T00:00:00.000Z",
    });
    meshEvents.record({
      kind: "run_start",
      actorId: UUID_A,
      detail: "newest",
      ts: "2026-06-18T00:00:01.000Z",
    });

    const { res: resAsc } = call(
      deps,
      "GET",
      "/api/mesh/events?since=2026-06-17T00:00:00.000Z&order=asc"
    );
    expect(JSON.parse(resAsc.body).events.map((e: { detail: string }) => e.detail)).toEqual([
      "oldest",
      "newest",
    ]);

    const { res: resDesc } = call(
      deps,
      "GET",
      "/api/mesh/events?since=2026-06-17T00:00:00.000Z&order=desc"
    );
    expect(JSON.parse(resDesc.body).events.map((e: { detail: string }) => e.detail)).toEqual([
      "newest",
      "oldest",
    ]);
  });

  it("GET /api/mesh/events with no actors returns an empty page (never all events)", () => {
    meshEvents.record({ kind: "run_start", actorId: UUID_A });
    const { res } = call(deps, "GET", "/api/mesh/events");
    expect(JSON.parse(res.body)).toEqual({ events: [], nextCursor: null });
  });

  it("GET /api/mesh/inbox resolves a mesh message body into the payload, not its id", () => {
    const messageId = meshChat.record({
      id: "message-for-inbox",
      senderId: "root",
      recipientId: UUID_A,
      body: "Please review the dashboard Inbox tab.",
    });
    inbox.append([
      {
        id: "inbox-entry",
        actorId: UUID_A,
        source: "mesh:root",
        payload: { type: "mesh.message", messageId, fromId: "root" },
      },
    ]);

    const { res } = call(deps, "GET", `/api/mesh/inbox?actor=${UUID_A}&status=all`);
    expect(res.statusCode).toBe(200);
    const entry = JSON.parse(res.body).entries[0];
    expect(entry.payload).toEqual({
      type: "mesh.message",
      fromId: "root",
      content: "Please review the dashboard Inbox tab.",
    });

    // The id is still absent from the payload — content belongs there, not an
    // opaque handle, which is what this test was written to pin. It now appears
    // alongside as a citation: `reference` is the same resolved shape an
    // obligation's artifacts carry, so one widget renders both, and the ref is
    // exactly what an actor cites when closing an obligation on this message.
    expect(JSON.stringify(entry.payload)).not.toContain(messageId);
    expect(entry.reference).toMatchObject({
      ref: `mesh:messages/${messageId}`,
      scheme: "mesh",
      body: "Please review the dashboard Inbox tab.",
    });
  });

  it("GET /api/mesh/inbox preserves a dangling mesh citation and its failure reason", () => {
    inbox.append([
      {
        id: "dangling-inbox-entry",
        actorId: UUID_A,
        source: "mesh:root",
        payload: { type: "mesh.message", messageId: "missing-message", fromId: "root" },
      },
    ]);

    const { res } = call(deps, "GET", `/api/mesh/inbox?actor=${UUID_A}&status=all`);
    const entry = JSON.parse(res.body).entries[0];
    expect(entry.reference).toMatchObject({
      ref: "mesh:messages/missing-message",
      body: null,
      unavailable: "message not found",
    });
  });

  describe("POST /api/mesh/actors/:id/inbox/handled", () => {
    const post = async (actorId: string, body: unknown) => {
      const { res } = call(
        deps,
        "POST",
        `/api/mesh/actors/${actorId}/inbox/handled`,
        JSON.stringify(body)
      );
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
      return res;
    };

    const appendEntry = (id: string, actorId = UUID_A) => {
      inbox.append([{ id, actorId, source: "mesh:root", payload: { type: "mesh.message" } }]);
    };

    it("clears the entry and stops it counting against the actor", async () => {
      appendEntry("stale-entry");
      expect(inbox.countUnhandled(UUID_A)).toBe(1);

      const res = await post(UUID_A, { entryId: "stale-entry", reason: "run cancelled by hand" });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ ok: true, alreadyHandled: false });
      // The point of the feature: the actor is no longer queued for it.
      expect(inbox.countUnhandled(UUID_A)).toBe(0);
      expect(inbox.actorsWithUnhandled().map((a) => a.actorId)).not.toContain(UUID_A);
    });

    it("names the operator in the note, with and without a reason", async () => {
      appendEntry("with-reason");
      appendEntry("without-reason");

      await post(UUID_A, { entryId: "with-reason", reason: "prod sent this to staging" });
      await post(UUID_A, { entryId: "without-reason" });

      const notes = inbox
        .list(UUID_A, { status: "handled" })
        .entries.map((entry) => entry.handledNote);
      // Attribution is unconditional: a note is the only thing distinguishing
      // an operator's dismissal from the actor's own account of its work.
      expect(notes).toContain(
        "Cleared from the dashboard by the operator: prod sent this to staging"
      );
      expect(notes).toContain("Cleared from the dashboard by the operator; no reason given.");
    });

    it("reports a second clear without overwriting the first note", async () => {
      appendEntry("double-clicked");
      await post(UUID_A, { entryId: "double-clicked", reason: "first" });

      const res = await post(UUID_A, { entryId: "double-clicked", reason: "second" });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).alreadyHandled).toBe(true);
      expect(inbox.read(UUID_A, "double-clicked")?.handledNote).toBe(
        "Cleared from the dashboard by the operator: first"
      );
    });

    it("404s an entry belonging to a different actor", async () => {
      appendEntry("owned-by-a", UUID_A);

      const res = await post(UUID_B, { entryId: "owned-by-a" });

      expect(res.statusCode).toBe(404);
      // Still unhandled for its real owner — the wrong actor cannot clear it.
      expect(inbox.countUnhandled(UUID_A)).toBe(1);
    });

    it("rejects a missing entryId and an over-long reason", async () => {
      appendEntry("long-reason");

      expect((await post(UUID_A, {})).statusCode).toBe(400);
      const tooLong = await post(UUID_A, { entryId: "long-reason", reason: "x".repeat(2001) });
      expect(tooLong.statusCode).toBe(400);
      expect(inbox.countUnhandled(UUID_A)).toBe(1);
    });

    it("503s when no inbox is bound", async () => {
      const bound = deps.inbox;
      deps.inbox = undefined;
      const res = await post(UUID_A, { entryId: "anything" });
      deps.inbox = bound;
      expect(res.statusCode).toBe(503);
    });
  });

  it("GET /api/mesh/events filters by kind", () => {
    meshEvents.record({ kind: "run_start", actorId: UUID_A, detail: "s" });
    meshEvents.record({ kind: "message_sent", actorId: UUID_A, detail: "m" });
    const { res } = call(deps, "GET", `/api/mesh/events?actors=${UUID_A}&kinds=message_sent`);
    const page = JSON.parse(res.body);
    expect(page.events.map((e: { kind: string }) => e.kind)).toEqual(["message_sent"]);
  });

  it("GET /api/mesh/events restricts to actor-pair when conversation=true", () => {
    const insertMsg = (id: string, sender: string, recipient: string, detail: string) => {
      db.prepare(
        `INSERT INTO mesh_chat (id, ts, sender_id, recipient_id, body, session_id) VALUES (?, 0, ?, ?, ?, 's1')`
      ).run(id, sender, recipient, detail);
      meshEvents.record({
        kind: "message_sent",
        actorId: recipient,
        detail,
        payload: JSON.stringify({ messageId: id }),
      });
    };
    insertMsg("m1", UUID_B, UUID_A, "B to A");
    insertMsg("m2", UUID_A, UUID_B, "A to B");
    insertMsg("m3", "UUID_C", UUID_A, "C to A");
    insertMsg("m4", UUID_B, "UUID_D", "B to D");

    const { res } = call(
      deps,
      "GET",
      `/api/mesh/events?actors=${UUID_A},${UUID_B}&kinds=message_sent&conversation=true`
    );
    const page = JSON.parse(res.body);
    const details = page.events.map((e: { detail: string }) => e.detail);
    expect(details).toContain("B to A");
    expect(details).toContain("A to B");
    expect(details).not.toContain("C to A");
    expect(details).not.toContain("B to D");
    expect(page.events.length).toBe(2);
  });

  it("GET /api/mesh/stream opens an SSE connection", () => {
    const { res } = call(deps, "GET", `/api/mesh/stream?actors=${UUID_A}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toContain("text/event-stream");
    expect(deps.sseHub.connectionCount).toBe(1);
  });

  it("GET /api/mesh/avatar/root.jpg serves the bundled root image", () => {
    const { res } = call(deps, "GET", "/api/mesh/avatar/root.jpg");
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("image/png");
  });

  it("GET /api/mesh/avatar/<id>.png 404s when nothing is cached yet", () => {
    const { res } = call(deps, "GET", `/api/mesh/avatar/${UUID_A}.png`);
    expect(res.statusCode).toBe(404);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("serves avatars even with no mesh bound (filesystem-backed, deps=null)", () => {
    const { handled, res } = call(null, "GET", "/api/mesh/avatar/root.jpg");
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("rejects avatar keys that try to traverse the filesystem", () => {
    const { res } = call(deps, "GET", "/api/mesh/avatar/..%2f..%2fetc%2fpasswd.png");
    expect(res.statusCode).toBe(404);
  });

  it("GET /api/mesh/avatar/<configured-handle> still serves the root image ", () => {
    const configuredDeps: DashboardDataDeps = {
      ...deps,
      rootIdentity: { handle: "ember-familiar" },
    };
    const { res } = call(configuredDeps, "GET", "/api/mesh/avatar/ember-familiar.jpg");
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("image/png");
  });

  describe("POST /api/mesh/actors/:id/chat", () => {
    beforeEach(() => {
      registry.upsert(rec(UUID_A, null, "active"));
      registry.upsert(rec(UUID_B, null, "retired"));
    });

    it("sends human message, returns 200, and records human:operator event", async () => {
      const { res } = call(
        deps,
        "POST",
        `/api/mesh/actors/${UUID_A}/chat`,
        JSON.stringify({ body: "hello actor", sessionId: "test-sess-123" })
      );

      // wait for process.nextTick / body reading
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true });

      const page = meshEvents.listEventsByActors([UUID_A], { limit: 10 });
      expect(page.events).toHaveLength(1);
      expect(page.events[0].actorId).toBe(UUID_A);
      expect(page.events[0].detail).toBe("test-sess-123");
      expect(page.events[0].body).toBe("hello actor");
    });

    it("404s if actor is not found", () => {
      const { res } = call(
        deps,
        "POST",
        "/api/mesh/actors/does-not-exist/chat",
        JSON.stringify({ body: "hello" })
      );
      expect(res.statusCode).toBe(404);
    });

    it("400s if actor is retired and marks chatDisabled: true", () => {
      const { res } = call(
        deps,
        "POST",
        `/api/mesh/actors/${UUID_B}/chat`,
        JSON.stringify({ body: "hello" })
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toEqual({ error: "actor is retired", chatDisabled: true });
    });

    it("surfaces chatDisabled state on GET /api/mesh/threads", () => {
      const { res } = call(deps, "GET", "/api/mesh/threads");
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      const threadA = data.threads.find((t: { id: string }) => t.id === UUID_A);
      const threadB = data.threads.find((t: { id: string }) => t.id === UUID_B);
      expect(threadA.chatDisabled).toBe(false);
      expect(threadB.chatDisabled).toBe(true);
    });
  });

  describe("POST /api/mesh/avatar/<id> and /generate ", () => {
    let home: string;
    let prevHome: string | undefined;

    beforeEach(() => {
      prevHome = process.env.RUSA_HOME;
      home = mkdtempSync(join(tmpdir(), "mc-api-avatars-"));
      process.env.RUSA_HOME = home;
    });

    afterEach(() => {
      if (prevHome === undefined) delete process.env.RUSA_HOME;
      else process.env.RUSA_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    });

    // The 8-byte PNG signature, plus a payload — `uploadAvatar` verifies the
    // signature on the decoded bytes, so a bare 4-byte prefix no longer passes.
    const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pngBytes = Buffer.concat([PNG_SIG, Buffer.from("test-payload")]);
    const pngBase64 = pngBytes.toString("base64");

    it("uploads and caches a valid image, servable via GET afterward", async () => {
      const { res } = call(
        deps,
        "POST",
        `/api/mesh/avatar/${UUID_A}`,
        JSON.stringify({ imageBase64: pngBase64, contentType: "image/png" })
      );
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));

      expect(res.statusCode).toBe(200);
      expect(readAvatar(UUID_A)?.body.equals(pngBytes)).toBe(true);

      const getRes = call(deps, "GET", `/api/mesh/avatar/${UUID_A}.png`);
      expect(getRes.res.statusCode).toBe(200);
    });

    it("ALWAYS overwrites an existing cached avatar (explicit user action)", async () => {
      call(
        deps,
        "POST",
        `/api/mesh/avatar/${UUID_A}`,
        JSON.stringify({ imageBase64: pngBase64, contentType: "image/png" })
      );
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));

      const secondBytes = Buffer.concat([PNG_SIG, Buffer.from("second-upload")]);
      const secondBase64 = secondBytes.toString("base64");
      const { res } = call(
        deps,
        "POST",
        `/api/mesh/avatar/${UUID_A}`,
        JSON.stringify({ imageBase64: secondBase64, contentType: "image/png" })
      );
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));

      expect(res.statusCode).toBe(200);
      expect(readAvatar(UUID_A)?.body.equals(secondBytes)).toBe(true);
    });

    it("rejects an unsupported content-type", async () => {
      const { res } = call(
        deps,
        "POST",
        `/api/mesh/avatar/${UUID_A}`,
        JSON.stringify({ imageBase64: pngBase64, contentType: "image/gif" })
      );
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
      expect(res.statusCode).toBe(400);
      expect(readAvatar(UUID_A)).toBeNull();
    });

    it("rejects image/jpeg — the cache and serve paths are PNG-only", async () => {
      const { res } = call(
        deps,
        "POST",
        `/api/mesh/avatar/${UUID_A}`,
        JSON.stringify({ imageBase64: pngBase64, contentType: "image/jpeg" })
      );
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
      expect(res.statusCode).toBe(400);
      expect(readAvatar(UUID_A)).toBeNull();
    });

    it("rejects imageBase64 that decodes to bytes without a PNG signature, even with contentType: image/png", async () => {
      const notPng = Buffer.from("definitely-not-a-png").toString("base64");
      const { res } = call(
        deps,
        "POST",
        `/api/mesh/avatar/${UUID_A}`,
        JSON.stringify({ imageBase64: notPng, contentType: "image/png" })
      );
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/not a valid PNG/);
      expect(readAvatar(UUID_A)).toBeNull();
    });

    it("rejects an oversized image", async () => {
      const oversized = Buffer.alloc(5 * 1024 * 1024 + 1, 1).toString("base64");
      const { res } = call(
        deps,
        "POST",
        `/api/mesh/avatar/${UUID_A}`,
        JSON.stringify({ imageBase64: oversized, contentType: "image/png" })
      );
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
      expect(res.statusCode).toBe(400);
      expect(readAvatar(UUID_A)).toBeNull();
    });

    it("allows uploading an avatar for the root actor", async () => {
      const { res } = call(
        deps,
        "POST",
        "/api/mesh/avatar/root",
        JSON.stringify({ imageBase64: pngBase64, contentType: "image/png" })
      );
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));
      expect(res.statusCode).toBe(200);
      expect(readAvatar("root")?.body.equals(pngBytes)).toBe(true);
    });

    it("serves an upload addressed to a generated root id from the root cache", async () => {
      const generatedRootDeps = {
        ...deps,
        rootIdentity: { id: UUID_B, handle: "ember-familiar" },
      };
      const { res } = call(
        generatedRootDeps,
        "POST",
        `/api/mesh/avatar/${UUID_B}`,
        JSON.stringify({ imageBase64: pngBase64, contentType: "image/png" })
      );
      await new Promise((resolve) => process.nextTick(resolve));
      await new Promise((resolve) => process.nextTick(resolve));

      expect(res.statusCode).toBe(200);
      expect(readAvatar(UUID_B, generatedRootDeps.rootIdentity)?.body.equals(pngBytes)).toBe(true);
      expect(call(generatedRootDeps, "GET", `/api/mesh/avatar/${UUID_B}.png`).res.statusCode).toBe(
        200
      );
    });

    it("503s an upload when rootControl is unavailable", () => {
      const noRootControl = { ...deps, rootControl: undefined };
      const { res } = call(
        noRootControl,
        "POST",
        `/api/mesh/avatar/${UUID_A}`,
        JSON.stringify({ imageBase64: pngBase64, contentType: "image/png" })
      );
      expect(res.statusCode).toBe(503);
    });

    it("503s an upload when deps itself is entirely absent (fail-closed, not just a missing field)", () => {
      const { res } = call(
        null,
        "POST",
        `/api/mesh/avatar/${UUID_A}`,
        JSON.stringify({ imageBase64: pngBase64, contentType: "image/png" })
      );
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe("root control unavailable");
      expect(readAvatar(UUID_A)).toBeNull();
    });

    it("generates on demand and overwrites any existing cache", async () => {
      const generatedBytes = Buffer.concat([PNG_SIG, Buffer.from("generated-payload")]);
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { data: generatedBytes.toString("base64") } }],
              },
            },
          ],
        }),
      } as unknown as Response);

      try {
        const generateDeps: DashboardDataDeps = { ...deps, geminiApiKey: "key" };
        const { res } = call(generateDeps, "POST", `/api/mesh/avatar/${UUID_A}/generate`);
        await new Promise((resolve) => process.nextTick(resolve));
        await new Promise((resolve) => process.nextTick(resolve));

        expect(res.statusCode).toBe(200);
        expect(readAvatar(UUID_A)?.body.equals(generatedBytes)).toBe(true);
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("502s with a generic error and never relays the upstream Gemini response body to the client", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const secret = "sk-super-secret-upstream-token";
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => `internal error, leaked credential: ${secret}`,
      } as unknown as Response);

      try {
        const generateDeps: DashboardDataDeps = { ...deps, geminiApiKey: "key" };
        const { res } = call(generateDeps, "POST", `/api/mesh/avatar/${UUID_A}/generate`);
        await new Promise((resolve) => process.nextTick(resolve));
        await new Promise((resolve) => process.nextTick(resolve));

        expect(res.statusCode).toBe(502);
        expect(res.body).not.toContain(secret);
        expect(JSON.parse(res.body).error).toBe("avatar generation failed");

        // Assert that the sentinel does not appear in the captured console.error mock calls
        expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
        for (const callArgs of errorSpy.mock.calls) {
          const joined = callArgs.map(String).join(" ");
          expect(joined).not.toContain(secret);
        }
      } finally {
        fetchMock.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("502s with a generic error and excludes non-JSON success body (sentinel) from console.error when res.json() throws", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const secret = "sk-super-secret-upstream-token";
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError(`Unexpected token 's', "${secret}"... is not valid JSON`);
        },
      } as unknown as Response);

      try {
        const generateDeps: DashboardDataDeps = { ...deps, geminiApiKey: "key" };
        const { res } = call(generateDeps, "POST", `/api/mesh/avatar/${UUID_A}/generate`);
        await new Promise((resolve) => process.nextTick(resolve));
        await new Promise((resolve) => process.nextTick(resolve));

        expect(res.statusCode).toBe(502);
        expect(res.body).not.toContain(secret);
        expect(JSON.parse(res.body).error).toBe("avatar generation failed");

        // Assert that the sentinel does not appear in the captured console.error mock calls
        expect(errorSpy.mock.calls.length).toBeGreaterThan(0);
        for (const callArgs of errorSpy.mock.calls) {
          const joined = callArgs.map(String).join(" ");
          expect(joined).not.toContain(secret);
        }
      } finally {
        fetchMock.mockRestore();
        errorSpy.mockRestore();
      }
    });

    it("400s generate with a clear error when geminiApiKey is not configured", () => {
      const { res } = call(deps, "POST", `/api/mesh/avatar/${UUID_A}/generate`);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).error).toMatch(/geminiApiKey/);
    });

    it("supports generate for the root id", async () => {
      const generatedBytes = Buffer.concat([PNG_SIG, Buffer.from("root-generated")]);
      const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { data: generatedBytes.toString("base64") } }],
              },
            },
          ],
        }),
      } as unknown as Response);

      try {
        const generateDeps: DashboardDataDeps = { ...deps, geminiApiKey: "key" };
        const { res } = call(generateDeps, "POST", "/api/mesh/avatar/root/generate");
        await new Promise((resolve) => process.nextTick(resolve));
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(200);
        expect(readAvatar("root")?.body.equals(generatedBytes)).toBe(true);
      } finally {
        fetchMock.mockRestore();
      }
    });

    it("503s generate when rootControl is unavailable", () => {
      const noRootControl = { ...deps, rootControl: undefined, geminiApiKey: "key" };
      const { res } = call(noRootControl, "POST", `/api/mesh/avatar/${UUID_A}/generate`);
      expect(res.statusCode).toBe(503);
    });

    it("503s generate when deps itself is entirely absent (fail-closed, not just a missing field)", () => {
      const { res } = call(null, "POST", `/api/mesh/avatar/${UUID_A}/generate`);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body).error).toBe("root control unavailable");
    });
  });

  describe("POST /api/mesh/actors/:id/interrupt ", () => {
    it("calls mesh.interrupt and returns 200 with result", async () => {
      registry.upsert(rec(UUID_A, "root", "active"));
      const interruptMock = vi.fn().mockReturnValue({ interrupted: true });
      const meshDeps: DashboardDataDeps = {
        ...deps,
        mesh: { interrupt: interruptMock } as unknown as ActorMesh,
      };

      const { res, req } = call(meshDeps, "POST", `/api/mesh/actors/${UUID_A}/interrupt`);
      req.emit("data", Buffer.from(JSON.stringify({ by: "human:operator" })));
      req.emit("end");
      await new Promise((resolve) => process.nextTick(resolve));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, interrupted: true });
      expect(interruptMock).toHaveBeenCalledWith(UUID_A, "human:operator");
    });

    it("404s when actor does not exist", async () => {
      const meshDeps: DashboardDataDeps = {
        ...deps,
        mesh: { interrupt: vi.fn() } as unknown as ActorMesh,
      };
      const { res } = call(meshDeps, "POST", "/api/mesh/actors/unknown-actor/interrupt");
      expect(res.statusCode).toBe(404);
    });

    it("400s when actor is retired", async () => {
      registry.upsert(rec(UUID_RETIRED, "root", "retired"));
      const meshDeps: DashboardDataDeps = {
        ...deps,
        mesh: { interrupt: vi.fn() } as unknown as ActorMesh,
      };
      const { res } = call(meshDeps, "POST", `/api/mesh/actors/${UUID_RETIRED}/interrupt`);
      expect(res.statusCode).toBe(400);
    });

    it("503s when live mesh is unavailable", async () => {
      const { res } = call(null, "POST", `/api/mesh/actors/${UUID_A}/interrupt`);
      expect(res.statusCode).toBe(503);
    });
  });

  describe("POST /api/mesh/actors/:id/run-now", () => {
    it("calls mesh.runNow and returns 200 with result", async () => {
      registry.upsert(rec(UUID_A, "root", "active"));
      const runNowMock = vi.fn().mockReturnValue({ queued: true });
      const meshDeps: DashboardDataDeps = {
        ...deps,
        mesh: { runNow: runNowMock } as unknown as ActorMesh,
      };

      const { res } = call(meshDeps, "POST", `/api/mesh/actors/${UUID_A}/run-now`);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, queued: true });
      expect(runNowMock).toHaveBeenCalledWith(UUID_A, "human:operator");
    });

    it("404s when actor does not exist", async () => {
      const meshDeps: DashboardDataDeps = {
        ...deps,
        mesh: { runNow: vi.fn() } as unknown as ActorMesh,
      };
      const { res } = call(meshDeps, "POST", "/api/mesh/actors/unknown-actor/run-now");
      expect(res.statusCode).toBe(404);
    });

    it("400s when actor is retired", async () => {
      registry.upsert(rec(UUID_RETIRED, "root", "retired"));
      const meshDeps: DashboardDataDeps = {
        ...deps,
        mesh: { runNow: vi.fn() } as unknown as ActorMesh,
      };
      const { res } = call(meshDeps, "POST", `/api/mesh/actors/${UUID_RETIRED}/run-now`);
      expect(res.statusCode).toBe(400);
    });

    it("503s when live mesh is unavailable", async () => {
      const { res } = call(null, "POST", `/api/mesh/actors/${UUID_A}/run-now`);
      expect(res.statusCode).toBe(503);
    });
  });

  describe("Obligations REST API", () => {
    describe("GET /api/mesh/obligations", () => {
      it("lists obligations with filters and pagination", async () => {
        obligations.create({
          title: "root-1",
          id: "root-1",
          ownerId: "actor-1",
        });
        obligations.create({
          title: "root-2",
          id: "root-2",
          ownerId: "human:operator",
        });
        obligations.create({
          title: "child-1",
          id: "child-1",
          parentId: "root-1",
          ownerId: "actor-1",
        });

        const { res } = call(deps, "GET", "/api/mesh/obligations");
        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.body);
        expect(data.obligations.map((o: { id: string }) => o.id).sort()).toEqual(
          ["child-1", "root-1", "root-2"].sort()
        );
        expect(data.total).toBe(3);

        const { res: filtered } = call(
          deps,
          "GET",
          "/api/mesh/obligations?ownerId=actor-1&rootsOnly=true"
        );
        expect(filtered.statusCode).toBe(200);
        const filteredData = JSON.parse(filtered.body);
        expect(filteredData.obligations.map((o: { id: string }) => o.id)).toEqual(["root-1"]);
      });

      it("400s on invalid status", async () => {
        const { res: badKind } = call(deps, "GET", "/api/mesh/obligations?status=invalid");
        expect(badKind.statusCode).toBe(400);

        const { res: badStatus } = call(deps, "GET", "/api/mesh/obligations?status=invalid");
        expect(badStatus.statusCode).toBe(400);
      });

      it("503s when obligations data is unavailable", async () => {
        const noObligationsDeps = { ...deps, obligations: undefined };
        const { res } = call(noObligationsDeps, "GET", "/api/mesh/obligations");
        expect(res.statusCode).toBe(503);
      });
    });

    describe("GET /api/mesh/obligations/:id", () => {
      it("returns obligation with parent, children, and blockingChildren", async () => {
        obligations.create({
          title: "root-task",
          id: "root-task",
          ownerId: "actor-1",
        });
        obligations.create({
          title: "sub-1",
          id: "sub-1",
          parentId: "root-task",
          ownerId: "actor-2",
        });
        obligations.create({
          title: "sub-2",
          id: "sub-2",
          parentId: "root-task",
          ownerId: "actor-2",
        });
        obligations.setTerminalStatus("sub-1", "done");

        const { res } = call(deps, "GET", "/api/mesh/obligations/root-task");
        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.body);
        expect(data.obligation.id).toBe("root-task");
        expect(data.parent).toBeNull();
        expect(data.children.map((c: { id: string }) => c.id).sort()).toEqual(
          ["sub-1", "sub-2"].sort()
        );
        expect(data.blockingChildren.map((c: { id: string }) => c.id)).toEqual(["sub-2"]);
      });

      it("404s when obligation not found", async () => {
        const { res } = call(deps, "GET", "/api/mesh/obligations/missing-task");
        expect(res.statusCode).toBe(404);
      });
    });

    describe("GET /api/mesh/obligations/:id/tree", () => {
      it("returns complete subtree", async () => {
        obligations.create({
          title: "root-task",
          id: "root-task",
          ownerId: "actor-1",
        });
        obligations.create({
          title: "child-task",
          id: "child-task",
          parentId: "root-task",
          ownerId: "actor-2",
        });

        const { res } = call(deps, "GET", "/api/mesh/obligations/root-task/tree");
        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.body);
        expect(data.obligation.id).toBe("root-task");
        expect(data.children).toHaveLength(1);
        expect(data.children[0].obligation.id).toBe("child-task");
      });

      it("404s when root not found", async () => {
        const { res } = call(deps, "GET", "/api/mesh/obligations/missing-tree/tree");
        expect(res.statusCode).toBe(404);
      });
    });

    describe("POST /api/mesh/obligations", () => {
      it("creates obligation and returns 201", async () => {
        registry.upsert(rec(UUID_A, "root", "active"));
        const body = JSON.stringify({
          ownerId: UUID_A,
          title: "Build feature",
          intent: "build feature",
        });
        const { res } = call(deps, "POST", "/api/mesh/obligations", body);
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(201);
        const data = JSON.parse(res.body);
        expect(data.obligation.ownerId).toBe(UUID_A);
        expect(data.obligation.title).toBe("Build feature");
        expect(data.obligation.intent).toBe("build feature");
        // The dashboard binds the creator from the server's own identity; a
        // null here would be an unrecoverable loss of attribution (#1671).
        expect(data.obligation.creatorId).toBe(HUMAN_OPERATOR);
      });

      it("binds the operator as creator without accepting one from the body", async () => {
        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations",
          JSON.stringify({
            ownerId: HUMAN_OPERATOR,
            title: "Decide",
            creatorId: "actor-impostor",
          })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(201);
        expect(JSON.parse(res.body).obligation.creatorId).toBe(HUMAN_OPERATOR);
      });

      it("returns cited artifacts with mesh chat resolved and other schemes named", async () => {
        registry.upsert(rec(UUID_A, "root", "active"));
        obligations.create({ id: "cited", ownerId: UUID_A, title: "Game Type" });
        const messageId = meshChat.record({
          senderId: HUMAN_OPERATOR,
          recipientId: UUID_A,
          body: "A monster-catching JRPG in a cave.",
        });
        obligations.attachArtifact("cited", `mesh:messages/${messageId}`, {
          label: "the answer",
          attachedBy: UUID_A,
        });
        obligations.attachArtifact("cited", "github:MEK-Org/rusa/issues/33");

        const { res } = call(deps, "GET", "/api/mesh/obligations/cited");
        await new Promise((resolve) => process.nextTick(resolve));
        const artifacts = JSON.parse(res.body).artifacts as Array<{
          artifact: { ref: string; label: string | null };
          reference: { body: string } | null;
        }>;

        expect(artifacts).toHaveLength(2);
        const chat = artifacts.find((a) => a.artifact.ref.startsWith("mesh:"));
        expect(chat?.reference?.body).toBe("A monster-catching JRPG in a cave.");
        expect(chat?.artifact.label).toBe("the answer");
        // v1 resolves mesh chat only. The GitHub citation still comes back with
        // an explicit reason — an unresolvable citation is not an absent one.
        const gh = artifacts.find((a) => a.artifact.ref.startsWith("github:"));
        expect(gh).toBeDefined();
        expect(gh?.reference).toMatchObject({
          scheme: "github",
          unavailable: "not resolved by the synchronous dashboard path",
        });
      });

      it("rejects a create with no title", async () => {
        registry.upsert(rec(UUID_A, "root", "active"));
        for (const body of [
          JSON.stringify({ ownerId: UUID_A, intent: "no heading" }),
          JSON.stringify({ ownerId: UUID_A, title: "   ", intent: "blank heading" }),
        ]) {
          const { res } = call(deps, "POST", "/api/mesh/obligations", body);
          await new Promise((resolve) => process.nextTick(resolve));
          // A node with no heading cannot appear in a call-list, which is the
          // one thing the human-decision contract needs it for.
          expect(res.statusCode).toBe(400);
        }
      });

      it("rejects an owner that is neither a live actor nor the operator", async () => {
        registry.upsert(rec(UUID_RETIRED, "root", "retired"));
        for (const ownerId of ["actor-1", UUID_RETIRED, "system:mesh"]) {
          const { res } = call(
            deps,
            "POST",
            "/api/mesh/obligations",
            JSON.stringify({ ownerId, title: "Typo", intent: "typo" })
          );
          await new Promise((resolve) => process.nextTick(resolve));
          // A typed handle that resolves to nothing must not become live work
          // owned by an id that appears in no queue and wakes nobody.
          expect(res.statusCode).toBe(400);
        }
        expect(obligations.listOwned("actor-1")).toHaveLength(0);
      });

      it("400s on invalid payload", async () => {
        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations",
          JSON.stringify({ ownerId: "   " })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(400);
      });
    });

    describe("POST /api/mesh/obligations/:id/status", () => {
      it("transitions status and returns 200", async () => {
        obligations.create({
          title: "task-1",
          id: "task-1",
          ownerId: "actor-1",
        });

        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations/task-1/status",
          JSON.stringify({ status: "done" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.body);
        expect(data.ok).toBe(true);
        expect(data.obligation.status).toBe("done");
      });

      it("404s when obligation not found", async () => {
        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations/missing-task/status",
          JSON.stringify({ status: "done" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(404);
      });

      it("records the operator's stated reason", async () => {
        obligations.create({
          title: "decide-stack",
          id: "decide-stack",
          ownerId: HUMAN_OPERATOR,
        });

        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations/decide-stack/status",
          JSON.stringify({ status: "done", note: "Flutter. Tooling is already wired here." })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).obligation.terminalNote).toBe(
          "Flutter. Tooling is already wired here."
        );
      });

      it("drops a non-string note rather than coercing it into a reason", async () => {
        obligations.create({
          title: "coerce-me",
          id: "coerce-me",
          ownerId: "actor-1",
        });

        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations/coerce-me/status",
          JSON.stringify({ status: "cancelled", note: { why: "nope" } })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        // "[object Object]" stored as a stated reason is worse than no reason.
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).obligation.terminalNote).toBeNull();
      });
    });

    describe("POST /api/mesh/obligations/:id/external-ref", () => {
      it("links, relinks and unlinks after creation", async () => {
        registry.upsert(rec(UUID_A, "root", "active"));
        obligations.create({ id: "linkable", ownerId: UUID_A, title: "Ship it" });

        const link = call(
          deps,
          "POST",
          "/api/mesh/obligations/linkable/external-ref",
          JSON.stringify({ externalRef: "github:MEK-Org/rusa/issues/33" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(link.res.statusCode).toBe(200);
        expect(JSON.parse(link.res.body).obligation.externalRef.key).toBe(
          "github:MEK-Org/rusa/issues/33"
        );

        // A blank string unlinks, so the UI can clear the field without a
        // separate control.
        const clear = call(
          deps,
          "POST",
          "/api/mesh/obligations/linkable/external-ref",
          JSON.stringify({ externalRef: "  " })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(JSON.parse(clear.res.body).obligation.externalRef).toBeNull();
      });

      it("accepts a repository and rejects a sub-resource", async () => {
        registry.upsert(rec(UUID_A, "root", "active"));
        obligations.create({ id: "repo-level", ownerId: UUID_A, title: "Keep rusa releasable" });

        const ok = call(
          deps,
          "POST",
          "/api/mesh/obligations/repo-level/external-ref",
          JSON.stringify({ externalRef: "github:MEK-Org/rusa" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(ok.res.statusCode).toBe(200);

        const bad = call(
          deps,
          "POST",
          "/api/mesh/obligations/repo-level/external-ref",
          JSON.stringify({ externalRef: "github:MEK-Org/rusa/issues/33/comments/9" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        // The server owns the grammar; its complaint is what the dialog shows.
        expect(bad.res.statusCode).toBe(400);
        expect(JSON.parse(bad.res.body).error).toContain("external ref must name");
      });

      it("lets an explicit camelCase null unlink even when the legacy alias is present", async () => {
        registry.upsert(rec(UUID_A, "root", "active"));
        obligations.create({
          id: "explicit-unlink",
          ownerId: UUID_A,
          title: "Correct the link",
          externalRef: "github:MEK-Org/rusa/issues/33",
        });

        const unlink = call(
          deps,
          "POST",
          "/api/mesh/obligations/explicit-unlink/external-ref",
          JSON.stringify({
            externalRef: null,
            external_ref: "github:MEK-Org/rusa/issues/34",
          })
        );
        await new Promise((resolve) => process.nextTick(resolve));

        expect(unlink.res.statusCode).toBe(200);
        expect(JSON.parse(unlink.res.body).obligation.externalRef).toBeNull();
      });

      it("rejects an omitted ref rather than treating it as an unlink", async () => {
        registry.upsert(rec(UUID_A, "root", "active"));
        obligations.create({
          id: "keep-link",
          ownerId: UUID_A,
          title: "Keep the link",
          externalRef: "github:MEK-Org/rusa",
        });

        const missing = call(
          deps,
          "POST",
          "/api/mesh/obligations/keep-link/external-ref",
          JSON.stringify({})
        );
        await new Promise((resolve) => process.nextTick(resolve));

        expect(missing.res.statusCode).toBe(400);
        expect(JSON.parse(missing.res.body).error).toBe("externalRef is required");
        expect(obligations.require("keep-link").externalRef?.key).toBe("github:MEK-Org/rusa");
      });

      it("404s for an unknown obligation", async () => {
        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations/missing/external-ref",
          JSON.stringify({ externalRef: "github:MEK-Org/rusa" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(404);
      });
    });

    describe("POST /api/mesh/obligations/:id/reorder", () => {
      it("reorders obligation and returns 200", async () => {
        obligations.create({
          title: "first",
          id: "first",
          ownerId: "actor-1",
        });
        obligations.create({
          title: "second",
          id: "second",
          ownerId: "actor-1",
        });

        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations/second/reorder",
          JSON.stringify({ nextId: "first" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.body);
        expect(data.ok).toBe(true);

        const ready = obligations.listOwned("actor-1", { status: "ready" });
        expect(ready.map((o) => o.id)).toEqual(["second", "first"]);
      });
    });

    describe("POST /api/mesh/obligations/:id/reparent", () => {
      it("reparents obligation and returns 200", async () => {
        obligations.create({
          title: "p1",
          id: "p1",
          ownerId: "actor-1",
        });
        obligations.create({
          title: "p2",
          id: "p2",
          ownerId: "actor-1",
        });
        obligations.create({
          title: "c1",
          id: "c1",
          parentId: "p1",
          ownerId: "actor-1",
        });

        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations/c1/reparent",
          JSON.stringify({ parentId: "p2" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(200);
        const data = JSON.parse(res.body);
        expect(data.ok).toBe(true);
        expect(data.obligation.parentId).toBe("p2");
      });

      it("400s on self-parenting or cycle", async () => {
        obligations.create({
          title: "task-self",
          id: "task-self",
          ownerId: "actor-1",
        });

        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations/task-self/reparent",
          JSON.stringify({ parentId: "task-self" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(400);
      });
    });

    describe("POST /api/mesh/obligations/:id/reassign", () => {
      it("reassigns an obligation for a trusted operator", async () => {
        obligations.create({
          title: "task-owner",
          id: "task-owner",
          ownerId: "actor-1",
        });
        const { res } = call(
          deps,
          "POST",
          "/api/mesh/obligations/task-owner/reassign",
          JSON.stringify({ ownerId: "human:operator" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).obligation.ownerId).toBe("human:operator");
      });

      it("validates the new owner and returns 404 for missing work", async () => {
        obligations.create({
          title: "task-owner",
          id: "task-owner",
          ownerId: "actor-1",
        });
        // With owner_kind gone the only malformed owner is a blank id; the
        // route must still reject it rather than write an empty owner.
        const invalid = call(
          deps,
          "POST",
          "/api/mesh/obligations/task-owner/reassign",
          JSON.stringify({ ownerId: "   " })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(invalid.res.statusCode).toBe(400);

        const missing = call(
          deps,
          "POST",
          "/api/mesh/obligations/missing/reassign",
          JSON.stringify({ ownerId: "human:operator" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(missing.res.statusCode).toBe(404);

        const unknownOwner = call(
          deps,
          "POST",
          "/api/mesh/obligations/task-owner/reassign",
          JSON.stringify({ ownerId: "actor-typo" })
        );
        await new Promise((resolve) => process.nextTick(resolve));
        expect(unknownOwner.res.statusCode).toBe(400);
        expect(obligations.get("task-owner")?.ownerId).toBe("actor-1");
      });
    });
  });
});
