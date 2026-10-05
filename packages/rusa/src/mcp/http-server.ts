import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { decodeScheduledMessagePayload, type ScheduledMessage } from "../actor/os-scheduler.js";
import { type Logger, nullLogger } from "../observability/logger.js";
import type { McpServerSpec } from "../providers/types.js";

export interface McpHttpServerOptions {
  /**
   * Named MCP server factories. A fresh {@link McpServer} is created per client
   * session (the protocol wrapper is per-session; the backend it closes over —
   * the real or fake IssueClient/ChatClient — is shared). Each is served at an
   * unguessable `/mcp/<token>` (see the class doc: the URL is the capability).
   */
  servers: Record<string, () => McpServer>;
  /** Bind host (default 127.0.0.1 — loopback only; the agent connects via localhost). */
  host?: string;
  /** Bind port (default 0 — an ephemeral port, read back via {@link urls}). */
  port?: number;
  /** Optional cron-driven wake endpoint (ISSUE_NUM 1c); wired post-mesh via {@link setWakeHandler}. */
  wake?: WakeHandler;
  /** Optional host-jobs exit endpoint ; wired post-mesh via {@link setHostJobExitHandler}. */
  hostJobExit?: HostJobExitHandler;
  /** Structured application logger for MCP request lifecycle diagnostics. */
  logger?: Logger;
}

/**
 * The `POST /wake` endpoint's backend (ISSUE_NUM, phase 1c). A cron job pings the
 * loopback endpoint with a bearer token; the handler authenticates and delivers a
 * mechanical wake. Stateless — cron owns timing + durability.
 */
export interface WakeObligationHandler {
  token: string;
  deliver: (id: string) => void;
}

export interface WakeMessageHandler {
  token: string;
  deliver: (message: ScheduledMessage) => void;
}

export interface WakeHandler {
  /** The bearer token the cron job must present (minted at install, chmod-600 file). */
  token: string;
  /** Deliver a wake to the actor's inbox; returns whether it was live (200 vs 404). */
  deliver: (actorId: string, reason: string, priority?: "normal" | "responsive") => boolean;
}

/**
 * The `POST /host-jobs/exit` endpoint's backend . The installed
 * `wake-on-exit.sh` script (an ExecStopPost on every job's transient unit) posts
 * here with the same bearer token as `/wake` — one host-side secret file. Always
 * records the exit (job-specific ledger event) and wakes the submitting actor
 * regardless of whether it's currently live, mirroring `/wake`'s own dropped-wake
 * handling — so `onExit` returns nothing to branch on.
 */
export interface HostJobExitHandler {
  /** The bearer token the wake-on-exit script must present. */
  token: string;
  onExit: (payload: {
    jobId?: string;
    unitName?: string;
    actorId: string;
    result: string;
    exitStatus: string;
  }) => void;
}

export type McpRunClassification =
  | "not_connected"
  | "listing_incomplete"
  | "discovered_unused"
  | "used"
  | "unknown";

/**
 * What one mount saw during a run attempt. Labels and counts only: tool names
 * and arguments are caller-supplied and never recorded.
 */
export interface McpServerMountTally {
  /** An `initialize` request arrived. */
  initialized: boolean;
  /** A `tools/list` result was written to its response stream. */
  toolsListed: boolean;
  /** `tools/call` requests that arrived. */
  toolCalls: number;
}

export interface RunMcpDiagnostic {
  classification: McpRunClassification;
  servers: Record<string, McpServerMountTally>;
  totalCalls: number;
}

/** One actor's open run-attempt window. */
interface RunWindow {
  expectedServers: readonly string[];
  mounts: Map<string, McpServerMountTally>;
}

/**
 * Classify a run's in-process MCP diagnostic from its per-mount tally. The
 * agent-execution mount (`mesh`) is the one every actor needs, so a run whose
 * client never initialized it is `not_connected` even if another mount did.
 */
export function classifyMcpRun(
  mounts: Record<string, McpServerMountTally>,
  expectedServers: readonly string[]
): McpRunClassification {
  const tallies = Object.values(mounts);
  if (tallies.some((mount) => mount.toolCalls > 0)) return "used";
  if (!tallies.some((mount) => mount.initialized)) return "not_connected";
  if (expectedServers.includes(UNCLASSIFIED_SERVER_LABEL) && !mounts.mesh?.initialized) {
    return "not_connected";
  }
  return expectedServers.every((server) => mounts[server]?.toolsListed)
    ? "discovered_unused"
    : "listing_incomplete";
}

