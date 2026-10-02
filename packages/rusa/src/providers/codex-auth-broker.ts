import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { RusaConfig } from "../config/types.js";
import { createLogger, type Logger } from "../observability/logger.js";
import { codexHomeDir } from "./codex-home.js";

/**
 * Host-owned Codex refresh broker (#782).
 *
 * Every Codex process a daemon starts (sandboxed workers, the unsandboxed root,
 * the host-side quota and model probes) used to share the canonical
 * `~/.codex/auth.json`, and every one of them could rotate its refresh token. In
 * a worker sandbox that meant a writable bind any shell child could overwrite
 * (#781). With the broker on, trusted host code is the only thing that holds the
 * canonical refresh token or writes the canonical file:
 *
 * - A consumer gets a private `auth.json` whose access/id tokens are the
 *   canonical ones but whose `refresh_token` is a per-run opaque capability
 *   ({@link CodexAuthBroker.lease}). Its CLI is pointed at this broker through
 *   {@link CODEX_REFRESH_URL_ENV}; Codex sends the capability as the refresh
 *   token, and a reply without `refresh_token` leaves the capability in place.
 * - The broker builds its own upstream request from the canonical file and
 *   answers with tokens it wrote. Nothing in a request body is ever persisted or
 *   echoed; the body only names the capability.
 * - A rotation is written to a same-directory temp file, fsynced, renamed over
 *   canonical and the directory fsynced before any consumer is answered, so a
 *   crash after a reply never loses a rotation a consumer already saw.
 *
 * One refresh owner across processes: every broker (prod and staging daemons,
 * a quota coordinator) takes an exclusive SQLite write lock beside the canonical
 * file and re-reads canonical under it. The kernel drops that lock when its
 * holder dies, so there is no stale-lock guessing. A consumer whose access token
 * differs from canonical's is simply served canonical's: someone else already
 * rotated. Only a consumer holding canonical's current access token causes an
 * upstream call.
 *
 * The crash gap is irreducible: if the owner dies after upstream rotated but
 * before the rename, the new refresh token is lost and canonical's is spent. An
 * intent marker makes the next owner say so, and an upstream rejection marks the
 * canonical login dead so every consumer fails closed (re-login required)
 * without hammering upstream, until the canonical file changes.
 */

/** The endpoint Codex refreshes ChatGPT logins against (codex-rs `REFRESH_TOKEN_URL`). */
export const CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** Codex's public OAuth client id, as both pinned and current CLIs send it. */
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Env var Codex reads to override {@link CODEX_OAUTH_TOKEN_URL}. */
export const CODEX_REFRESH_URL_ENV = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";

const LOCK_FILE = "rusa-auth-refresh.lock";
const INTENT_FILE = "rusa-auth-refresh.intent";
const REFRESH_PATH = "/oauth/token";
const MAX_REQUEST_BYTES = 8 * 1024;
const ALLOWED_REQUEST_KEYS = new Set(["client_id", "grant_type", "refresh_token"]);

interface CodexTokens {
  id_token?: string;
  access_token?: string;
  refresh_token?: string;
  [key: string]: unknown;
}

interface CodexAuthFile {
  tokens?: CodexTokens | null;
  last_refresh?: string;
  [key: string]: unknown;
}

interface LeaseEntry {
  expiresAt: number;
  /** Hash of the access token this consumer was last handed. */
  lastAccess: string;
}

/** A consumer's view of the login: private auth contents plus where to refresh. */
export interface CodexAuthLease {
  /** Contents for the consumer's private `auth.json`. Never read back. */
  authJson: string;
  /** Value for {@link CODEX_REFRESH_URL_ENV}. */
  refreshUrl: string;
  /** Revoke the capability. Idempotent; an in-flight refresh still persists. */
  revoke(): void;
}

export interface CodexAuthBrokerOptions {
  /** Directory holding the canonical `auth.json`. Default {@link codexHomeDir}. */
  codexHome?: string;
  /** Upstream token endpoint (test seam). Default {@link CODEX_OAUTH_TOKEN_URL}. */
  upstreamUrl?: string;
  upstreamTimeoutMs?: number;
  /** How long to wait for another process's refresh before failing. */
  lockWaitMs?: number;
  /**
   * A canonical login refreshed less than this long ago is served as is rather
   * than rotated again, so a replayed capability cannot churn the login.
   */
  minRotationIntervalMs?: number;
  logger?: Logger;
  now?: () => number;
}

/** Upstream refused the canonical refresh token: the login needs `codex login`. */
class RefreshRejected extends Error {}

/** A broker failure whose message is written here and carries no token or path. */
class BrokerFault extends Error {}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Upstream error codes reach logs only in this shape; anything else is withheld. */
function safeErrorCode(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : "unspecified";
}

