import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { brotliCompress, gzip, constants as zlibConstants } from "node:zlib";
import type { ActorMesh } from "../actor/actor-mesh.js";
import { resolveContextSelection } from "../actor/context-selection.js";
import { generateHandle } from "../actor/handle-generator.js";
import type { InboxPage, InboxPayload, InboxStore } from "../actor/inbox-store.js";
import type { RootControlService } from "../actor/root-control.js";
import { summarizeCharter } from "../actor/worker-prompt.js";
import {
  generateAvatarForce,
  isRootHandle,
  type RootAvatarIdentity,
  readAvatar,
  uploadAvatar,
} from "../avatar/avatars.js";
import type { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import type { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import type { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import type { Obligation, ObligationStatus } from "../obligations/obligation.js";
import { resolveObligationOwner } from "../obligations/owner.js";
import { type Logger, nullLogger } from "../observability/logger.js";
import type { ProviderModelConfig } from "../providers/model-config.js";
import { resolveReferenceSync } from "../references/resolve.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type { SseHub } from "./sse.js";

/** Everything the mesh Data API needs, injected by the server wiring. */
export interface DashboardDataDeps {
  actors: ActorRepository;
  /** Application logger for route diagnostics. Absent → nothing is logged. */
  logger?: Logger;
  meshEvents: MeshEventRepository;
  meshChat: MeshChatRepository;
  /** Durable obligation repository for task and dependency management. */
  obligations?: ObligationRepository;
  /**
   * Durable actor inbox. Read-only to the dashboard apart from a single write:
   * the operator clearing an entry the actor should not have to answer (#66).
   */
  inbox?: InboxStore;
  sseHub: SseHub;
  /** The live ActorMesh instance. */
  mesh?: ActorMesh;
  /** Root-authorized commands exposed to trusted dashboard operators. */
  rootControl?: RootControlService;
  /**
   * Read-only view of the mesh's emergency-brake state (the HALT sentinel),
   * surfaced as the top-level `halted` flag on `/api/mesh/threads`. Optional:
   * when absent (e.g. a UI-only server) the response reports `halted: false`.
   */
  isHalted?: () => boolean;
  /**
   * Read-only snapshot of both host-scheduler preflights: crontab/crond and
   * `at`/`atrm`/`atd`/`atq`. Surfaced as the top-level `schedulerWarning`
   * field on `/api/mesh/threads`; either facility may be degraded while the
   * service and the unaffected scheduling paths continue to run.
   * Optional; absent or an ok result reports `schedulerWarning: null`.
   */
  schedulerHealth?: () => { ok: boolean; issues: string[] };
  /**
   * Read-only snapshot of the thread ids whose live actor is *genuinely
   * executing a run right now* (between run_start and run_end — i.e. the
   * TriggerRunner's running flag), used to derive each thread's `runState`.
   * Returned as a Set so the threads handler can classify every thread against
   * one synchronous, non-torn snapshot in a single pass. Optional: when absent
   * (e.g. the standalone dashboard with no live mesh) every thread reads `idle`.
   */
  runningThreadIds?: () => Set<string>;
  /** Read-only snapshot of actors waiting for their provider run to start. */
  queuedThreadIds?: () => Set<string>;
  /** Optional yield check for testing runState without full mesh instance. */
  isYielded?: (actorId: string) => boolean;
  /**
   * Read-only, per-lane FIFO snapshots from every live `ProviderPacer`,
   * flattened across lanes. `position` is 0-based within its own provider
   * lane (not globally comparable across lanes); `estimatedStartAt` is an
   * ISO-8601 projection or `null` when it can't be honestly quoted yet —
   * see `ProviderPacer.getQueueSnapshot` for the full contract this mirrors.
   */
  providerQueueSnapshots?: () => Array<{
    threadId: string;
    position: number;
    estimatedStartAt: string | null;
  }>;
  /**
   * Current selected obligation for an actor's active run. This is a
   * projection of the durable inbox focus, not a second selection model; it
   * returns null as soon as the run that selected it completes.
   */
  selectedObligationForActor?: (actorId: string) => Obligation | null;
  /**
   * This instance's configured root identity  — the resolved display
   * handle and avatar override, if `rootActor.handle`/`rootActor.avatar` are
   * set in config. Optional: absent (or fields unset) reproduces today's
   * default (`root-actor`, the bundled image) everywhere it's read.
   */
  rootIdentity?: RootAvatarIdentity;
  /**
   * Gemini API key (`config.geminiApiKey`), threaded through so the dashboard's
   * on-demand avatar-generate route can call the same Gemini image API the
   * spawn-time avatar generation uses. Optional: absent → the generate route
   * 400s with a message telling the operator to configure it.
   */
  geminiApiKey?: string;
  referenceCache?: import("../references/cache-service.js").ReferenceCacheService;
  chatClient?: import("../chat/types.js").ChatClient;
  issueClient?: import("../references/resolve.js").ReferenceResolverDeps["issueClient"];
}

/** Route prefix for the per-actor avatar endpoint . */
const AVATAR_PREFIX = "/api/mesh/avatar/";

/**
 * Extract the avatar lookup key from `/api/mesh/avatar/<key>.(png|jpg)`: strip
 * the prefix, decode, drop the extension, and reject anything with a path
 * separator or `..` (the key is a flat handle or thread id, never a path).
 */
function avatarKeyFromPath(pathname: string): string | null {
  let key: string;
  try {
    key = decodeURIComponent(pathname.slice(AVATAR_PREFIX.length));
  } catch {
    return null; // malformed percent-encoding
  }
  key = key.replace(/\.(png|jpg|jpeg)$/i, "");
  if (!key || key.includes("/") || key.includes("\\") || key.includes("..")) return null;
  return key;
}

/**
 * Decode + validate the `<id>` path segment for the avatar POST routes
 * (upload, generate). Same traversal guard as {@link avatarKeyFromPath}, minus
 * the GET route's file-extension stripping — these routes address the id
 * directly, with no `.png`/`.jpg` suffix in the URL.
 */
function parseAvatarId(raw: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null; // malformed percent-encoding
  }
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  return id;
}

/** Upper bounds so a crafted query can't ask for an unbounded scan/result. */
const MAX_LIMIT = 200;
const MAX_ACTORS = 200;
const DEFAULT_LIMIT = 50;
/** Cap on a manually-uploaded avatar's decoded byte size (5 MB). */
const MAX_AVATAR_UPLOAD_BYTES = 5 * 1024 * 1024;
/**
 * How much of a charter the actor list carries. The list is a tree of handles
 * with a two-line excerpt under each; the full text only ever renders in the
 * detail panel, one actor at a time. Sending all of it made `charter` far and
 * away the largest thing in the response — one multi-kilobyte field per actor,
 * assembled and serialised on every poll to satisfy a view that clips it. The
 * measurement is on #104, where it can be restated as the mesh grows rather
 * than going stale in a comment.
 */
const CHARTER_PREVIEW_CHARS = 280;

/** The leading slice of `charter` the list view can actually show. */
function charterPreview(charter: string): string {
  // By code point, not by UTF-16 code unit: charters contain emoji, and a
  // `slice` that lands mid-surrogate-pair ends the excerpt on a broken glyph.
  const points = [...charter];
  if (points.length <= CHARTER_PREVIEW_CHARS) return charter;
  return `${points.slice(0, CHARTER_PREVIEW_CHARS).join("").trimEnd()}\u2026`;
}

/** A thread as the dashboard tree consumes it: handle up front, UUID for detail. */
interface ThreadDto {
  id: string;
  handle: string;
  parentId: string | null;
  status: string;
  /** The declared candidate pool's first (or only) entry — compat view of {@link modelConfig}. */
  provider: string | null;
  /** The single authoritative model for this actor, as configured in the registry. */
  model: string | null;
  /** Explicit provider-native reasoning level, or null for provider default. */
  effort: string | null;
  /** Pending desired model staged for next run boundary, or null if none. */
  desiredModel?: string | null;
  /** Pending effort pin; null is also the provider-default state. */
  desiredEffort?: string | null;
  /** Pending desired provider staged for next run boundary, or null if none. */
  desiredProvider?: string | null;
  /** The declared candidate pool, in earliest-available order. */
  modelConfig: ProviderModelConfig[];
  /** Pending full-pool replacement staged for the next run boundary, if any. */
  desiredModelConfig?: ProviderModelConfig[];
  /**
   * The reserved candidate for a genuinely queued run, or null when idle/running
   * or nothing has been reserved yet. `selectedProvider` is the declared alias;
   * `selectedLane` is the canonical pacing lane it resolves to — kept distinct
   * so a configured alias is never silently overwritten by its lane.
   */
  selectedProvider?: string | null;
  selectedLane?: string | null;
  selectedModel?: string | null;
  selectedEffort?: string | null;
  /** Epoch-ms quote for when the reserved candidate becomes eligible to start. */
  eligibleAt?: number | null;
  /** The active run's selected inbox-focus obligation, when one exists. */
  selectedObligation?: Obligation;
  /**
   * The leading `CHARTER_PREVIEW_CHARS` characters of the charter, ellipsised
   * when clipped. The full text is detail data: `GET
   * /api/mesh/threads/charter?id=<threadId>`.
   */
  charterPreview: string;
  title: string;
  createdAt: string;
  /**
   * Whether this thread's actor is executing a run at the moment the response is
   * built. Server-side truth so the client can seed its dots correctly on a cold
   * load (before any live `mesh_event` arrives), rather than guessing "active".
   */
  runState: "running" | "queued" | "winding_down" | "idle";
  chatDisabled: boolean;
  /** ISO-8601 timestamp of the actor's most recent mesh event, or null if none. */
  lastActiveAt: string | null;
  /**
   * 0-based position within this actor's provider lane, or `null` when the
   * actor isn't in a provider queue right now. Not comparable across
   * different provider lanes — only meaningful relative to other actors on
   * the same lane.
   */
  queuePosition?: number | null;
  /**
   * ISO-8601 estimate of when this actor's provider run will start, or
   * `null` when the estimate can't be honestly quoted yet (see
   * `ProviderPacer.getQueueSnapshot`). Recomputed on every request from
   * live pacer state — never persisted, and shifts as pacing changes.
   */
  estimatedStartAt?: string | null;
}

/**
 * Ceiling on the operator's own words when clearing an inbox entry, matching
 * the ceiling `mark_handled` applies to an actor's note. The attribution
 * prefix is added on top and is not spent from this budget.
 */
const MAX_INBOX_REASON_CHARS = 2_000;

/**
 * The note stored when the operator clears an entry from the dashboard.
 *
 * The dashboard renders a note under "Addressed:" with nothing to say who
 * wrote it, so an operator's dismissal and an actor's account of its own work
 * are indistinguishable once stored. Naming the operator unconditionally —
 * reason given or not — keeps a dismissal from reading as a report of work the
 * actor never did.
 */
function operatorHandledNote(reason: string): string {
  return reason
    ? `Cleared from the dashboard by the operator: ${reason}`
    : "Cleared from the dashboard by the operator; no reason given.";
}

/**
 * Below this, compression costs more than it saves: a round trip through the
 * threadpool to shave a few hundred bytes off a response that already fits in
 * one segment. Most of this file's replies are small errors and acks.
 */
const MIN_COMPRESS_BYTES = 1024;

/**
 * Brotli's quality, chosen by measurement rather than taken from the default.
 *
 * On a 1.86 MB actor list, quality 11 — what `brotliCompress` uses if you say
 * nothing — spends **3654ms** to reach 12.2% of the original. Quality 5 reaches
 * 15.0% in 50ms. The last three points of ratio cost seventy times the CPU, so
 * the default is the one setting this must not accept: it would replace a slow
 * response with a slower one.
 *
 * For reference on the same payload, gzip lands at 19.9% in 32ms — which is why
 * brotli is preferred when offered, and why gzip is a perfectly good fallback.
 */
const BROTLI_QUALITY = 5;

/** The encodings this server can produce, best ratio first. */
const ENCODINGS = ["br", "gzip"] as const;
type Encoding = (typeof ENCODINGS)[number];

/**
 * Pick an encoding the client actually asked for.
 *
 * Splits the header into tokens and reads each one's `q`, rather than testing
 * the raw string for a substring. Both halves of that are load-bearing:
 * `br;q=0, gzip` says *not* brotli, and a substring test reads it as the exact
 * opposite — sending a body the client told us it cannot accept. Token
 * boundaries matter for the same reason: `xbr` is not an offer of brotli.
 *
 * Not a full RFC 9110 parse. It answers one question — may we use this codec —
 * and preference stays ours, best ratio first, rather than being reordered by
 * the client's q-values. That is the part with no correctness stake: picking a
 * client's second choice is a ratio decision, picking one it forbade is a
 * broken response.
 */
function negotiateEncoding(req: IncomingMessage | undefined): Encoding | undefined {
  // `headers` is optional-chained too: a ServerResponse always has a real
  // request behind it in production, but not every embedder's double does.
  const header = req?.headers?.["accept-encoding"];
  const raw = Array.isArray(header) ? header.join(",") : (header ?? "");

  /** Token to q-value. Absent means the client never mentioned it at all. */
  const weights = new Map<string, number>();
  for (const element of raw.split(",")) {
    const [token, ...params] = element.split(";");
    const name = token.trim().toLowerCase();
    if (!name) continue;
    const q = params
      .map((param) => param.trim().toLowerCase())
      .find((param) => param.startsWith("q="))
      ?.slice(2);
    // A malformed q is the spec's default of 1, not a rejection: only an
    // explicit, readable zero should cost a client its compression.
    const weight = q === undefined ? 1 : Number.parseFloat(q);
    weights.set(name, Number.isNaN(weight) ? 1 : weight);
  }

  // `*` covers whatever the client did not name. An absent header names
  // nothing and matches no wildcard, so nothing is acceptable and the body
  // goes out uncompressed — which is the safe reading of silence.
  const wildcard = weights.get("*") ?? 0;
  return ENCODINGS.find((encoding) => (weights.get(encoding) ?? wildcard) > 0);
}

function compress(encoding: Encoding, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (err: Error | null, out: Buffer) => (err ? reject(err) : resolve(out));
    if (encoding === "gzip") {
      gzip(payload, done);
      return;
    }
    brotliCompress(
      payload,
      {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: payload.byteLength,
        },
      },
      done
    );
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf-8");
  // `Vary` regardless of what this particular response did: the header
  // describes the endpoint's behaviour, and omitting it on the uncompressed
  // branch is how an intermediary caches a br body for a client that can't read it.
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
  };

  const encoding =
    payload.byteLength >= MIN_COMPRESS_BYTES ? negotiateEncoding(res.req) : undefined;
  if (!encoding) {
    res.writeHead(status, headers);
    res.end(payload);
    return;
  }

  // Off the event loop: zlib's async form runs on the threadpool, so a 2 MB
  // body costs this request latency and not every concurrent one.
  compress(encoding, payload).then(
    (compressed) => {
      if (res.writableEnded) return;
      res.writeHead(status, { ...headers, "Content-Encoding": encoding });
      res.end(compressed);
    },
    () => {
      // Compression is an optimisation; failing it must not fail the response.
      if (res.writableEnded) return;
      res.writeHead(status, headers);
      res.end(payload);
    }
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Parse a comma-separated `actors` param into a de-duped, capped list. */
function parseActors(url: URL): string[] {
  const raw = url.searchParams.get("actors");
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id) seen.add(id);
    if (seen.size >= MAX_ACTORS) break;
  }
  return [...seen];
}

