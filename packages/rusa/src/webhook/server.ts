import { execFileSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ActorMesh } from "../actor/actor-mesh.js";
import type { InboxStore } from "../actor/inbox-store.js";
import type { RootControlService } from "../actor/root-control.js";
import type { ThreadRegistry } from "../actor/thread-registry.js";
import type { DashboardConfig } from "../config/types.js";
import { type DashboardDataDeps, handleMeshApiRequest } from "../dashboard/api.js";
import {
  getDashboardAsset,
  getDashboardAssetDir,
  getDashboardHtml,
  hasDashboardAsset,
} from "../dashboard/assets.js";
import {
  applyBrandingToHtml,
  applyBrandingToManifest,
  resolveDashboardBranding,
} from "../dashboard/branding.js";
import { handleIuReportsApiRequest, type IuReportsApiDeps } from "../dashboard/iu-reports-api.js";
import type { MeshEventEmitter } from "../dashboard/mesh-event-emitter.js";
import { handleQuotaApiRequest, type QuotaApiDeps } from "../dashboard/quota-api.js";
import { SseHub } from "../dashboard/sse.js";
import {
  handleUnderstandingOpsRequest,
  handleUnderstandingStringsRequest,
  type UnderstandingOpsDeps,
} from "../dashboard/understanding-ops-api.js";
import type { MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import type { MeshEventRepository } from "../db/repositories/mesh-event-repository.js";
import type { ObligationRepository } from "../db/repositories/obligation-repository.js";
import { readBuildSentinel } from "../update/build-sentinel.js";
import { handleVoiceApiRequest, type VoiceApiDeps } from "../voice/voice-api.js";
import type { VoiceService } from "../voice/voice-service.js";
import { attachVoiceOutbound } from "../voice/wiring.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const startedAt = new Date().toISOString();

export function resolveDeployedSha(distDirs: string[], getRuntimeSha = () => getGitSha()): string {
  for (const dir of distDirs) {
    const baked = readBuildSentinel(dir);
    if (baked && /^[0-9a-f]{40}$/.test(baked)) {
      return baked;
    }
  }
  const runtime = getRuntimeSha();
  if (runtime && /^[0-9a-f]{40}$/.test(runtime)) {
    return runtime;
  }
  return "unknown";
}

function getGitSha(): string | null {
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      encoding: "utf-8",
    }).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) {
      return sha;
    }
  } catch {
    // Ignore error and fall through
  }
  return null;
}