/**
 * What a failed refresh may put in a log: the broker's own messages, else only a
 * bounded code or error name. Native errors (fs, SQLite, fetch) name paths.
 */
function loggableError(err: unknown): string {
  if (err instanceof BrokerFault) return err.message;
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  if (typeof code === "string") return safeErrorCode(code);
  return err instanceof Error ? safeErrorCode(err.name) : "unknown";
}

/**
 * The capability, if `raw` is exactly a Codex refresh request. Any other field
 * (tokens, paths, anything a child might hope gets persisted) rejects the call.
 */
export function parseCodexRefreshRequest(raw: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((key) => !ALLOWED_REQUEST_KEYS.has(key))) return undefined;
  if (fields.grant_type !== "refresh_token") return undefined;
  if (fields.client_id !== undefined && typeof fields.client_id !== "string") return undefined;
  const cap = fields.refresh_token;
  return typeof cap === "string" && cap.length > 0 && cap.length <= 256 ? cap : undefined;
}

/** Write-then-rename in the same directory, fsyncing the file and then the directory. */
function writeFileDurably(path: string, dir: string, contents: string): void {
  const tmp = join(dir, `.${LOCK_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  const dfd = openSync(dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

function reply(res: ServerResponse, status: number, body: Record<string, string>): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export class CodexAuthBroker {
  private readonly codexHome: string;
  private readonly canonicalPath: string;
  private readonly upstreamUrl: string;
  private readonly upstreamTimeoutMs: number;
  private readonly lockWaitMs: number;
  private readonly minRotationIntervalMs: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly leases = new Map<string, LeaseEntry>();
  private server: Server | undefined;
  private listening: Promise<string> | undefined;
  private lockDb: Database.Database | undefined;
  /** In-process queue ahead of the cross-process lock. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Hash of a canonical refresh token upstream has already refused. */
  private deadRefresh: string | undefined;

  constructor(opts: CodexAuthBrokerOptions = {}) {
    this.codexHome = opts.codexHome ?? codexHomeDir();
    this.canonicalPath = join(this.codexHome, "auth.json");
    this.upstreamUrl = opts.upstreamUrl ?? CODEX_OAUTH_TOKEN_URL;
    this.upstreamTimeoutMs = opts.upstreamTimeoutMs ?? 30_000;
    this.lockWaitMs = opts.lockWaitMs ?? this.upstreamTimeoutMs + 15_000;
    this.minRotationIntervalMs = opts.minRotationIntervalMs ?? 60_000;
    this.log = opts.logger ?? createLogger({ context: { component: "codex-auth-broker" } });
    this.now = opts.now ?? Date.now;
  }

  /**
   * Issue a capability valid for `ttlMs` and the private auth contents that
   * carry it. Throws (never falls back) when the canonical login is unreadable.
   */
  async lease(ttlMs: number): Promise<CodexAuthLease> {
    const refreshUrl = await this.listen();
    const canonical = this.readCanonical();
    const tokens = canonical.tokens;
    if (!tokens?.refresh_token) {
      // API-key logins have nothing to rotate; the consumer sees what it always saw.
      return { authJson: JSON.stringify(canonical, null, 2), refreshUrl, revoke: () => {} };
    }
    const cap = `rusa-cap-${randomBytes(32).toString("base64url")}`;
    const key = sha256(cap);
    this.leases.set(key, {
      expiresAt: this.now() + ttlMs,
      lastAccess: sha256(tokens.access_token ?? ""),
    });
    const copy: CodexAuthFile = { ...canonical, tokens: { ...tokens, refresh_token: cap } };
    return {
      authJson: JSON.stringify(copy, null, 2),
      refreshUrl,
      revoke: () => {
        this.leases.delete(key);
      },
    };
  }

  /** Live capability count (diagnostics and tests). */
  get activeLeases(): number {
    return this.leases.size;
  }

  async close(): Promise<void> {
    this.leases.clear();
    const server = this.server;
    this.server = undefined;
    this.listening = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // Let a refresh that already reached upstream finish persisting.
    await this.chain.catch(() => undefined);
    this.lockDb?.close();
    this.lockDb = undefined;
  }

  private listen(): Promise<string> {
    this.listening ??= new Promise<string>((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.unref();
        this.server = server;
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}${REFRESH_PATH}`);
      });
    });
    return this.listening;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "POST" || req.url !== REFRESH_PATH) {
      req.resume();
      reply(res, 404, { error: "not_found" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reply(res, 413, { error: "invalid_request" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (res.headersSent) return;
      void this.answer(Buffer.concat(chunks).toString("utf8"), res);
    });
  }

  private async answer(raw: string, res: ServerResponse): Promise<void> {
    const cap = parseCodexRefreshRequest(raw);
    if (!cap) {
      reply(res, 400, { error: "invalid_request" });
      return;
    }
    const key = sha256(cap);
    const entry = this.leases.get(key);
    if (!entry || entry.expiresAt <= this.now()) {
      if (entry) this.leases.delete(key);
      reply(res, 401, { error: "invalid_grant" });
      return;
    }
    try {
      // Deliberately not tied to the request: a consumer cancelled mid-refresh
      // neither aborts the upstream call nor skips the persist.
      const tokens = await this.refreshFor(key, entry);
      const body: Record<string, string> = { access_token: tokens.access_token ?? "" };
      if (tokens.id_token) body.id_token = tokens.id_token;
      reply(res, 200, body);
    } catch (err) {
      if (err instanceof RefreshRejected) {
        reply(res, 401, { error: "invalid_grant" });
      } else {
        this.log.warn("codex_auth_refresh_failed", { error: loggableError(err) });
        reply(res, 502, { error: "temporarily_unavailable" });
      }
    }
  }

  private refreshFor(key: string, entry: LeaseEntry): Promise<CodexTokens> {
    const run = this.chain.then(() => this.withHostLock(() => this.refreshLocked(key, entry)));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async refreshLocked(key: string, entry: LeaseEntry): Promise<CodexTokens> {
    // A request queued behind another refresh or the host lock may have
    // outlived its lease. It gets nothing: no upstream call and no access
    // material. A rotation already past this point still persists.
    if (this.leases.get(key) !== entry || entry.expiresAt <= this.now()) {
      if (this.leases.get(key) === entry) this.leases.delete(key);
      throw new RefreshRejected("capability revoked or expired while queued");
    }
    const canonical = this.readCanonical();
    const tokens = canonical.tokens ?? {};
    const access = sha256(tokens.access_token ?? "");
    if (access !== entry.lastAccess) {
      // Another consumer, broker or login already moved canonical on.
      entry.lastAccess = access;
      return tokens;
    }
    const lastRefresh = Date.parse(String(canonical.last_refresh ?? ""));
    const sinceRefresh = this.now() - lastRefresh;
    if (sinceRefresh >= 0 && sinceRefresh < this.minRotationIntervalMs) return tokens;
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) throw new RefreshRejected("canonical login has no refresh token");
    const refreshHash = sha256(refreshToken);
    if (this.deadRefresh === refreshHash) throw new RefreshRejected("canonical login is spent");
    this.noteInterruptedRefresh(refreshHash);
    this.writeIntent(refreshHash);

    let body: Record<string, unknown>;
    try {
      body = await this.callUpstream(refreshToken);
    } catch (err) {
      if (err instanceof RefreshRejected) {
        this.deadRefresh = refreshHash;
        this.clearIntent();
        this.log.error("codex_auth_login_rejected", {
          error: err.message,
          action: "run `codex login` on the host; Codex launches fail until the login changes",
        });
      }
      // On a timeout or network error upstream may still have rotated, so the
      // intent stays for the next owner to report.
      throw err;
    }
    const str = (value: unknown, fallback: string | undefined) =>
      typeof value === "string" && value.length > 0 ? value : fallback;
    const next: CodexAuthFile = {
      ...canonical,
      tokens: {
        ...tokens,
        id_token: str(body.id_token, tokens.id_token),
        access_token: str(body.access_token, tokens.access_token),
        refresh_token: str(body.refresh_token, refreshToken),
      },
      last_refresh: new Date(this.now()).toISOString(),
    };
    writeFileDurably(this.canonicalPath, this.codexHome, JSON.stringify(next, null, 2));
    this.clearIntent();
    entry.lastAccess = sha256(next.tokens?.access_token ?? "");
    this.log.info("codex_auth_rotated", {});
    return next.tokens ?? {};
  }

  private async callUpstream(refreshToken: string): Promise<Record<string, unknown>> {
    const res = await fetch(this.upstreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(this.upstreamTimeoutMs),
    });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      /* status decides below */
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      const code =
        typeof body.error === "object" && body.error
          ? (body.error as { code?: unknown }).code
          : body.error;
      throw new RefreshRejected(
        `upstream refused the refresh (${res.status} ${safeErrorCode(code)})`
      );
    }
    if (!res.ok) throw new BrokerFault(`upstream refresh returned ${res.status}`);
    if (typeof body.access_token !== "string" || body.access_token.length === 0) {
      throw new BrokerFault("upstream refresh reply had no access token");
    }
    return body;
  }

  private readCanonical(): CodexAuthFile {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.canonicalPath, "utf8"));
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      throw new BrokerFault(
        `codex auth broker cannot read the canonical auth.json (${typeof code === "string" ? code : "unparseable"}); run \`codex login\` on the host`
      );
    }
    if (!parsed || typeof parsed !== "object") {
      throw new BrokerFault("codex auth broker: canonical auth.json is not an object");
    }
    return parsed as CodexAuthFile;
  }

  /**
   * Hold the host-wide refresh lock around `fn`. SQLite's write lock is an
   * fcntl lock on the file, released by the kernel if this process dies.
   */
  private async withHostLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.lockDb) {
      this.lockDb = new Database(join(this.codexHome, LOCK_FILE));
      this.lockDb.pragma("busy_timeout = 0");
    }
    const db = this.lockDb;
    const deadline = this.now() + this.lockWaitMs;
    for (;;) {
      try {
        db.exec("BEGIN IMMEDIATE");
        break;
      } catch (err) {
        if ((err as { code?: unknown }).code !== "SQLITE_BUSY") throw err;
        if (this.now() >= deadline)
          throw new BrokerFault("timed out waiting for the host refresh lock");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    try {
      return await fn();
    } finally {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* nothing was written */
      }
    }
  }

  private writeIntent(refreshHash: string): void {
    const intent = { refresh: refreshHash.slice(0, 16), pid: process.pid, startedAt: this.now() };
    writeFileDurably(join(this.codexHome, INTENT_FILE), this.codexHome, JSON.stringify(intent));
  }

  private clearIntent(): void {
    rmSync(join(this.codexHome, INTENT_FILE), { force: true });
  }

  private noteInterruptedRefresh(refreshHash: string): void {
    let intent: { refresh?: unknown; pid?: unknown; startedAt?: unknown };
    try {
      intent = JSON.parse(readFileSync(join(this.codexHome, INTENT_FILE), "utf8"));
    } catch {
      return;
    }
    if (intent.refresh !== refreshHash.slice(0, 16)) return;
    this.log.warn("codex_auth_previous_refresh_interrupted", {
      pid: typeof intent.pid === "number" ? intent.pid : undefined,
      startedAt:
        typeof intent.startedAt === "number" ? new Date(intent.startedAt).toISOString() : undefined,
      consequence:
        "if upstream rotated before the interruption, this refresh is refused and needs `codex login`",
    });
  }
}