/** Parse a positive integer query param, or undefined if absent/invalid. */
function parsePositiveInt(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function clampLimit(url: URL): number {
  const requested = parsePositiveInt(url, "limit") ?? DEFAULT_LIMIT;
  return Math.min(requested, MAX_LIMIT);
}

/**
 * Inbox entries intentionally store lightweight pointers. The dashboard is the
 * presentation boundary, so resolve a mesh-message pointer, or a GitHub source
 * (see `deriveGitHubInboxNotification` — its `source` is the exact reference
 * the event was about), here and never leak an opaque id or an unlinked
 * `github:` label into the UI payload.
 *
 * Google Chat sources are deliberately left alone: a chat event's `source` is
 * the containing space (routing granularity), not the specific message, so
 * resolving it here would show the wrong entity. Every other payload keeps
 * its raw JSON, which is the honest rendering until that has a resolver.
 */
async function resolveInboxPage(page: InboxPage, deps: DashboardDataDeps): Promise<InboxPage> {
  const entries = await Promise.all(
    page.entries.map(async (entry) => {
      const { messageId, ...payload } = entry.payload as InboxPayload & {
        messageId?: unknown;
      };
      if (typeof messageId === "string") {
        // `content` is kept as-is so nothing that reads it today regresses;
        // `reference` is the addition, so the dashboard can render an inbox item
        // through the same widget as an obligation's cited artifacts.
        const reference = resolveReferenceSync(`mesh:messages/${messageId}`, {
          meshChat: deps.meshChat,
        });
        return {
          ...entry,
          payload: reference.body !== null ? { ...payload, content: reference.body } : payload,
          reference,
        };
      }
      if (entry.source.startsWith("github:")) {
        // Same cache/resolver an obligation's cited artifacts use, so a
        // GitHub-sourced inbox entry gets the identical rich preview and
        // "open in new tab" link rather than a second rendering path.
        const reference = deps.referenceCache
          ? await deps.referenceCache
              .get(entry.source, deps)
              .catch(() => resolveReferenceSync(entry.source, { meshChat: deps.meshChat }))
          : resolveReferenceSync(entry.source, { meshChat: deps.meshChat });
        return { ...entry, reference };
      }
      return entry;
    })
  );
  return { ...page, entries };
}

function parseKinds(url: URL): string[] | undefined {
  const raw = url.searchParams.get("kinds");
  if (!raw) return undefined;
  const kinds = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return kinds.length > 0 ? kinds : undefined;
}

/**
 * Dispatch a `/api/mesh/*` request. Returns true if it owned the request
 * (responded or took over the socket for SSE), false to let the caller fall
 * through to static asset serving. When `deps` is null (e.g. the e2e UI-only
 * server) every mesh route 503s — the static UI is unaffected.
 */
export async function handleMeshApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: DashboardDataDeps | null
): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith("/api/mesh/")) return false;

  if (req.method === "POST") {
    if (pathname === "/api/mesh/actors") {
      if (!deps?.rootControl) {
        sendJson(res, 503, { error: "root control unavailable" });
        return true;
      }
      readBody(req)
        .then((bodyStr) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            sendJson(res, 400, { error: "Missing or invalid actor parameters" });
            return;
          }
          const body = parsed as Record<string, unknown>;
          try {
            // Portable context  is opt-in per actor: absent means native, so
            // an existing caller that never sends the field keeps the old record.
            const context = resolveContextSelection(body.contextMode, {
              compactionModel:
                typeof body.compactionModel === "string" ? body.compactionModel : undefined,
            });
            const id = deps.rootControl?.spawnChild(
              {
                charter: typeof body.charter === "string" ? body.charter : "",
                modelConfig: {
                  provider: typeof body.provider === "string" ? body.provider : "",
                  model: typeof body.model === "string" ? body.model : "",
                  effort: typeof body.effort === "string" ? body.effort : undefined,
                },
                title: typeof body.title === "string" ? body.title : undefined,
                context,
              },
              "human:operator"
            );
            sendJson(res, 201, { id });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return true;
    }

    const match = pathname.match(/^\/api\/mesh\/actors\/([^/]+)\/chat$/);
    if (match) {
      if (!deps) {
        sendJson(res, 503, { error: "mesh data API unavailable (no live mesh bound)" });
        return true;
      }
      const actorId = match[1];
      const rec = deps.actors.get(actorId);
      if (!rec) {
        sendJson(res, 404, { error: "actor not found" });
        return true;
      }
      if (rec.status === "retired") {
        sendJson(res, 400, { error: "actor is retired", chatDisabled: true });
        return true;
      }

      readBody(req)
        .then((bodyStr) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null) {
            sendJson(res, 400, { error: "Missing or invalid body parameter" });
            return;
          }
          const bodyObj = parsed as Record<string, unknown>;
          if (!bodyObj.body) {
            sendJson(res, 400, { error: "Missing or invalid body parameter" });
            return;
          }
          const body = String(bodyObj.body);
          const sessionId = String(bodyObj.sessionId ?? bodyObj.session_id ?? randomUUID());

          const voice = !!bodyObj.voice;

          if (!deps.mesh) {
            sendJson(res, 500, { error: "ActorMesh instance not bound to deps" });
            return;
          }

          const result = deps.mesh.sendHumanMessage(actorId, body, sessionId, { voice });
          if (result.delivered) {
            sendJson(res, 200, { ok: true });
          } else {
            sendJson(res, 400, { error: "failed to deliver message", status: result.status });
          }
        })
        .catch((err) => {
          sendJson(res, 500, { error: String(err) });
        });
      return true;
    }

    const interruptMatch = pathname.match(/^\/api\/mesh\/actors\/([^/]+)\/interrupt$/);
    if (interruptMatch) {
      if (!deps) {
        sendJson(res, 503, { error: "mesh data API unavailable (no live mesh bound)" });
        return true;
      }
      const actorId = decodeURIComponent(interruptMatch[1]);
      const rec = deps.actors.get(actorId);
      if (!rec) {
        sendJson(res, 404, { error: "actor not found" });
        return true;
      }
      if (rec.status === "retired") {
        sendJson(res, 400, { error: "actor is retired" });
        return true;
      }
      const mesh = deps.mesh;
      if (!mesh) {
        sendJson(res, 500, { error: "ActorMesh instance not bound to deps" });
        return true;
      }
      readBody(req)
        .then((bodyStr) => {
          let by = "human:operator";
          if (bodyStr.trim()) {
            try {
              const parsed = JSON.parse(bodyStr);
              if (parsed && typeof parsed.by === "string" && parsed.by.trim()) {
                by = parsed.by.trim();
              }
            } catch {
              // Ignore body parse errors, default to human:operator
            }
          }
          try {
            const result = mesh.interrupt(actorId, by);
            sendJson(res, 200, {
              ok: true,
              interrupted: result.interrupted,
              status: result.status,
            });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return true;
    }

    const runNowMatch = pathname.match(/^\/api\/mesh\/actors\/([^/]+)\/run-now$/);
    if (runNowMatch) {
      if (!deps) {
        sendJson(res, 503, { error: "mesh data API unavailable (no live mesh bound)" });
        return true;
      }
      const actorId = decodeURIComponent(runNowMatch[1]);
      const rec = deps.actors.get(actorId);
      if (!rec) {
        sendJson(res, 404, { error: "actor not found" });
        return true;
      }
      if (rec.status === "retired") {
        sendJson(res, 400, { error: "actor is retired" });
        return true;
      }
      if (!deps.mesh) {
        sendJson(res, 500, { error: "ActorMesh instance not bound to deps" });
        return true;
      }
      try {
        const result = deps.mesh.runNow(actorId, "human:operator");
        sendJson(res, 200, { ok: true, queued: result.queued });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      return true;
    }

    // POST /api/mesh/actors/<id>/inbox/handled — the operator clears one entry.
    //
    // An entry can outlive the reason it was delivered: the operator cancels a
    // run by hand, or a signal arrives from another instance that was never
    // this actor's to answer. Nothing else retires it — an unhandled entry
    // keeps the actor queued for work it cannot resolve, and the actor's only
    // way out is to burn a run marking something handled it never had to do.
    //
    // Deliberately not the `mark_handled` MCP tool. That gates on entries
    // selected during the run, because handling there is an actor's judgment
    // about its own worklist; an operator is not in a run and has no selection
    // to make. What does carry over is the note, which the store keeps.
    //
    // No registry lookup: unlike interrupt and run-now, this is meaningful for
    // a retired actor — stale entries are exactly what an operator wants to
    // clear — and the (actor, entry) pair is checked by the store anyway.
    const inboxHandledMatch = pathname.match(/^\/api\/mesh\/actors\/([^/]+)\/inbox\/handled$/);
    if (inboxHandledMatch) {
      if (!deps?.inbox) {
        sendJson(res, 503, { error: "inbox data unavailable" });
        return true;
      }
      const inbox = deps.inbox;
      const actorId = decodeURIComponent(inboxHandledMatch[1]);
      readBody(req)
        .then((bodyStr) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            sendJson(res, 400, { error: "Missing or invalid body" });
            return;
          }
          const body = parsed as Record<string, unknown>;
          const entryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
          if (!entryId) {
            sendJson(res, 400, { error: "entryId is required" });
            return;
          }
          const reason = typeof body.reason === "string" ? body.reason.trim() : "";
          if (reason.length > MAX_INBOX_REASON_CHARS) {
            sendJson(res, 400, {
              error: `reason must be ${MAX_INBOX_REASON_CHARS} characters or fewer`,
            });
            return;
          }
          try {
            const [result] = inbox.markHandled(
              actorId,
              [entryId],
              undefined,
              operatorHandledNote(reason)
            );
            // `alreadyHandled` is reported rather than treated as an error: the
            // store leaves an existing note alone, so a double-click cannot
            // overwrite an actor's own account, and the caller's view is simply
            // one refresh behind.
            sendJson(res, 200, {
              ok: true,
              id: result.id,
              handledAt: result.handledAt.toISOString(),
              alreadyHandled: result.alreadyHandled,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sendJson(res, message === "inbox entry not found" ? 404 : 400, { error: message });
          }
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return true;
    }

    // POST /api/mesh/avatar/<id>/generate — on-demand AI generation .
    // Matched BEFORE the plain upload route below since it has an extra path
    // segment the upload regex's `[^/]+$` anchor won't match anyway, but
    // checking it first keeps the two routes visually paired.
    const generateMatch = pathname.match(/^\/api\/mesh\/avatar\/([^/]+)\/generate$/);
    if (generateMatch) {
      if (!deps?.rootControl) {
        sendJson(res, 503, { error: "root control unavailable" });
        return true;
      }
      const id = parseAvatarId(generateMatch[1]);
      if (!id) {
        sendJson(res, 400, { error: "invalid avatar id" });
        return true;
      }
      if (!deps.geminiApiKey) {
        sendJson(res, 400, {
          error: "Set geminiApiKey in config to enable avatar generation",
        });
        return true;
      }
      const targetId = isRootHandle(id, deps.rootIdentity?.handle)
        ? (deps.rootIdentity?.id ?? "root")
        : id;
      generateAvatarForce(targetId, {
        apiKey: deps.geminiApiKey,
        rootHandle: deps.rootIdentity?.handle,
        rootId: deps.rootIdentity?.id,
      })
        .then(() => sendJson(res, 200, { ok: true }))
        .catch((err) => {
          // Never relay raw error responses to the client. Since `callGeminiImage`
          // handles error boundaries to ensure thrown errors are entirely body-free,
          // we can safely log the stable, locally-authored error message server-side
          // for debugging while returning a generic 502 status to the client.
          // Still message-only, never the raw error: `callGeminiImage` promises
          // a locally-authored, body-free message, and passing the Error through
          // would put a provider response body into the record.
          (deps?.logger ?? nullLogger).error("avatar_generate_failed", {
            component: "dashboard-api",
            actorId: targetId,
            reason: err instanceof Error ? err.message : "unknown error",
          });
          sendJson(res, 502, { error: "avatar generation failed" });
        });
      return true;
    }

    // POST /api/mesh/avatar/<id> — manual upload : { imageBase64, contentType }.
    const uploadMatch = pathname.match(/^\/api\/mesh\/avatar\/([^/]+)$/);
    if (uploadMatch) {
      if (!deps?.rootControl) {
        sendJson(res, 503, { error: "root control unavailable" });
        return true;
      }
      const id = parseAvatarId(uploadMatch[1]);
      if (!id) {
        sendJson(res, 400, { error: "invalid avatar id" });
        return true;
      }
      const targetId = isRootHandle(id, deps.rootIdentity?.handle)
        ? (deps.rootIdentity?.id ?? "root")
        : id;
      readBody(req)
        .then((bodyStr) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null) {
            sendJson(res, 400, { error: "Missing or invalid body" });
            return;
          }
          const body = parsed as Record<string, unknown>;
          const contentType = body.contentType;
          // The cache and serve paths (uploadAvatar / readAvatar) are PNG-only, so
          // only image/png is accepted — a client-declared content-type is never
          // trusted on its own; uploadAvatar re-verifies the PNG signature below.
          if (contentType !== "image/png") {
            sendJson(res, 400, {
              error: 'contentType must be "image/png"',
            });
            return;
          }
          if (typeof body.imageBase64 !== "string" || body.imageBase64.length === 0) {
            sendJson(res, 400, { error: "Missing or invalid imageBase64" });
            return;
          }
          const bytes = Buffer.from(body.imageBase64, "base64");
          if (bytes.length === 0) {
            sendJson(res, 400, { error: "imageBase64 did not decode to any bytes" });
            return;
          }
          if (bytes.length > MAX_AVATAR_UPLOAD_BYTES) {
            sendJson(res, 400, {
              error: `image exceeds the ${MAX_AVATAR_UPLOAD_BYTES / (1024 * 1024)}MB upload limit`,
            });
            return;
          }
          try {
            uploadAvatar(targetId, bytes, deps.rootIdentity?.id);
          } catch {
            sendJson(res, 400, { error: "imageBase64 is not a valid PNG image" });
            return;
          }
          sendJson(res, 200, { ok: true });
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return true;
    }

    // POST /api/mesh/obligations — create obligation
    if (pathname === "/api/mesh/obligations") {
      const obligations = deps?.obligations;
      if (!obligations) {
        sendJson(res, 503, { error: "obligations data unavailable" });
        return true;
      }
      readBody(req)
        .then((bodyStr) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            sendJson(res, 400, { error: "Missing or invalid obligation parameters" });
            return;
          }
          const body = parsed as Record<string, unknown>;
          const ownerId = (body.ownerId ?? body.owner_id) as string | undefined;
          if (typeof ownerId !== "string" || !ownerId.trim()) {
            sendJson(res, 400, { error: "ownerId is required" });
            return;
          }
          const rawParentId = body.parentId ?? body.parent_id;
          const parentId = typeof rawParentId === "string" ? rawParentId.trim() : null;
          const title = typeof body.title === "string" ? body.title : "";
          if (!title.trim()) {
            sendJson(res, 400, { error: "title is required" });
            return;
          }
          const intent = typeof body.intent === "string" ? body.intent : null;
          const rawExternalRef = body.externalRef ?? body.external_ref;
          const externalRef = typeof rawExternalRef === "string" ? rawExternalRef.trim() : null;
          const rawPriority = body.priority;
          const priority =
            typeof rawPriority === "number" && Number.isFinite(rawPriority) ? rawPriority : null;

          const owner = resolveObligationOwner(deps.actors, ownerId);
          if (!owner.ok) {
            sendJson(res, 400, { error: owner.error });
            return;
          }

          try {
            const obligation = obligations.create({
              ownerId: owner.ownerId,
              parentId,
              title,
              intent,
              externalRef,
              priority,
              // The dashboard IS the operator, so the creator is bound here from
              // the server's own identity — the same binding the actor MCP does
              // with its actor id and the e2e control server does with this one.
              // Missing it made every dashboard-created obligation
              // creator-unknown, and #1671 forbids recovering that by inference.
              creatorId: HUMAN_OPERATOR,
            });
            sendJson(res, 201, { obligation });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return true;
    }

    // POST /api/mesh/obligations/:id/status — transition status to done or cancelled
    const statusMatch = pathname.match(/^\/api\/mesh\/obligations\/([^/]+)\/status$/);
    if (statusMatch) {
      const obligations = deps?.obligations;
      if (!obligations) {
        sendJson(res, 503, { error: "obligations data unavailable" });
        return true;
      }
      const id = decodeURIComponent(statusMatch[1]);
      readBody(req)
        .then((bodyStr) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            sendJson(res, 400, { error: "Missing or invalid body" });
            return;
          }
          const body = parsed as Record<string, unknown>;
          const status = body.status;
          if (status !== "done" && status !== "cancelled") {
            sendJson(res, 400, { error: "status must be 'done' or 'cancelled'" });
            return;
          }
          // Free prose or nothing. A non-string `note` is dropped rather than
          // coerced: "[object Object]" as a stated reason is worse than none.
          const note = typeof body.note === "string" ? body.note : null;
          const rawResolutionRef = body.resolutionRef ?? body.resolution_ref;
          const resolutionRef =
            typeof rawResolutionRef === "string" && rawResolutionRef.trim()
              ? rawResolutionRef.trim()
              : null;
          const existing = obligations.get(id);
          if (!existing) {
            sendJson(res, 404, { error: "obligation not found" });
            return;
          }
          try {
            const obligation = obligations.setTerminalStatus(id, status, note, resolutionRef);
            sendJson(res, 200, { ok: true, obligation });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return true;
    }

    // POST /api/mesh/obligations/:id/external-ref — link, relink or unlink the
    // issue/PR/repo this obligation is. `externalRef: null` unlinks.
    const externalRefMatch = pathname.match(/^\/api\/mesh\/obligations\/([^/]+)\/external-ref$/);
    if (externalRefMatch) {
      const obligations = deps?.obligations;
      if (!obligations) {
        sendJson(res, 503, { error: "obligations data unavailable" });
        return true;
      }
      const id = decodeURIComponent(externalRefMatch[1]);
      readBody(req)
        .then((bodyStr) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            sendJson(res, 400, { error: "Missing or invalid body" });
            return;
          }
          const body = parsed as Record<string, unknown>;
          if (!Object.hasOwn(body, "externalRef") && !Object.hasOwn(body, "external_ref")) {
            sendJson(res, 400, { error: "externalRef is required" });
            return;
          }
          const raw = Object.hasOwn(body, "externalRef") ? body.externalRef : body.external_ref;
          if (raw !== null && typeof raw !== "string") {
            sendJson(res, 400, { error: "externalRef must be a string or null" });
            return;
          }
          // A blank string means "unlink" rather than "the empty ref", so the
          // UI can clear the field without a separate control.
          const externalRef = raw === null || raw.trim() === "" ? null : raw.trim();
          if (!obligations.get(id)) {
            sendJson(res, 404, { error: "obligation not found" });
            return;
          }
          try {
            sendJson(res, 200, {
              ok: true,
              obligation: obligations.setExternalRef(id, externalRef),
            });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return true;
    }

    // POST /api/mesh/obligations/:id/reorder — reorder within queue
    const reorderMatch = pathname.match(/^\/api\/mesh\/obligations\/([^/]+)\/reorder$/);
    if (reorderMatch) {
      const obligations = deps?.obligations;
      if (!obligations) {
        sendJson(res, 503, { error: "obligations data unavailable" });
        return true;
      }
      const id = decodeURIComponent(reorderMatch[1]);
      readBody(req)
        .then((bodyStr) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            sendJson(res, 400, { error: "Missing or invalid body" });
            return;
          }
          const body = parsed as Record<string, unknown>;
          const rawPreviousId = body.previousId ?? body.previous_id;
          const previousId = typeof rawPreviousId === "string" ? rawPreviousId.trim() : null;
          const rawNextId = body.nextId ?? body.next_id;
          const nextId = typeof rawNextId === "string" ? rawNextId.trim() : null;
          const rawScope = body.scope;
          const scope = rawScope === "self" ? "self" : "subtree";

          const existing = obligations.get(id);
          if (!existing) {
            sendJson(res, 404, { error: "obligation not found" });
            return;
          }
          try {
            const obligation = obligations.movePriorityInternal(id, previousId, nextId, scope);
            sendJson(res, 200, { ok: true, obligation });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return true;
    }

    // POST /api/mesh/obligations/:id/reparent — reparent obligation
    const reparentMatch = pathname.match(/^\/api\/mesh\/obligations\/([^/]+)\/reparent$/);
    if (reparentMatch) {
      const obligations = deps?.obligations;
      if (!obligations) {
        sendJson(res, 503, { error: "obligations data unavailable" });
        return true;
      }
      const id = decodeURIComponent(reparentMatch[1]);
      readBody(req)
        .then((bodyStr) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            sendJson(res, 400, { error: "Missing or invalid body" });
            return;
          }
          const body = parsed as Record<string, unknown>;
          const rawParentId = body.parentId ?? body.parent_id;
          const parentId = typeof rawParentId === "string" ? rawParentId.trim() : null;

          const existing = obligations.get(id);
          if (!existing) {
            sendJson(res, 404, { error: "obligation not found" });
            return;
          }
          try {
            const obligation = obligations.reparent(id, parentId);
            sendJson(res, 200, { ok: true, obligation });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return true;
    }

    // POST /api/mesh/obligations/:id/reassign — trusted operator changes owner
    const reassignMatch = pathname.match(/^\/api\/mesh\/obligations\/([^/]+)\/reassign$/);
    if (reassignMatch) {
      const obligations = deps?.obligations;
      if (!obligations) {
        sendJson(res, 503, { error: "obligations data unavailable" });
        return true;
      }
      const id = decodeURIComponent(reassignMatch[1]);
      readBody(req)
        .then((bodyStr) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(bodyStr);
          } catch {
            sendJson(res, 400, { error: "Invalid JSON body" });
            return;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            sendJson(res, 400, { error: "Missing or invalid body" });
            return;
          }
          const body = parsed as Record<string, unknown>;
          const ownerId = (body.ownerId ?? body.owner_id) as string | undefined;
          if (typeof ownerId !== "string" || !ownerId.trim()) {
            sendJson(res, 400, { error: "ownerId is required" });
            return;
          }
          if (!obligations.get(id)) {
            sendJson(res, 404, { error: "obligation not found" });
            return;
          }
          const owner = resolveObligationOwner(deps.actors, ownerId);
          if (!owner.ok) {
            sendJson(res, 400, { error: owner.error });
            return;
          }
          try {
            const obligation = obligations.reassign(id, owner.ownerId);
            sendJson(res, 200, { ok: true, obligation });
          } catch (err) {
            sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
          }
        })
        .catch((err) => sendJson(res, 500, { error: String(err) }));
      return true;
    }
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  // GET /api/mesh/avatar/<id>.(png|jpg) — the per-actor avatar , keyed by
  // the unique thread id (the root id serves the fixed bundled image).
  // Filesystem-backed and independent of the live mesh, so it's served even when
  // `deps` is null (a UI-only server). 404 when nothing is cached yet so the UI
  // falls back to its placeholder.
  if (pathname.startsWith(AVATAR_PREFIX)) {
    const key = avatarKeyFromPath(pathname);
    const avatar = key ? readAvatar(key, deps?.rootIdentity) : null;
    if (!avatar) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end("avatar not found");
      return true;
    }
    res.writeHead(200, {
      "Content-Type": avatar.contentType,
      // Avatars can change from the bundled default to a generated/uploaded image,
      // and the client resets its cache-busting epoch on every page load. Disable
      // HTTP caching so a freshly generated avatar is never masked by a stale
      // cached default after refresh.
      "Cache-Control": "no-store",
    });
    res.end(avatar.body);
    return true;
  }

  if (!deps) {
    sendJson(res, 503, { error: "mesh data API unavailable (no live mesh bound)" });
    return true;
  }

  const { actors, meshEvents, sseHub } = deps;

  if (pathname === "/api/mesh/control/options") {
    if (!deps.rootControl) {
      sendJson(res, 503, { error: "root control unavailable" });
      return true;
    }
    sendJson(res, 200, { providers: deps.rootControl.providers });
    return true;
  }

  // GET /api/mesh/threads/charter?id=<threadId> — one actor's full charter.
  // The list carries only a preview; this is where the detail panel gets the
  // rest, for the one actor the operator actually opened. Declared before the
  // list route because the dispatcher matches on exact pathname.
  if (pathname === "/api/mesh/threads/charter") {
    const id = url.searchParams.get("id");
    const thread = id ? actors.get(id) : undefined;
    if (!thread) {
      sendJson(res, 404, { error: "thread not found" });
      return true;
    }
    sendJson(res, 200, { id: thread.id, charter: thread.charter });
    return true;
  }

  // GET /api/mesh/threads — every thread (active + retired), handle up front.
  if (pathname === "/api/mesh/threads") {
    const runtime =
      typeof deps.mesh?.runtimeStateSnapshot === "function"
        ? deps.mesh.runtimeStateSnapshot()
        : null;
    // One synchronous snapshot of the running set, classified against every
    // thread in a single pass — no await between reads, so the view can't tear.
    const running = deps.runningThreadIds?.() ?? new Set<string>();
    const queued = deps.queuedThreadIds?.() ?? new Set<string>();
    const providerQueueSnapshots = new Map(
      (deps.providerQueueSnapshots?.() ?? []).map((entry) => [entry.threadId, entry])
    );
    const rootHandle = deps.rootIdentity?.handle ?? generateHandle("root");
    // Aggregate last activity once for all actors; the covering index on
    // mesh_events(actor_id, ts) makes this cheap .
    const lastActiveByActor = meshEvents.latestActivityByActor();

    const threads: ThreadDto[] = actors.list().map((r) => {
      let runState: "running" | "queued" | "winding_down" | "idle" = "idle";
      if (runtime) {
        runState = runtime.states.get(r.id) ?? "idle";
      } else if (running.has(r.id)) {
        runState = deps.isYielded?.(r.id) ? "winding_down" : "running";
      } else if (queued.has(r.id)) {
        runState = "queued";
      }
      const selection = runState === "queued" ? deps.mesh?.getSelection(r.id) : undefined;
      // Durable inbox focus is created only after a run starts. A queued
      // reservation deliberately has no focus from the prior run (or a
      // speculative next one) to project.
      const selectedObligation =
        runState === "running" || runState === "winding_down"
          ? (deps.selectedObligationForActor?.(r.id) ?? null)
          : null;
      return {
        id: r.id,
        handle: r.isRoot === true ? rootHandle : generateHandle(r.id),
        parentId: r.parentId,
        status: r.status,
        provider: r.modelConfig?.[0]?.provider ?? null,
        model: r.modelConfig?.[0]?.model ?? null,
        effort: r.modelConfig?.[0]?.effort ?? null,
        desiredModel: r.desiredModelConfig?.[0]?.model ?? null,
        ...(r.desiredModelConfig !== undefined
          ? { desiredEffort: r.desiredModelConfig[0]?.effort ?? null }
          : {}),
        desiredProvider: r.desiredModelConfig?.[0]?.provider ?? null,
        modelConfig: r.modelConfig ?? [],
        ...(r.desiredModelConfig !== undefined ? { desiredModelConfig: r.desiredModelConfig } : {}),
        charterPreview: charterPreview(r.charter),
        title: r.title ?? summarizeCharter(r.charter),
        createdAt: r.createdAt,
        runState,
        chatDisabled: r.status === "retired",
        lastActiveAt: lastActiveByActor.get(r.id) ?? null,
        queuePosition: providerQueueSnapshots.get(r.id)?.position ?? null,
        estimatedStartAt: providerQueueSnapshots.get(r.id)?.estimatedStartAt ?? null,
        selectedProvider: selection?.provider ?? null,
        selectedLane: selection?.lane ?? null,
        selectedModel: selection?.model ?? null,
        selectedEffort: selection?.effort ?? null,
        eligibleAt: selection?.eligibleAt ?? null,
        ...(selectedObligation ? { selectedObligation } : {}),
      };
    });
    const schedulerHealth = deps.schedulerHealth?.();
    sendJson(res, 200, {
      halted: deps.isHalted?.() ?? false,
      schedulerWarning: schedulerHealth && !schedulerHealth.ok ? schedulerHealth.issues : null,
      runtimeCursor: runtime ? { streamId: runtime.streamId, revision: runtime.revision } : null,
      threads,
    });
    return true;
  }

  // GET /api/mesh/events?actors=&limit=&before=&kinds=&conversation= — merged, newest-first.
  // GET /api/mesh/events?since=<ISO>&until=<ISO>&limit= — ALL actors, oldest-first,
  //   the half-open window [since, until) (until optional; the IU distiller's
  //   mesh_events read, ISSUE_NUM 2a). Takes precedence over the actor/before path.
  if (pathname === "/api/mesh/events") {
    const since = url.searchParams.get("since");
    if (since) {
      const until = url.searchParams.get("until") ?? undefined;
      const kinds = parseKinds(url);
      const rawOrder = url.searchParams.get("order");
      const order = rawOrder === "desc" ? "desc" : "asc";
      sendJson(res, 200, meshEvents.listEventsSince(since, clampLimit(url), until, kinds, order));
      return true;
    }
    const actors = parseActors(url);
    const conversation = url.searchParams.get("conversation") === "true";
    const page = meshEvents.listEventsByActors(actors, {
      limit: clampLimit(url),
      before: parsePositiveInt(url, "before") ?? null,
      kinds: parseKinds(url),
      conversation,
    });
    sendJson(res, 200, page);
    return true;
  }

  // GET /api/mesh/chat?actors=&limit=&before= — direct chat history.
  if (pathname === "/api/mesh/chat") {
    const actors = parseActors(url);
    const page = deps.meshChat.listChatByActors(actors, {
      limit: clampLimit(url),
      before: parsePositiveInt(url, "before") ?? null,
    });
    sendJson(res, 200, page);
    return true;
  }

  // GET /api/mesh/inbox?actor=<id>&status=unhandled|handled|all
  if (pathname === "/api/mesh/inbox") {
    if (!deps.inbox) {
      sendJson(res, 503, { error: "inbox data unavailable" });
      return true;
    }
    const actorId = url.searchParams.get("actor");
    if (!actorId) {
      sendJson(res, 400, { error: "actor is required" });
      return true;
    }
    const status = url.searchParams.get("status");
    if (status && status !== "unhandled" && status !== "handled" && status !== "all") {
      sendJson(res, 400, { error: "invalid status" });
      return true;
    }
    sendJson(
      res,
      200,
      await resolveInboxPage(
        deps.inbox.list(actorId, {
          status: status as "unhandled" | "handled" | "all" | undefined,
          limit: clampLimit(url),
        }),
        deps
      )
    );
    return true;
  }

  // GET /api/mesh/obligations — list obligations
  if (pathname === "/api/mesh/obligations") {
    if (!deps.obligations) {
      sendJson(res, 503, { error: "obligations data unavailable" });
      return true;
    }
    const ownerId =
      url.searchParams.get("ownerId") ?? url.searchParams.get("owner_id") ?? undefined;
    const status = url.searchParams.get("status") ?? undefined;
    const rawRootsOnly = url.searchParams.get("rootsOnly") ?? url.searchParams.get("roots_only");
    const rootsOnly = rawRootsOnly === "true" || rawRootsOnly === "1";
    const limit = clampLimit(url);
    const offset = parsePositiveInt(url, "offset") ?? 0;

    if (status && !["ready", "waiting", "done", "cancelled", "scheduled"].includes(status)) {
      sendJson(res, 400, { error: "invalid status" });
      return true;
    }

    const page = deps.obligations.listPage({
      ownerId,
      status: status as ObligationStatus | undefined,
      rootsOnly,
      limit,
      offset,
    });
    sendJson(res, 200, page);
    return true;
  }

  // GET /api/mesh/obligations/forest — one bounded page of root trees.
  //
  // Replaces the dashboard's former root-page-then-one-tree-request-per-root
  // pattern (#241): that issued N+1 HTTP round trips, and each `/tree` call
  // separately re-derived the root's own fields that the root page had
  // already fetched. This returns the same root page metadata (`total`,
  // `hasMore`) alongside every requested root's full tree in one response,
  // computed by a single bulk repository read.
  //
  // Defaults to excluding quiet terminal roots (done/cancelled, not
  // recurring, no completion history) — a production snapshot showed 48 of
  // 50 returned roots in that state, each still costing a full tree fetch
  // and parse purely to be filtered client-side. `includeTerminalRoots=true`
  // (the Work tab's on-demand "Show Done" reload) restores the unfiltered
  // page.
  if (pathname === "/api/mesh/obligations/forest") {
    if (!deps.obligations) {
      sendJson(res, 503, { error: "obligations data unavailable" });
      return true;
    }
    const limit = clampLimit(url);
    const offset = parsePositiveInt(url, "offset") ?? 0;
    const rawIncludeTerminalRoots =
      url.searchParams.get("includeTerminalRoots") ??
      url.searchParams.get("include_terminal_roots");
    const includeTerminalRoots =
      rawIncludeTerminalRoots === "true" || rawIncludeTerminalRoots === "1";
    const page = deps.obligations.listPage({
      rootsOnly: true,
      excludeQuietTerminalRoots: !includeTerminalRoots,
      limit,
      offset,
    });
    const trees = deps.obligations.getForest(page.obligations.map((obligation) => obligation.id));
    sendJson(res, 200, { trees, total: page.total, hasMore: page.hasMore });
    return true;
  }

  // GET /api/mesh/obligations/:id/tree — subtree hierarchy
  const obligationTreeMatch = pathname.match(/^\/api\/mesh\/obligations\/([^/]+)\/tree$/);
  if (obligationTreeMatch) {
    if (!deps.obligations) {
      sendJson(res, 503, { error: "obligations data unavailable" });
      return true;
    }
    const id = decodeURIComponent(obligationTreeMatch[1]);
    const obligation = deps.obligations.get(id);
    if (!obligation) {
      sendJson(res, 404, { error: "obligation not found" });
      return true;
    }
    try {
      const tree = deps.obligations.getTree(id);
      sendJson(res, 200, tree);
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  // GET /api/mesh/obligations/:id — single obligation with parent + children + blockingChildren
  const obligationMatch = pathname.match(/^\/api\/mesh\/obligations\/([^/]+)$/);
  if (obligationMatch) {
    if (!deps.obligations) {
      sendJson(res, 503, { error: "obligations data unavailable" });
      return true;
    }
    const id = decodeURIComponent(obligationMatch[1]);
    const obligation = deps.obligations.get(id);
    if (!obligation) {
      sendJson(res, 404, { error: "obligation not found" });
      return true;
    }
    const limit = clampLimit(url);
    const offset = parsePositiveInt(url, "offset") ?? 0;
    const completionsOffset = parsePositiveInt(url, "completions_offset") ?? 0;
    const children = deps.obligations.listChildrenPage(id, { limit, offset });
    const blockingChildren = deps.obligations.listChildrenPage(id, {
      limit,
      offset: 0,
      blockingOnly: true,
    });
    const completions = deps.obligations.listCompletionsPage(id, {
      limit,
      offset: completionsOffset,
    });
    const parent = obligation.parentId ? deps.obligations.get(obligation.parentId) : null;
    const artifacts = await Promise.all(
      deps.obligations.listArtifacts(id).map(async (artifact) => ({
        artifact,
        reference: deps.referenceCache
          ? await deps.referenceCache.get(artifact.ref, deps).catch(() => ({
              ...resolveReferenceSync(artifact.ref, { meshChat: deps.meshChat }),
              unavailable: "could not load context",
              cacheState: "unavailable",
            }))
          : resolveReferenceSync(artifact.ref, { meshChat: deps.meshChat }),
      }))
    );
    sendJson(res, 200, {
      obligation,
      parent,
      children: children.obligations,
      blockingChildren: blockingChildren.obligations,
      completions: completions.completions,
      completionsTotal: completions.total,
      completionsHasMore: completions.hasMore,
      artifacts,
    });
    return true;
  }

  // GET /api/mesh/stream?actors= — SSE: all mesh_event, live_output for `actors`.
  if (pathname === "/api/mesh/stream") {
    const actors = parseActors(url);
    sseHub.addConnection(res, actors.length > 0 ? new Set(actors) : null);
    return true;
  }

  sendJson(res, 404, { error: "unknown mesh endpoint" });
  return true;
}