function getPackageVersion(): string {
  try {
    const paths = [
      join(__dirname, "..", "..", "package.json"),
      join(__dirname, "..", "package.json"),
      join(__dirname, "package.json"),
    ];
    for (const p of paths) {
      try {
        const pkg = JSON.parse(readFileSync(p, "utf-8"));
        if (pkg && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        // continue
      }
    }
  } catch {
    // ignore
  }
  return "unknown";
}

export const deployedSha = resolveDeployedSha([__dirname, join(__dirname, "..")]);
const packageVersion = getPackageVersion();

export interface WebhookServerOptions {
  port: number;
  secret: string;
  onEvent: (
    event: string,
    payload: Record<string, unknown>,
    deliveryId?: string
  ) => void | Promise<void>;
  onNonWebhookRequest?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/**
 * Live mesh references the dashboard Data API reads from. Supplied by the wiring
 * that owns them (`rusa start`'s in-process mesh, or the standalone
 * `dashboard` command). Absent → the `/api/mesh/*` routes 503 and only the
 * static UI is served.
 */
export interface DashboardMeshRefs {
  registry: ThreadRegistry;
  meshEvents: MeshEventRepository;
  meshChat: MeshChatRepository;
  /** Durable obligation repository for task and dependency management. */
  obligations?: ObligationRepository;
  /** Durable actor inbox, exposed read-only through the dashboard data API. */
  inbox?: InboxStore;
  emitter: MeshEventEmitter;
  /** The live ActorMesh instance. */
  mesh?: ActorMesh;
  /** Root-authorized commands for dashboard operator actions. */
  rootControl?: RootControlService;
  /** Read-only emergency-brake state (HALT sentinel) → top-level `halted` flag. */
  isHalted?: () => boolean;
  /** Read-only snapshot of thread ids whose actor is executing a run right now. */
  runningThreadIds?: () => Set<string>;
  /** Read-only snapshot of thread ids waiting for their provider run to start. */
  queuedThreadIds?: () => Set<string>;
  /** Provider-paced FIFO heads with their exact next eligible start time. */
  providerQueueHeads?: DashboardDataDeps["providerQueueHeads"];
  /** This instance's configured root identity ; see `DashboardDataDeps`. */
  rootIdentity?: DashboardDataDeps["rootIdentity"];
  /** Gemini API key, for on-demand avatar generation ; see `DashboardDataDeps`. */
  geminiApiKey?: DashboardDataDeps["geminiApiKey"];
}

export interface DashboardServerOptions {
  port: number;
  bindHost?: string;
  serveUi?: boolean;
  mesh?: DashboardMeshRefs;
  /**
   * The IU calibration op-getter (ISSUE_NUM 2b). When supplied, the dashboard serves
   * `GET /api/understanding/ops` (paginated local would-be-graph ops) for the calibration
   * view. Absent → that route falls through (404). Read-only.
   */
  understandingOps?: UnderstandingOpsDeps;
  /**
   * The IU reports reader . When supplied, the dashboard serves
   * `GET /api/understanding/reports` for the reports tab.
   */
  iuReportsApi?: IuReportsApiDeps;
  /**
   * The cached per-provider quota reader . When supplied, the dashboard serves
   * `GET /api/quota` (per-provider used%/window JSON, backed by the shared `QuotaService`
   * TTL cache — never probes per request). Absent → that route 503s.
   */
  quotaApi?: QuotaApiDeps;
  /** Small read-only frontend config payload for dashboard-only UI choices. */
  dashboardConfig?: Pick<DashboardConfig, "quotaProviders">;
  /**
   * Walkie-talkie mode, server half . When supplied (requires a bound
   * mesh AND a configured geminiApiKey), the dashboard serves the voice-memo /
   * voice-SSE / backlog / ack / audio routes and renders reply TTS for actors
   * with walkie presence. Absent → those routes 503 with a clear error.
   */
  voice?: { service: VoiceService };
}

/**
 * Validate the X-Hub-Signature-256 header against the payload.
 */
function validateSignature(
  secret: string,
  payload: string,
  signature: string | undefined
): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Collect the full request body as a string.
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export type JsonObjectParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseJsonObjectBody(body: string): JsonObjectParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: "Invalid JSON body" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Expected a JSON object body" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * Create the dashboard HTTP request handler.
 *
 * The v2 dashboard (tasks / distillation / understanding / models / conversations
 * APIs) was removed with the rest of the v2 orchestrator. This handler now only
 * **statically serves** the (placeholder) Flutter web app — the skeleton a new
 * dashboard will be rebuilt on. The actor mesh's observability lives in
 * `rusa report`, not here.
 */
export function createDashboardRequestHandler(
  options: DashboardServerOptions,
  dataDeps: DashboardDataDeps | null = null,
  voiceDeps: VoiceApiDeps | null = null
) {
  const { serveUi = true } = options;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const { pathname } = requestUrl;

    // Minimal liveness endpoint — always available, even without a live mesh.
    if (req.method === "GET" && pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          deployedSha,
          startedAt,
          version: packageVersion,
        })
      );
      return;
    }

    if (req.method === "GET" && pathname === "/api/dashboard/config") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({ quotaProviders: options.dashboardConfig?.quotaProviders ?? {} }));
      return;
    }

    // IU calibration op-getter (ISSUE_NUM 2b). Owns `/api/understanding/ops` when wired
    // (paginated local would-be-graph ops); returns false otherwise.
    if (
      options.understandingOps &&
      (await handleUnderstandingOpsRequest(req, res, requestUrl, options.understandingOps))
    )
      return;

    // IU node-body strings . Owns `/api/understanding/strings` when wired — resolves
    // externalized log-entry text by id so node bodies render; returns false otherwise.
    if (
      options.understandingOps &&
      (await handleUnderstandingStringsRequest(req, res, requestUrl, options.understandingOps))
    )
      return;

    // IU reports API
    if (
      options.iuReportsApi &&
      (await handleIuReportsApiRequest(req, res, requestUrl, options.iuReportsApi))
    )
      return;

    // Cached per-provider quota snapshot . Owns `GET /api/quota` (503s if no
    // QuotaService is bound); returns false otherwise.
    if (await handleQuotaApiRequest(req, res, requestUrl, options.quotaApi ?? null)) return;

    // Walkie-talkie voice routes . Must run BEFORE the general mesh
    // handler, which owns every other `/api/mesh/*` path. 503s when voice is
    // unconfigured (no geminiApiKey) or no mesh is bound.
    if (handleVoiceApiRequest(req, res, requestUrl, voiceDeps)) return;

    // Live mesh Data API + SSE. Owns every `/api/mesh/*` path (503s if no mesh
    // is bound); returns false otherwise so we fall through to static serving.
    if (handleMeshApiRequest(req, res, requestUrl, dataDeps)) return;

    if (serveUi && req.method === "GET" && !pathname.startsWith("/api/")) {
      // This instance's own name and face (#48), from the configured root
      // actor. Resolved per request, not once at startup, because an operator can
      // upload a new root image from the dashboard while the server runs.
      const branding = resolveDashboardBranding(options.mesh?.rootIdentity);

      // The manifest carries the installed PWA's name and icon, so it is rewritten
      // rather than served verbatim.
      if (pathname === "/manifest.json") {
        const manifest = getDashboardAsset(pathname);
        if (manifest) {
          const body = applyBrandingToManifest(manifest.body.toString("utf8"), branding);
          res.writeHead(200, {
            "Content-Type": manifest.contentType,
            // Tracks live config and the uploaded root image, so it must not be
            // held past the change that produced it.
            "Cache-Control": "no-store",
          });
          res.end(body);
          return;
        }
      }

      // Serve a built static asset if one matches the path. `index.html` is
      // excluded so an explicit request for it gets the same branded shell as `/`.
      const staticAsset = pathname === "/index.html" ? null : getDashboardAsset(pathname);
      if (staticAsset) {
        res.writeHead(200, { "Content-Type": staticAsset.contentType });
        res.end(staticAsset.body);
        return;
      }
      // Otherwise serve the SPA shell for `/`, `/dashboard`, and deep links, so a
      // refresh keeps working — when the Flutter assets have been built.
      if (hasDashboardAsset("index.html")) {
        try {
          const html = applyBrandingToHtml(getDashboardHtml(), branding);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            // The title and icon links are branded per request; see above.
            "Cache-Control": "no-store",
          });
          res.end(html);
          return;
        } catch (err) {
          console.error("[dashboard] Error rendering shell:", err);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("Dashboard unavailable — assets may not be built yet.");
          return;
        }
      }
    }

    console.log(`[dashboard] 404 Not Found: ${req.method} ${req.url}`);
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Dashboard UI not found or invalid API route");
  };
}