/** Length-checked, timing-safe string compare (avoids leaking the token via timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Wake bodies are tiny (actorId + reason); cap to bound a runaway/malicious body. */
const MAX_WAKE_BODY_BYTES = 8 * 1024;
const MAX_SCHEDULED_MESSAGE_BODY_BYTES = 256 * 1024;
// Keep loopback MCP connections alive longer than the coding client's pooled idle window (MEK-Org/rusa#294).
const MCP_KEEP_ALIVE_TIMEOUT_MS = 120_000;
const MCP_HEADERS_TIMEOUT_MS = 121_000;

/** Keep request-derived diagnostics useful without admitting unbounded client input. */
const MAX_MCP_LOG_METADATA_LENGTH = 128;

/** Return only a bounded scalar suitable for a diagnostic record. */
function boundedMetadata(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, MAX_MCP_LOG_METADATA_LENGTH) : undefined;
}

/** The label recorded for a mount whose name is not known to be free of private identifiers. */
const UNCLASSIFIED_SERVER_LABEL = "mesh";

/**
 * Derive the log label for a mount registered after start. A mounted actor
 * capability is named `<actor-id>:<capability>`, so the capability suffix names
 * the request path without the private actor id. A bare dynamic name is an
 * actor's own mesh mount, and nothing about the string proves otherwise, so it
 * is labelled conservatively rather than recorded. Callers that register a
 * host service under a bare, code-controlled name pass `logLabel` to say so.
 */
function derivedServerLabel(name: string): string {
  const separator = name.lastIndexOf(":");
  if (separator >= 0) {
    const capability = name.slice(separator + 1);
    if (capability.length > 0) return capability.slice(0, MAX_MCP_LOG_METADATA_LENGTH);
  }
  return UNCLASSIFIED_SERVER_LABEL;
}

/**
 * Select the few routing fields useful for a request timeline. Arguments,
 * results, capability URLs, credentials, and parse errors must never enter the
 * application log.
 */