/** Write a lease's private `auth.json` into `dir` (owner-only). Returns its path. */
export function writeCodexLeaseAuth(dir: string, lease: CodexAuthLease): string {
  const path = join(dir, "auth.json");
  writeFileSync(path, lease.authJson, { mode: 0o600 });
  return path;
}

/**
 * A throwaway CODEX_HOME for a host-side (unsandboxed) Codex process: every
 * entry of `hostCodexDir` symlinked in except the login and the broker's own
 * files, plus the lease's private `auth.json`. The process keeps the host's
 * config, sessions and caches but never sees or rewrites the canonical refresh
 * token. The caller removes the returned directory.
 */
export function seedBrokeredCodexHome(hostCodexDir: string, lease: CodexAuthLease): string {
  const home = mkdtempSync(join(tmpdir(), "rusa-codex-home-"));
  try {
    let entries: string[] = [];
    try {
      entries = readdirSync(hostCodexDir);
    } catch {
      /* no host codex home: the lease alone is enough to run */
    }
    for (const entry of entries) {
      if (
        entry === "auth.json" ||
        entry.startsWith("rusa-auth-refresh.") ||
        entry.startsWith(`.${LOCK_FILE}.`)
      ) {
        continue;
      }
      symlinkSync(join(hostCodexDir, entry), join(home, entry));
    }
    writeCodexLeaseAuth(home, lease);
    return home;
  } catch (err) {
    rmSync(home, { recursive: true, force: true });
    throw err;
  }
}

/** Whether `config` opts this process into the broker (`providers.codex.authBroker`). */
export function codexAuthBrokerConfigured(config: Pick<RusaConfig, "providers">): boolean {
  return config.providers?.codex?.authBroker === true;
}

let brokerEnabled = false;
let brokerOptions: CodexAuthBrokerOptions = {};
let activeBroker: CodexAuthBroker | undefined;

/**
 * Set this process's broker mode, once at boot from config. Tests pass
 * `options` to point the broker at a fixture home and upstream.
 */
export function configureCodexAuthBroker(
  enabled: boolean,
  options: CodexAuthBrokerOptions = {}
): void {
  const previous = activeBroker;
  activeBroker = undefined;
  brokerEnabled = enabled;
  brokerOptions = options;
  void previous?.close();
}

/** The process's broker when enabled (started lazily), else undefined. */
export function activeCodexAuthBroker(): CodexAuthBroker | undefined {
  if (!brokerEnabled) return undefined;
  activeBroker ??= new CodexAuthBroker(brokerOptions);
  return activeBroker;
}