/**
 * Create the webhook HTTP request handler.
 */
export function createWebhookRequestHandler(options: WebhookServerOptions) {
  const { secret, onEvent, onNonWebhookRequest } = options;
  return async (req: IncomingMessage, res: ServerResponse) => {
    // Only accept POST to /webhook
    if (req.method !== "POST" || req.url !== "/webhook") {
      if (onNonWebhookRequest) {
        await onNonWebhookRequest(req, res);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const body = await readBody(req);

    // Validate signature
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!validateSignature(secret, body, signature)) {
      console.log(`[webhook] ❌ Invalid signature, rejecting request`);
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("Invalid signature");
      return;
    }

    // Parse event
    const eventType = req.headers["x-github-event"] as string | undefined;
    if (!eventType) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing X-GitHub-Event header");
      return;
    }

    // Handle ping (sent when webhook is first registered)
    if (eventType === "ping") {
      console.log(`[webhook] 🏓 Ping received — webhook is active`);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pong");
      return;
    }

    const deliveryId = req.headers["x-github-delivery"] as string | undefined;
    if (!deliveryId) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing X-GitHub-Delivery header");
      return;
    }

    // Parse payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Invalid JSON");
      return;
    }

    // Dispatch event
    console.log(`[webhook] 📥 Received ${eventType} event`);
    try {
      await onEvent(eventType, payload, deliveryId);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    } catch (err) {
      console.error(`[webhook] ❌ Error handling ${eventType}:`, err);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal error");
    }
  };
}

