import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { cert, deleteApp, initializeApp, type ServiceAccount } from "firebase-admin/app";
import { type DecodedIdToken, getAuth } from "firebase-admin/auth";
import { validateDashboardAuth } from "../config/dashboard-auth.js";
import type { DashboardAuthConfig } from "../config/types.js";
import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import type { UserPrincipal } from "../principals/principal-ref.js";
import { DashboardCsrf } from "./csrf.js";
import { DashboardIdentityResolver } from "./identity.js";

export const SESSION_COOKIE = "__Host-rusa_session";
export const SESSION_MS = 5 * 24 * 60 * 60 * 1000;
export const STREAM_IDLE_MS = 60 * 60 * 1000;
const REVOCATION_MS = 60_000;
/** Firebase unreachable or failing server-side. Every other failure is a rejection. */
const TRANSIENT_CODES = new Set([
  "app/network-error",
  "app/network-timeout",
  "auth/internal-error",
]);
const isTransient = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof error.code === "string" &&
  TRANSIENT_CODES.has(error.code);
export interface DashboardRequestIdentity {
  readonly principal: Readonly<UserPrincipal>;
  /** Explicit compatibility authority. This is not yet tenant-scoped authorization. */
  readonly mode: "single-operator";
  readonly attributionId: "human:operator";
}
const authenticatedRequests = new WeakMap<IncomingMessage, DashboardRequestIdentity>();
export const getDashboardRequestIdentity = (
  req: IncomingMessage
): DashboardRequestIdentity | undefined => authenticatedRequests.get(req);
export const isAuthenticatedOperatorRequest = (req: IncomingMessage): boolean =>
  authenticatedRequests.has(req);