function requestMetadata(body: unknown): { rpcMethod?: string; toolName?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const request = body as Record<string, unknown>;
  const rpcMethod = boundedMetadata(request.method);
  const params = request.params;
  const toolName =
    rpcMethod === "tools/call" && params && typeof params === "object" && !Array.isArray(params)
      ? boundedMetadata((params as Record<string, unknown>).name)
      : undefined;
  return { rpcMethod, toolName };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function readTextBody(req: IncomingMessage, maxBytes = MAX_WAKE_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > maxBytes) {
        over = true;
        // Drain (not destroy) the rest so the socket completes cleanly and the
        // 413 response can flush back to the client — destroying resets the conn.
        req.resume();
        reject(new Error("wake body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Hosts in-process MCP servers over the streamable-HTTP transport on a loopback
 * port, so a coding-agent subprocess (claude `--mcp-config`, agy settings file)
 * can connect to them as the agent's tools. Because the servers are constructed
 * in-process from the same backends the rest of rusa uses, "prod vs e2e is
 * just which backend you wire" holds straight through to the agent — the fake
 * tracker/chat impls stay in-process (actor-mesh design B.3).
 *
 * Stateful sessions: each client `initialize` mints a session id; subsequent
 * requests carry it in the `mcp-session-id` header and route to that session's
 * transport.
 *
 * **The URL is the capability (ISSUE_NUM security fix).** Each hosted server is served
 * at `/mcp/<token>` where the token is an unguessable per-server `randomUUID`, NOT
 * the server name. Each actor is handed only its OWN endpoint URL, so a worker
 * cannot reach another actor's (e.g. root's) endpoint by constructing a path from
 * a known name — it doesn't hold the token. This is what makes the in-tool
 * `selfId`-based identity checks (e.g. root-only capability grants) meaningful:
 * the presented token, not a guessable path, is the caller's identity at the
 * transport. The internal `name` keys (used by {@link addServer}/
 * {@link removeServer} and session bookkeeping) stay stable and private.
 */
export class McpHttpServer {
  private readonly factories: Record<string, () => McpServer>;
  private readonly host: string;
  private port: number;
  private server: Server | null = null;
  /** Per server-name: sessionId -> transport. */
  private readonly sessions = new Map<string, Map<string, StreamableHTTPServerTransport>>();
  /** name -> unguessable URL path token, and the reverse for routing. */
  private readonly nameToToken = new Map<string, string>();
  private readonly tokenToName = new Map<string, string>();
  /** Per mounted server: the safe label recorded for it, never its raw name. */
  private readonly serverLabels = new Map<string, string>();
  /** Per server-name: session id -> monotonic creation time for close diagnostics. */
  private readonly sessionStartedAt = new Map<string, Map<string, number>>();
  /** Open run-attempt windows keyed by actor id. */
  private readonly runWindows = new Map<string, RunWindow>();
  /** Per transport: `tools/list` request ids awaiting their result, and what to mark. */
  private readonly pendingToolsLists = new WeakMap<
    StreamableHTTPServerTransport,
    Map<string | number, () => void>
  >();
  private readonly log: Logger;
  /** Cron-driven wake endpoint backend; null until {@link setWakeHandler} wires it. */
  private wake: WakeHandler | null;
  private wakeObligation?: WakeObligationHandler | null;
  private wakeMessage?: WakeMessageHandler | null;
  /** Host-jobs exit endpoint backend; null until {@link setHostJobExitHandler} wires it. */
  private hostJobExit: HostJobExitHandler | null;

  constructor(opts: McpHttpServerOptions) {
    this.factories = opts.servers;
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port ?? 0;
    this.log = (opts.logger ?? nullLogger).child({ component: "mcp-http" });
    this.wake = opts.wake ?? null;
    this.hostJobExit = opts.hostJobExit ?? null;
    for (const name of Object.keys(this.factories)) {
      this.sessions.set(name, new Map());
      this.sessionStartedAt.set(name, new Map());
      this.ensureToken(name);
      // Host services declared at startup carry code-controlled names, so the
      // name itself is the safe label.
      this.serverLabels.set(name, name.slice(0, MAX_MCP_LOG_METADATA_LENGTH));
    }
  }

  /** The bound port (resolved after {@link start} when an ephemeral port is used). */
  get boundPort(): number {
    return this.port;
  }

  /**
   * Wire (or replace) the wake endpoint backend after construction — the deliver
   * callback needs the mesh, which is built after this server. Until set, `/wake`
   * 404s like any unknown path (no info leak that the endpoint exists).
   */
  setWakeHandler(wake: WakeHandler): void {
    this.wake = wake;
  }
  setWakeObligationHandler(wake: WakeObligationHandler): void {
    this.wakeObligation = wake;
  }
  setWakeMessageHandler(wake: WakeMessageHandler): void {
    this.wakeMessage = wake;
  }

  /**
   * Wire (or replace) the host-jobs exit endpoint backend after construction — the
   * onExit callback needs the mesh + HostJobStore, both built after this server.
   * Until set, `/host-jobs/exit` 404s like any unknown path.
   */
  setHostJobExitHandler(hostJobExit: HostJobExitHandler): void {
    this.hostJobExit = hostJobExit;
  }

  /** Mint (once) the unguessable path token for a server name. */
  private ensureToken(name: string): string {
    let token = this.nameToToken.get(name);
    if (!token) {
      token = randomUUID();
      this.nameToToken.set(name, token);
      this.tokenToName.set(token, name);
    }
    return token;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    server.keepAliveTimeout = MCP_KEEP_ALIVE_TIMEOUT_MS;
    // Keep the headers timeout slightly above the chosen keep-alive timeout.
    server.headersTimeout = MCP_HEADERS_TIMEOUT_MS;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        server.removeListener("error", reject);
        resolve();
      });
    });
  }

  /**
   * Streamable-HTTP {@link McpServerSpec}s for each hosted server. The `name` is
   * the logical MCP server name the provider namespaces tools under; the `url`
   * carries the unguessable token path, not the name.
   */
  urls(): McpServerSpec[] {
    return Object.keys(this.factories).map((name) => ({ name, url: this.urlFor(name) }));
  }

  /** The loopback URL for a hosted server name — an unguessable `/mcp/<token>`. */
  urlFor(name: string): string {
    return `http://${this.host}:${this.port}/mcp/${this.ensureToken(name)}`;
  }

  /**
   * Register (or replace) a server under `name` after start — used to host a
   * per-actor endpoint (e.g. the agent-execution server for one actor, with its
   * id baked in). Returns the loopback URL to hand the actor's provider.
   */
  addServer(name: string, factory: () => McpServer, opts?: { logLabel?: string }): string {
    this.factories[name] = factory;
    if (!this.sessions.has(name)) this.sessions.set(name, new Map());
    if (!this.sessionStartedAt.has(name)) this.sessionStartedAt.set(name, new Map());
    this.serverLabels.set(
      name,
      opts?.logLabel?.slice(0, MAX_MCP_LOG_METADATA_LENGTH) ?? derivedServerLabel(name)
    );
    return this.urlFor(name);
  }

  /** Tear down a hosted server (its transports) and stop routing to it. */
  async removeServer(name: string): Promise<void> {
    const transports = this.sessions.get(name);
    if (transports) {
      for (const transport of transports.values()) {
        try {
          await transport.close();
        } catch {
          /* best effort */
        }
      }
      this.sessions.delete(name);
    }
    this.sessionStartedAt.delete(name);
    this.serverLabels.delete(name);
    delete this.factories[name];
    const token = this.nameToToken.get(name);
    if (token) {
      this.tokenToName.delete(token);
      this.nameToToken.delete(name);
    }
  }

  /**
   * Open a run-attempt window for an actor, replacing any previous attempt's.
   * Until it is finished or cleared, `initialize`, completed `tools/list` and
   * `tools/call` traffic on the actor's own mounts is tallied per mount.
   */
  startRunWindow(actorId: string, expectedServers: readonly string[]): void {
    const mounts = new Map<string, McpServerMountTally>();
    for (const server of expectedServers) {
      mounts.set(server, { initialized: false, toolsListed: false, toolCalls: 0 });
    }
    this.runWindows.set(actorId, { expectedServers: [...expectedServers], mounts });
  }

  /** Close an actor's window and classify it; `unknown` when none was open. */
  finishRunWindow(actorId: string): RunMcpDiagnostic {
    const window = this.runWindows.get(actorId);
    if (!window) return { classification: "unknown", servers: {}, totalCalls: 0 };
    this.runWindows.delete(actorId);
    const servers = Object.fromEntries(
      [...window.mounts].map(([label, mount]) => [label, { ...mount }])
    );
    return {
      classification: classifyMcpRun(servers, window.expectedServers),
      servers,
      totalCalls: [...window.mounts.values()].reduce((sum, mount) => sum + mount.toolCalls, 0),
    };
  }

  /** Drop an actor's window without classifying it (teardown/retire). */
  clearRunWindow(actorId: string): void {
    this.runWindows.delete(actorId);
  }

  /**
   * The open window of the actor that owns mount `name`. Every mount is
   * actor-named (`<actor>` or `<actor>:<capability>`), so ownership comes from
   * the name alone; traffic on a mount whose owner has no open window is not
   * tallied, never attributed to another actor.
   */
  private runWindowFor(name: string): RunWindow | undefined {
    const separator = name.lastIndexOf(":");
    return this.runWindows.get(separator >= 0 ? name.slice(0, separator) : name);
  }

  private mountTally(window: RunWindow, name: string): McpServerMountTally {
    const label = this.serverLabel(name) ?? derivedServerLabel(name);
    let mount = window.mounts.get(label);
    if (!mount) {
      mount = { initialized: false, toolsListed: false, toolCalls: 0 };
      window.mounts.set(label, mount);
    }
    return mount;
  }

  /**
   * Count a `tools/list` only once its JSON-RPC result has been written to the
   * response stream. `handleRequest` can return before the server answers; an
   * error response, or a stream closed before the answer, never counts.
   */
  private observeToolsListResults(transport: StreamableHTTPServerTransport): void {
    const pending = new Map<string | number, () => void>();
    this.pendingToolsLists.set(transport, pending);
    const send = transport.send.bind(transport);
    transport.send = async (message: JSONRPCMessage, options) => {
      const id = "id" in message && !("method" in message) ? message.id : undefined;
      const onListed = id === undefined ? undefined : pending.get(id);
      if (id !== undefined) pending.delete(id);
      await send(message, options);
      if (onListed && "result" in message) onListed();
    };
  }

  /** Resolve a request path's `/mcp/<token>` back to its server name, or undefined. */
  private serverNameFor(url: string | undefined): string | undefined {
    const path = (url ?? "").split("?")[0];
    const m = path.match(/^\/mcp\/([^/]+)$/);
    if (!m) return undefined;
    const name = this.tokenToName.get(m[1]);
    return name && this.factories[name] ? name : undefined;
  }

  /** Safe mount label for request records; never the URL token, the raw name, or an actor id. */
  private serverLabel(name: string): string | undefined {
    return this.serverLabels.get(name);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if ((req.url ?? "").split("?")[0] === "/wake") {
      await this.handleWake(req, res);
      return;
    }
    if ((req.url ?? "").split("?")[0] === "/wake-obligation") {
      await this.handleWakeObligationRequest(req, res);
      return;
    }
    if ((req.url ?? "").split("?")[0] === "/wake-message") {
      await this.handleWakeMessageRequest(req, res);
      return;
    }
    if ((req.url ?? "").split("?")[0] === "/host-jobs/exit") {
      await this.handleHostJobExit(req, res);
      return;
    }
    const name = this.serverNameFor(req.url);
    if (!name) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const transports = this.sessions.get(name) as Map<string, StreamableHTTPServerTransport>;
    const sessionStarts = this.sessionStartedAt.get(name) as Map<string, number>;
    const requestStartedAt = performance.now();
    const requestId = randomUUID();
    // Read the mount label once, at arrival: a session close can outlive the
    // mount, and every record for this request should name the mount that served it.
    const server = this.serverLabel(name);
    // Routing must use the complete header. Its separately bounded form is for
    // diagnostics only: trimming before Map#get changes which session receives
    // a request.
    let sessionId =
      typeof req.headers["mcp-session-id"] === "string" ? req.headers["mcp-session-id"] : undefined;
    let loggedSessionId = boundedMetadata(sessionId);
    // Capture this before body parsing so an arrival record answers whether the
    // client presented a currently live session, even if parsing or dispatch stalls.
    const sessionResolvedAtArrival = sessionId !== undefined && transports.has(sessionId);
    let metadata: { rpcMethod?: string; toolName?: string } = {};
    let responseFinished = false;
    const requestFields = () => ({
      requestId,
      server,
      sessionId: loggedSessionId,
      sessionResolvedAtArrival,
      ...metadata,
      elapsedMs: elapsedMs(requestStartedAt),
    });
    // `writableFinished` is this host completing its own writable side — the
    // closest observable local evidence that a response left here, and never a
    // client receipt acknowledgement.
    const responseFields = () => ({
      statusCode: res.statusCode,
      headersSent: res.headersSent,
      writableFinished: res.writableFinished,
    });
    const logResponseFinished = () => {
      responseFinished = true;
      // `finish` means Node completed its side of the HTTP response. It is not
      // a client receipt acknowledgement; streamable GET responses can remain
      // open long after the transport has returned.
      this.log.info("mcp_http_response_finished", {
        ...requestFields(),
        ...responseFields(),
      });
    };
    const logResponseClosed = () => {
      if (responseFinished) return;
      this.log.warn("mcp_http_response_closed", {
        ...requestFields(),
        ...responseFields(),
      });
    };
    res.once("finish", logResponseFinished);
    res.once("close", logResponseClosed);
    this.log.info("mcp_request_arrived", {
      ...requestFields(),
      httpMethod: boundedMetadata(req.method),
    });

    try {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        metadata = requestMetadata(body);
        this.log.info("mcp_request_body_read", requestFields());
        // The window is read once, at arrival: a request that outlives its
        // attempt must not mark the attempt that replaced it.
        const runWindow = this.runWindowFor(name);
        if (runWindow && metadata.rpcMethod === "initialize") {
          this.mountTally(runWindow, name).initialized = true;
        }
        if (runWindow && metadata.rpcMethod === "tools/call") {
          this.mountTally(runWindow, name).toolCalls += 1;
        }
        const existing = sessionId ? transports.get(sessionId) : undefined;
        let transport: StreamableHTTPServerTransport;
        if (existing) {
          transport = existing;
        } else {
          if (!isInitializeRequest(body)) {
            this.log.warn("mcp_session_rejected", requestFields());
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "No valid session id; expected an initialize request",
                },
                id: null,
              })
            );
            return;
          }
          const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports.set(sid, newTransport);
              sessionId = sid;
              loggedSessionId = boundedMetadata(sid);
              sessionStarts.set(sid, performance.now());
              this.log.info("mcp_session_created", requestFields());
            },
          });
          this.observeToolsListResults(newTransport);
          newTransport.onclose = () => {
            const sid = newTransport.sessionId;
            if (!sid) return;
            transports.delete(sid);
            const startedAt = sessionStarts.get(sid);
            sessionStarts.delete(sid);
            if (startedAt !== undefined) {
              this.log.info("mcp_session_closed", {
                server,
                sessionId: boundedMetadata(sid),
                elapsedMs: elapsedMs(startedAt),
              });
            }
          };
          this.log.info("mcp_session_connecting", requestFields());
          await this.factories[name]().connect(newTransport);
          this.log.info("mcp_session_connected", requestFields());
          transport = newTransport;
        }
        const listId = (body as { id?: unknown }).id;
        if (
          runWindow &&
          metadata.rpcMethod === "tools/list" &&
          (typeof listId === "string" || typeof listId === "number")
        ) {
          this.pendingToolsLists.get(transport)?.set(listId, () => {
            if (this.runWindowFor(name) === runWindow) {
              this.mountTally(runWindow, name).toolsListed = true;
            }
          });
        }
        this.log.info("mcp_transport_dispatch", requestFields());
        await transport.handleRequest(req, res, body);
        this.log.info("mcp_transport_returned", requestFields());
        return;
      }

      if (req.method === "GET" || req.method === "DELETE") {
        const transport = sessionId ? transports.get(sessionId) : undefined;
        if (!transport) {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("invalid or missing session id");
          return;
        }
        this.log.info("mcp_transport_dispatch", {
          ...requestFields(),
          httpMethod: boundedMetadata(req.method),
        });
        await transport.handleRequest(req, res);
        this.log.info("mcp_transport_returned", {
          ...requestFields(),
          httpMethod: boundedMetadata(req.method),
        });
        return;
      }

      res.writeHead(405, { "content-type": "text/plain" });
      res.end("method not allowed");
    } catch {
      // This is deliberately error-detail-free: request payloads and provider
      // errors can contain credentials or other private data.
      this.log.warn("mcp_request_failed", requestFields());
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          })
        );
      }
    }
  }

  /**
   * The cron-driven wake endpoint. Bearer-authenticated (the loopback bind is the
   * first line of defense; the token gates same-host processes that aren't the
   * familiar). Body is form-encoded (`actorId`, `reason`) — what `curl -d` sends.
   * 200 = delivered to a live actor, 404 = no live actor, 401 = bad/missing token.
   */
  private async handleWake(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, payload: Record<string, unknown>) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      if (!this.wake) {
        // Not wired → behave like an unknown path (don't reveal the endpoint).
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      if (req.method !== "POST") {
        send(405, { error: "method not allowed" });
        return;
      }
      const auth = (req.headers.authorization as string | undefined) ?? "";
      if (!safeEqual(auth, `Bearer ${this.wake.token}`)) {
        send(401, { error: "unauthorized" });
        return;
      }
      let raw: string;
      try {
        raw = await readTextBody(req);
      } catch {
        send(413, { error: "body too large" });
        return;
      }
      const params = new URLSearchParams(raw);
      const actorId = params.get("actorId") ?? "";
      const reason = params.get("reason") ?? "";
      const priorityParam = params.get("priority");
      const priority =
        priorityParam === "responsive" || priorityParam === "true" ? "responsive" : undefined;
      if (!actorId) {
        send(400, { error: "actorId required" });
        return;
      }
      const delivered = this.wake.deliver(actorId, reason, priority);
      send(delivered ? 200 : 404, { delivered });
    } catch {
      if (!res.headersSent) send(500, { error: "internal error" });
    }
  }

  /**
   * The host-jobs ExecStopPost exit endpoint . Bearer-authenticated with
   * the same token as `/wake` (one host-side secret file). Body is form-encoded
   * (`jobId`, `unitName`, `actorId`, `result`, `exitStatus`) — what the installed
   * `wake-on-exit.sh` sends via `curl -d`. Always 200s once authenticated with
   * the required fields present; the actor-liveness branching `/wake` does lives
   * inside `onExit` (via `deliverWake`), not this endpoint.
   */
  private async handleWakeObligationRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const send = (code: number, payload: Record<string, unknown>) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      if (!this.wakeObligation) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      if (req.method !== "POST") {
        send(405, { error: "method not allowed" });
        return;
      }
      const auth = (req.headers.authorization as string | undefined) ?? "";
      if (!safeEqual(auth, `Bearer ${this.wakeObligation.token}`)) {
        send(401, { error: "unauthorized" });
        return;
      }
      let raw: string;
      try {
        raw = await readTextBody(req);
      } catch {
        send(413, { error: "body too large" });
        return;
      }
      const params = new URLSearchParams(raw);
      const id = params.get("id");
      if (!id) {
        send(400, { error: "id required" });
        return;
      }
      this.wakeObligation.deliver(id);
      send(200, { ok: true });
    } catch {
      if (!res.headersSent) send(500, { error: "internal error" });
    }
  }

  private async handleWakeMessageRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, payload: Record<string, unknown>) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      if (!this.wakeMessage) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      if (req.method !== "POST") {
        send(405, { error: "method not allowed" });
        return;
      }
      const auth = (req.headers.authorization as string | undefined) ?? "";
      if (!safeEqual(auth, `Bearer ${this.wakeMessage.token}`)) {
        send(401, { error: "unauthorized" });
        return;
      }
      let raw: string;
      try {
        raw = await readTextBody(req, MAX_SCHEDULED_MESSAGE_BODY_BYTES);
      } catch {
        send(413, { error: "body too large" });
        return;
      }
      const params = new URLSearchParams(raw);
      const payload = params.get("payload");
      if (!payload) {
        send(400, { error: "payload required" });
        return;
      }
      let message: ScheduledMessage;
      try {
        message = decodeScheduledMessagePayload(payload);
      } catch {
        send(400, { error: "invalid payload" });
        return;
      }
      this.wakeMessage.deliver(message);
      send(200, { ok: true });
    } catch {
      if (!res.headersSent) send(500, { error: "internal error" });
    }
  }

  private async handleHostJobExit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, payload: Record<string, unknown>) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    try {
      if (!this.hostJobExit) {
        // Not wired → behave like an unknown path (don't reveal the endpoint).
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      if (req.method !== "POST") {
        send(405, { error: "method not allowed" });
        return;
      }
      const auth = (req.headers.authorization as string | undefined) ?? "";
      if (!safeEqual(auth, `Bearer ${this.hostJobExit.token}`)) {
        send(401, { error: "unauthorized" });
        return;
      }
      let raw: string;
      try {
        raw = await readTextBody(req);
      } catch {
        send(413, { error: "body too large" });
        return;
      }
      const params = new URLSearchParams(raw);
      const jobId = params.get("jobId") ?? "";
      const unitName = params.get("unitName") ?? "";
      const actorId = params.get("actorId") ?? "";
      const result = params.get("result") ?? "";
      const exitStatus = params.get("exitStatus") ?? "";
      if ((!jobId && !unitName) || !actorId) {
        send(400, { error: "jobId or unitName, and actorId required" });
        return;
      }
      this.hostJobExit.onExit({
        jobId: jobId || undefined,
        unitName: unitName || undefined,
        actorId,
        result,
        exitStatus,
      });
      send(200, { ok: true });
    } catch {
      if (!res.headersSent) send(500, { error: "internal error" });
    }
  }

  async close(): Promise<void> {
    this.runWindows.clear();
    for (const transports of this.sessions.values()) {
      for (const transport of transports.values()) {
        try {
          await transport.close();
        } catch {
          /* best effort */
        }
      }
      transports.clear();
    }
    if (this.server) {
      const server = this.server;
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.server = null;
    }
  }
}