/**
 * Start the dashboard HTTP server on the given port.
 */
export async function startDashboardServer(options: DashboardServerOptions): Promise<{
  close: () => Promise<void>;
}> {
  const { port } = options;
  const bindHost = options.bindHost ?? "127.0.0.1";
  // When a live mesh is bound, stand up the SSE fan-out hub and the Data API
  // deps; both are torn down with the server. Without it, the handler 503s the
  // mesh routes and only serves the static UI.
  const sseHub = options.mesh ? new SseHub(options.mesh.emitter) : null;
  const dataDeps: DashboardDataDeps | null =
    options.mesh && sseHub
      ? {
          registry: options.mesh.registry,
          meshEvents: options.mesh.meshEvents,
          meshChat: options.mesh.meshChat,
          obligations: options.mesh.obligations,
          inbox: options.mesh.inbox,
          sseHub,
          mesh: options.mesh.mesh,
          rootControl: options.mesh.rootControl,
          isHalted: options.mesh.isHalted,
          runningThreadIds: options.mesh.runningThreadIds,
          queuedThreadIds: options.mesh.queuedThreadIds,
          providerQueueHeads: options.mesh.providerQueueHeads,
          rootIdentity: options.mesh.rootIdentity,
          geminiApiKey: options.mesh.geminiApiKey,
        }
      : null;
  // Walkie-talkie deps : routes need the registry/mesh/hub either way so
  // an unconfigured instance answers 503 with the "no geminiApiKey" error
  // rather than falling through to the generic mesh 404.
  const voiceDeps: VoiceApiDeps | null =
    options.mesh && sseHub
      ? {
          registry: options.mesh.registry,
          sseHub,
          mesh: options.mesh.mesh,
          service: options.voice?.service ?? null,
          log: (line) => console.log(line),
        }
      : null;
  // Reply-TTS hook: observe the mesh-event emitter for replies to
  // human:operator and push rendered audio on the `voice` channel.
  const detachVoiceOutbound =
    options.voice && options.mesh && sseHub
      ? attachVoiceOutbound(options.mesh.emitter, options.voice.service, sseHub)
      : null;
  const server = createServer(createDashboardRequestHandler(options, dataDeps, voiceDeps));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Bind loopback by default: the dashboard is never exposed on the LAN/public
    // interfaces. Tailnet access goes through `tailscale serve`, which proxies
    // 127.0.0.1:<port> (see configureTailscaleDashboard / install-service).
    server.listen(port, bindHost, () => {
      server.removeListener("error", reject);
      console.log(`[dashboard] 🌐 Listening on ${bindHost}:${port}`);
      if (hasDashboardAsset("index.html")) {
        console.log(`[dashboard] 🎨 Serving dashboard UI from ${getDashboardAssetDir()}`);
      } else {
        console.warn(
          `[dashboard] ⚠️ Dashboard UI bundle missing at ${getDashboardAssetDir()} — requests to / will return 404.`
        );
      }
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        detachVoiceOutbound?.();
        sseHub?.close();
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Start a lightweight HTTP server to receive GitHub webhooks.
 * Returns a cleanup function to close the server.
 */
export async function startWebhookServer(options: WebhookServerOptions): Promise<{
  close: () => Promise<void>;
}> {
  const { port } = options;
  const server = createServer(createWebhookRequestHandler(options));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      server.removeListener("error", reject);
      console.log(`[webhook] 🌐 Listening on port ${port}`);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