export interface FirebaseSessionAdapter {
  verifyIdToken(token: string, checkRevoked: boolean): Promise<DecodedIdToken>;
  verifySessionCookie(cookie: string, checkRevoked: boolean): Promise<DecodedIdToken>;
  createSessionCookie(token: string, options: { expiresIn: number }): Promise<string>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function sessionCookie(req: IncomingMessage): string | undefined {
  const matches = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  // Duplicate cookies are ambiguous and never a reason to pick an identity.
  return matches.length === 1 ? matches[0].slice(SESSION_COOKIE.length + 1) : undefined;
}

function setCookie(res: ServerResponse, value: string, maxAge: number): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Strict`
  );
}

/** Unsafe requests must originate from this browser origin (including login/logout).
 * Reverse proxies must preserve Host. Forwarded headers are not trusted as authority. */
export function isSameOrigin(req: IncomingMessage): boolean {
  try {
    const origin = new URL(req.headers.origin ?? "");
    return (
      origin.host === req.headers.host &&
      (origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) &&
      req.headers["sec-fetch-site"] !== "cross-site"
    );
  } catch {
    return false;
  }
}

async function readToken(req: IncomingMessage): Promise<string> {
  if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json")
    throw new Error("invalid body");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 16_384) throw new Error("invalid body");
    chunks.push(Buffer.from(chunk));
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !body ||
    typeof body !== "object" ||
    !("idToken" in body) ||
    typeof body.idToken !== "string" ||
    !body.idToken
  )
    throw new Error("invalid body");
  return body.idToken;
}

/** One operator, durable verified identity, unchanged human:operator authority. */
export class DashboardAuth {
  private readonly csrf = new DashboardCsrf();
  private readonly revocations = new Map<string, number>();
  private readonly streams = new Map<
    ServerResponse,
    { cookie: string; timer: ReturnType<typeof setInterval> }
  >();

  constructor(
    readonly config: DashboardAuthConfig,
    private readonly firebase: FirebaseSessionAdapter,
    private readonly identities: DashboardIdentityResolver,
    private readonly now = Date.now,
    private readonly dispose: () => Promise<void> = async () => {},
    private readonly emulatorUrl?: string
  ) {}

  clientConfig(): object {
    const { projectId, apiKey, authDomain } = this.config.firebase;
    return {
      enabled: true,
      firebase: { projectId, apiKey, authDomain },
      ...(this.emulatorUrl ? { emulatorUrl: this.emulatorUrl } : {}),
    };
  }

  private admitted(token: DecodedIdToken): void {
    if (
      token.email_verified !== true ||
      token.email?.trim().toLowerCase() !== this.config.email ||
      token.firebase?.sign_in_provider !== "google.com" ||
      !token.uid ||
      token.exp * 1000 <= this.now()
    ) {
      throw new Error("unauthorized");
    }
  }

  private resolvePrincipal(token: DecodedIdToken): UserPrincipal {
    // Firebase ID tokens and session cookies use different transport issuers.
    // The SDK verified the configured project; key both by its canonical ID-token issuer.
    return this.identities.resolve({
      ...token,
      iss: `https://securetoken.google.com/${this.config.firebase.projectId}`,
    });
  }

  private async verify(
    cookie: string,
    forceRevocation = false
  ): Promise<{ token: DecodedIdToken; principal: UserPrincipal }> {
    const key = createHash("sha256").update(cookie).digest("hex");
    const checkedAt = this.revocations.get(key);
    const checkRevoked =
      forceRevocation || checkedAt === undefined || this.now() - checkedAt >= REVOCATION_MS;
    // Signature/project/expiry verification is never cached by this layer.
    const token = await this.firebase.verifySessionCookie(cookie, checkRevoked).catch((error) => {
      // Firebase being unreachable is not a revocation: signature, expiry, and admission
      // still gate the request locally, and the revocation check resumes next window.
      if (!checkRevoked || !isTransient(error)) throw error;
      return this.firebase.verifySessionCookie(cookie, false);
    });
    this.admitted(token);
    const principal = this.resolvePrincipal(token);
    if (checkRevoked) {
      // Renewal issues a fresh cookie on every navigation, so entries expire rather than
      // accumulate; a failed attempt also counts, so an outage costs one call per window.
      for (const [stale, at] of this.revocations) {
        if (this.now() - at >= REVOCATION_MS) this.revocations.delete(stale);
      }
      this.revocations.set(key, this.now());
    }
    return { token, principal };
  }

  async authorize(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    authenticatedRequests.delete(req);
    try {
      const cookie = sessionCookie(req);
      if (!cookie) throw new Error("unauthorized");
      const { principal } = await this.verify(cookie);
      if (
        !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "") &&
        (!isSameOrigin(req) || !this.csrf.verify(req, cookie))
      ) {
        json(res, 403, { error: "Forbidden" });
        return false;
      }
      res.setHeader("Cache-Control", "no-store");
      authenticatedRequests.set(
        req,
        Object.freeze({
          principal: Object.freeze({
            ...principal,
            ...(principal.identity ? { identity: Object.freeze({ ...principal.identity }) } : {}),
          }),
          mode: "single-operator",
          attributionId: "human:operator",
        })
      );
      return true;
    } catch (error) {
      // 401 is the browser's signal to sign in again, so an unreachable Firebase
      // must not send one.
      if (isTransient(error)) json(res, 503, { error: "Authentication unavailable" });
      else json(res, 401, { error: "Authentication required" });
      return false;
    }
  }

  /** Auth routes are handled before all dashboard/data/voice dispatch. */
  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (!pathname.startsWith("/api/auth/")) return false;
    if (req.method === "GET" && pathname === "/api/auth/csrf") {
      // Custom header prevents cross-origin form/navigation bootstrap; no CORS permission
      // is granted to a foreign preflight. Bootstrap never extends the auth session.
      if (
        req.headers["x-rusa-csrf-bootstrap"] !== "1" ||
        req.headers["sec-fetch-site"] === "cross-site" ||
        (req.headers.origin !== undefined && !isSameOrigin(req))
      ) {
        json(res, 403, { error: "Forbidden" });
      } else {
        this.csrf.issue(req, res, sessionCookie(req) ?? "", SESSION_MS / 1000);
        json(res, 200, { ok: true });
      }
      return true;
    }
    if (req.method === "GET" && pathname === "/api/auth/config") {
      json(res, 200, this.clientConfig());
      return true;
    }
    if (req.method === "GET" && pathname === "/api/auth/session") {
      if (await this.authorize(req, res)) json(res, 200, { authenticated: true });
      return true;
    }
    if (
      req.method !== "POST" ||
      !isSameOrigin(req) ||
      !this.csrf.verify(req, sessionCookie(req) ?? "")
    ) {
      json(res, 403, { error: "Forbidden" });
      return true;
    }
    if (pathname === "/api/auth/logout") {
      const cookie = sessionCookie(req);
      for (const [res, stream] of this.streams) {
        if (stream.cookie === cookie) this.endStream(res, "auth_required");
      }
      setCookie(res, "", 0);
      this.csrf.issue(req, res, "", SESSION_MS / 1000);
      json(res, 200, { ok: true });
      return true;
    }
    if (pathname !== "/api/auth/session" && pathname !== "/api/auth/refresh") {
      json(res, 404, { error: "Not found" });
      return true;
    }
    try {
      // A remembered Firebase refresh token alone must never resurrect an idle Rusa session.
      const previous =
        pathname === "/api/auth/refresh" ? await this.verify(sessionCookie(req) ?? "") : undefined;
      const idToken = await readToken(req);
      const token = await this.firebase.verifyIdToken(idToken, true);
      this.admitted(token);
      if (
        previous
          ? previous.token.uid !== token.uid
          : !Number.isFinite(token.auth_time) ||
            this.now() / 1000 - token.auth_time > 300 ||
            token.auth_time > this.now() / 1000
      ) {
        throw new Error("unauthorized");
      }
      const principal = this.resolvePrincipal(token);
      const cookie = await this.firebase.createSessionCookie(idToken, { expiresIn: SESSION_MS });
      this.identities.recordAuthentication(principal, new Date(this.now()).toISOString());
      setCookie(res, cookie, SESSION_MS / 1000);
      this.csrf.issue(req, res, cookie, SESSION_MS / 1000);
      json(res, 200, { authenticated: true });
    } catch (error) {
      // Never forward SDK errors, tokens, emails, or credential paths to logs or responses.
      // An unreachable Firebase is reported as unavailable so the browser retries rather
      // than discarding a still-valid session.
      if (isTransient(error)) json(res, 503, { error: "Authentication unavailable" });
      else json(res, 401, { error: "Authentication required" });
    }
    return true;
  }

  /** Live connections cannot outlive verification or an hour without reconnecting.
   * The browser reconnects on navigation and stops auto-reconnect while idle. */
  guardStream(req: IncomingMessage, res: ServerResponse): void {
    const cookie = sessionCookie(req);
    if (!cookie) return;
    const openedAt = this.now();
    let checking = false;
    const timer = setInterval(async () => {
      if (this.now() - openedAt >= STREAM_IDLE_MS) {
        this.endStream(res, "session_idle");
        return;
      }
      if (checking) return;
      checking = true;
      try {
        await this.verify(cookie, true);
      } catch {
        this.endStream(res, "auth_required");
      } finally {
        checking = false;
      }
    }, REVOCATION_MS);
    timer.unref();
    this.streams.set(res, { cookie, timer });
    res.once("close", () => {
      clearInterval(timer);
      this.streams.delete(res);
    });
  }

  private endStream(res: ServerResponse, event?: string): void {
    const stream = this.streams.get(res);
    if (stream) clearInterval(stream.timer);
    this.streams.delete(res);
    if (!res.writableEnded) res.end(event ? `event: ${event}\ndata: {}\n\n` : undefined);
  }

  async close(): Promise<void> {
    // Shutdown is not an authentication event: a plain close lets the browser's native
    // reconnect resume the still-valid session once the server is back.
    for (const res of this.streams.keys()) this.endStream(res);
    this.revocations.clear();
    await this.dispose();
  }
}

export function createDashboardAuth(
  config: DashboardAuthConfig,
  principals: PrincipalRepository
): DashboardAuth {
  validateDashboardAuth(config);
  // Auth emulators accept unsigned tokens. Never inherit this bypass in the production boundary.
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST)
    throw new Error("Dashboard authentication cannot use the Firebase Auth emulator");
  // Startup-only failures: each names its cause for the operator's terminal or journal.
  // None of these run for a request, so nothing here can reach a client.
  const { projectId, serviceAccountKeyPath } = config.firebase;
  const fail = (message: string, cause?: unknown): Error =>
    new Error(`${message}: ${serviceAccountKeyPath}`, { cause });
  let raw: string;
  try {
    raw = readFileSync(serviceAccountKeyPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "unreadable";
    throw fail(`Could not read auth.firebase.serviceAccountKeyPath (${code})`, error);
  }
  let credential: unknown;
  try {
    credential = JSON.parse(raw);
  } catch (error) {
    throw fail("auth.firebase.serviceAccountKeyPath is not valid JSON", error);
  }
  if (
    typeof credential !== "object" ||
    credential === null ||
    (credential as { project_id?: unknown }).project_id !== projectId
  ) {
    throw fail(`Service account project_id does not match auth.firebase.projectId (${projectId})`);
  }
  try {
    const app = initializeApp(
      { projectId, credential: cert(credential as ServiceAccount) },
      `rusa-dashboard-${randomUUID()}`
    );
    return new DashboardAuth(
      config,
      getAuth(app),
      new DashboardIdentityResolver(() => principals),
      Date.now,
      () => deleteApp(app)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not initialize dashboard Firebase authentication: ${message}`, {
      cause: error,
    });
  }
}
