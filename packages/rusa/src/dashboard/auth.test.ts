// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DecodedIdToken } from "firebase-admin/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { createDashboardRequestHandler, startDashboardServer } from "../webhook/server.js";
import type { DashboardDataDeps } from "./api.js";
import {
  createDashboardAuth,
  DashboardAuth,
  getDashboardRequestIdentity,
  SESSION_COOKIE,
  SESSION_MS,
  STREAM_IDLE_MS,
} from "./auth.js";
import { DashboardIdentityResolver } from "./identity.js";

const config = {
  email: "owner@example.com",
  firebase: {
    projectId: "project",
    apiKey: "public-key",
    authDomain: "project.firebaseapp.com",
    serviceAccountKeyPath: "/private/credential.json",
  },
};
let now = Date.now();
const claim = (extra: Partial<DecodedIdToken> = {}): DecodedIdToken => ({
  uid: "owner-id",
  sub: "owner-id",
  aud: "project",
  iss: "https://securetoken.google.com/project",
  iat: now / 1000,
  exp: (now + SESSION_MS) / 1000,
  auth_time: Math.floor(now / 1000),
  email: "OWNER@example.com",
  email_verified: true,
  firebase: { identities: {}, sign_in_provider: "google.com" },
  ...extra,
});

describe("single-operator dashboard authentication", () => {
  const cookies = new Map<string, DecodedIdToken>();
  let token: DecodedIdToken;
  let serial: number;
  let revoked: boolean;
  // Firebase unreachable: every network-backed call fails with the SDK's transport code.
  let unreachable: boolean;
  const outage = () =>
    Object.assign(new Error("connect ECONNREFUSED"), { code: "app/network-error" });
  const firebase = {
    verifyIdToken: vi.fn(async (value: string, _check: boolean) => {
      if (unreachable) throw outage();
      if (value !== "id-token" || revoked)
        throw new Error("sensitive Firebase error /private/credential.json");
      return token;
    }),
    verifySessionCookie: vi.fn(async (value: string, check: boolean) => {
      const cookie = cookies.get(value);
      if (!cookie) throw new Error("sensitive session error");
      // Signature verification survives an outage on cached certificates.
      if (unreachable && check) throw outage();
      if (check && revoked) throw new Error("sensitive session error");
      return cookie;
    }),
    createSessionCookie: vi.fn(async (_value: string, options: { expiresIn: number }) => {
      const name = `cookie-${++serial}`;
      cookies.set(
        name,
        claim({
          iss: "https://session.firebase.google.com/project",
          exp: (now + options.expiresIn) / 1000,
        })
      );
      return name;
    }),
  };
  let auth: DashboardAuth;
  let db: Database.Database;
  let principals: PrincipalRepository;
  let server: ReturnType<typeof createServer>;
  let origin: string;
  const interrupt = vi.fn(() => ({ interrupted: true, status: "interrupted" }));
  beforeEach(async () => {
    now = Date.now();
    serial = 0;
    revoked = false;
    unreachable = false;
    token = claim();
    cookies.clear();
    vi.clearAllMocks();
    db = new Database(":memory:");
    runMigrations(db);
    principals = new PrincipalRepository(db);
    auth = new DashboardAuth(
      config,
      firebase,
      new DashboardIdentityResolver(() => principals),
      () => now
    );
    server = createServer(
      createDashboardRequestHandler(
        { port: 0, auth: config },
        {
          actors: { get: () => ({ id: "actor", status: "active" }) },
          mesh: { interrupt },
        } as unknown as DashboardDataDeps,
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
    vi.useRealTimers();
  });
  const post = async (path: string, cookie?: string, extra: Record<string, string> = {}) => {
    const bootstrap = await fetch(`${origin}/api/auth/csrf`, {
      headers: { "X-Rusa-CSRF-Bootstrap": "1", ...(cookie ? { Cookie: cookie } : {}) },
    });
    const csrfCookie = bootstrap.headers.getSetCookie()[0].split(";")[0];
    return fetch(origin + path, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: [cookie, csrfCookie].filter(Boolean).join("; "),
        "X-Rusa-CSRF": csrfCookie.slice(csrfCookie.indexOf("=") + 1),
        ...extra,
      },
      body: JSON.stringify({ idToken: "id-token" }),
    });
  };
  async function login(): Promise<string> {
    const res = await post("/api/auth/session");
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    if (!cookie) throw new Error("Expected a session cookie");
    return cookie.split(";")[0];
  }

  it("binds a durable principal without changing operator authority or exposing the token", async () => {
    const cookie = await login();
    const req = { headers: { cookie }, method: "GET" } as IncomingMessage;
    const res = {
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    expect(await auth.authorize(req, res)).toBe(true);
    const context = getDashboardRequestIdentity(req);
    expect(context).toMatchObject({
      mode: "single-operator",
      attributionId: "human:operator",
      principal: { kind: "user", identity: { issuer: token.iss, subject: token.sub } },
    });
    expect(context?.principal.rootActorId).toBeUndefined();
    expect(Object.isFrozen(context)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("cookie-1");
    expect(JSON.stringify(context)).not.toContain("id-token");
    const user = principals.findUserByExternalIdentity({ issuer: token.iss, subject: token.sub });
    expect(user?.id).toBe(context?.principal.id);
    expect(user?.lastAuthenticatedAt).toBe(new Date(now).toISOString());
    if (!user) throw new Error("Expected durable user");
    principals.setDisabled(user.id, new Date(now).toISOString());
    expect(await auth.authorize(req, res)).toBe(false);
    expect(getDashboardRequestIdentity(req)).toBeUndefined();
    expect((await post("/api/auth/session", cookie)).status).toBe(401);
    expect((await post("/api/auth/refresh", cookie)).status).toBe(401);
    expect(principals.getUser(user.id)?.identity).toEqual(user.identity);
  });

  it("resolves existing cookies across resolver restarts without claiming roots or changing history", async () => {
    const cookie = await login();
    const user = principals.findUserByExternalIdentity({ issuer: token.iss, subject: token.sub });
    const restarted = new DashboardAuth(
      config,
      firebase,
      new DashboardIdentityResolver(() => new PrincipalRepository(db)),
      () => now
    );
    const req = { headers: { cookie }, method: "GET" } as IncomingMessage;
    const res = {
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    now += 60000;
    expect(await restarted.authorize(req, res)).toBe(true);
    expect(getDashboardRequestIdentity(req)?.principal.id).toBe(user?.id);
    expect(principals.getUser(user?.id ?? "")?.lastAuthenticatedAt).toBe(user?.lastAuthenticatedAt);
    await restarted.close();
  });

  it("requires a protected bootstrap, without authenticating or extending a session", async () => {
    expect((await fetch(`${origin}/api/auth/csrf`)).status).toBe(403);
    expect(
      (
        await fetch(`${origin}/api/auth/csrf`, {
          headers: {
            "X-Rusa-CSRF-Bootstrap": "1",
            Origin: "https://evil.example",
          },
        })
      ).status
    ).toBe(403);
    const response = await fetch(`${origin}/api/auth/csrf`, {
      headers: { "X-Rusa-CSRF-Bootstrap": "1" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.getSetCookie()[0];
    expect(cookie).toMatch(/^__Host-rusa_csrf=[a-f0-9]{64}\.[a-f0-9]{64};/);
    expect(cookie).toContain("Path=/; Secure; SameSite=Strict");
    expect(cookie).not.toContain("HttpOnly");
    expect(firebase.createSessionCookie).not.toHaveBeenCalled();
  });

  it.each([
    "/api/auth/session",
    "/api/auth/refresh",
    "/api/auth/logout",
    "/api/mesh/actors/actor/interrupt",
  ])("rejects missing or forged double-submit tokens on %s", async (path) => {
    const cookie = await login();
    for (const csrf of ["", `${"a".repeat(64)}.${"b".repeat(64)}`]) {
      const response = await fetch(origin + path, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: `${cookie}; __Host-rusa_csrf=${csrf}`,
          "X-Rusa-CSRF": csrf,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ idToken: "id-token" }),
      });
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(interrupt).not.toHaveBeenCalled();
    expect(firebase.createSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched, duplicate, and another session's CSRF cookie", async () => {
    const first = await login();
    const response = await fetch(`${origin}/api/auth/csrf`, {
      headers: {
        "X-Rusa-CSRF-Bootstrap": "1",
        Cookie: first,
      },
    });
    const csrfCookie = response.headers.getSetCookie()[0].split(";")[0];
    const csrf = csrfCookie.split("=")[1];
    const second = await login();
    for (const [cookie, header] of [
      [`${first}; ${csrfCookie}`, "mismatch"],
      [`${first}; ${csrfCookie}; ${csrfCookie}`, csrf],
      [`${second}; ${csrfCookie}`, csrf],
      [csrfCookie, csrf],
    ]) {
      expect(
        (
          await fetch(`${origin}/api/auth/logout`, {
            method: "POST",
            headers: {
              Origin: origin,
              Cookie: cookie,
              "X-Rusa-CSRF": header,
            },
          })
        ).status
      ).toBe(403);
    }
  });

  it("exposes only client-safe config and a generic login shell", async () => {
    const res = await fetch(`${origin}/api/auth/config`);
    expect(await res.json()).toEqual({
      enabled: true,
      firebase: {
        projectId: "project",
        apiKey: "public-key",
        authDomain: "project.firebaseapp.com",
      },
    });
    const shell = await fetch(`${origin}/actors/some-actor`);
    expect(shell.headers.get("cache-control")).toBe("no-store");
    const html = await shell.text();
    expect(html).not.toContain(config.email);
    // The login shell replaces Flutter's generated page, and bootDashboard() re-injects
    // the loader by hand; both silently drift if the template ever needs more than that.
    const template = readFileSync(
      new URL("../../flutter_dashboard/web/index.html", import.meta.url),
      "utf8"
    );
    expect(template.match(/<script[^>]*>/g)).toEqual(['<script src="flutter_bootstrap.js" async>']);
    expect(template).toContain('<base href="$FLUTTER_BASE_HREF">');
    expect(html).toContain('<base href="/">');
    expect(html).toContain('<script src="/dashboard-auth.js" defer>');
  });

  it.each([
    "/api/mesh/threads",
    "/api/mesh/chat",
    "/api/mesh/events",
    "/api/mesh/stream",
    "/api/mesh/obligations",
    "/api/mesh/voice/stream",
    "/api/mesh/voice/audio/opaque-id",
    "/api/mesh/avatar/actor.png",
    "/api/quota",
    "/api/understanding/ops",
    "/api/dashboard/config",
    "/api/new-route",
  ])("denies anonymous access before dispatch: %s", async (path) => {
    const res = await fetch(origin + path);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });

  it("accepts the verified sole Google user and protects cookie attributes", async () => {
    const res = await post("/api/auth/session");
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()[0]).toBe(
      `${SESSION_COOKIE}=cookie-1; Max-Age=432000; Path=/; Secure; HttpOnly; SameSite=Strict`
    );
    const authorized = await fetch(`${origin}/api/dashboard/config`, {
      headers: { Cookie: `${SESSION_COOKIE}=cookie-1` },
    });
    expect(authorized.status).toBe(200);
    expect(firebase.verifyIdToken).toHaveBeenCalledWith("id-token", true);
    expect(firebase.verifySessionCookie).toHaveBeenCalledWith("cookie-1", true);
  });

  it.each([
    { email: "other@example.com" },
    { email_verified: false },
    { exp: 1 },
    { auth_time: 1 },
    { auth_time: Number.NaN },
    { uid: "" },
    { firebase: { identities: {}, sign_in_provider: "password" } },
  ])("rejects inadmissible token claims without leaking details: %j", async (extra) => {
    token = claim(extra);
    const res = await post("/api/auth/session");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"Authentication required"}');
    expect(firebase.createSessionCookie).not.toHaveBeenCalled();
  });

  it("contains SDK verification failures and accepts no cookie", async () => {
    firebase.verifyIdToken.mockRejectedValueOnce(new Error("wrong project/signature secret-token"));
    const res = await post("/api/auth/session");
    expect(res.status).toBe(401);
    expect(await res.text()).not.toMatch(/secret|project|signature/);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("renews a valid session from an old login, but expires after five idle days", async () => {
    const original = await login();
    now += 4 * 24 * 60 * 60 * 1000;
    token = claim({ auth_time: token.auth_time });
    const refreshed = await post("/api/auth/refresh", original);
    expect(refreshed.status).toBe(200);
    const renewed = refreshed.headers.get("set-cookie")?.split(";")[0] ?? "";
    now += 2 * 24 * 60 * 60 * 1000;
    expect(
      (await fetch(`${origin}/api/auth/session`, { headers: { Cookie: renewed } })).status
    ).toBe(200);
    expect((await post("/api/auth/refresh", original)).status).toBe(401);
    now += 3 * 24 * 60 * 60 * 1000;
    expect((await post("/api/auth/refresh", renewed)).status).toBe(401);
    expect((await post("/api/auth/session")).status).toBe(401);
  });

  it("never renews on polling, and requires the same Firebase identity for refresh", async () => {
    const cookie = await login();
    const polled = await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } });
    expect(polled.headers.get("set-cookie")).toBeNull();
    token = claim({ uid: "replacement-identity" });
    expect((await post("/api/auth/refresh", cookie)).status).toBe(401);
    expect((await post("/api/auth/refresh")).status).toBe(401);
  });

  it.each([
    "",
    "https://evil.example",
    "null",
  ])("rejects missing/cross-origin mutations and login: %s", async (other) => {
    const cookie = await login();
    for (const path of [
      "/api/auth/session",
      "/api/auth/refresh",
      "/api/auth/logout",
      "/api/mesh/actors",
    ]) {
      expect((await post(path, cookie, { Origin: other })).status).toBe(403);
    }
  });

  it("rejects revoked users within the cache bound and rejects duplicate cookies", async () => {
    const cookie = await login();
    await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } });
    revoked = true;
    now += 60_000;
    expect(
      (await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } })).status
    ).toBe(401);
    expect(
      (await fetch(`${origin}/api/auth/session`, { headers: { Cookie: `${cookie}; ${cookie}` } }))
        .status
    ).toBe(401);
  });

  it("keeps a valid session through a Firebase outage, and rejects once revocation is visible", async () => {
    const cookie = await login();
    const session = () => fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } });
    expect((await session()).status).toBe(200);
    unreachable = true;
    now += 60_000;
    firebase.verifySessionCookie.mockClear();
    // The revocation attempt fails; signature/expiry/admission still pass locally.
    expect((await session()).status).toBe(200);
    expect(firebase.verifySessionCookie.mock.calls.map(([, check]) => check)).toEqual([
      true,
      false,
    ]);
    // The failed attempt counts for the window, so polling does not retry Firebase per request.
    firebase.verifySessionCookie.mockClear();
    expect((await session()).status).toBe(200);
    expect(firebase.verifySessionCookie.mock.calls.map(([, check]) => check)).toEqual([false]);
    // The outage fallback must still consult the local principal, not just Firebase claims.
    const user = principals.findUserByExternalIdentity({ issuer: token.iss, subject: token.sub });
    if (!user) throw new Error("Expected durable user");
    principals.setDisabled(user.id, new Date(now).toISOString());
    expect((await session()).status).toBe(401);
    principals.setDisabled(user.id, null);
    // Outage-time login and renewal are unavailable, not denied: the browser keeps its session.
    expect((await post("/api/auth/refresh", cookie)).status).toBe(503);
    expect((await post("/api/auth/session")).status).toBe(503);
    // Expiry is still enforced locally during the outage.
    now += SESSION_MS;
    expect((await session()).status).toBe(401);
    now -= SESSION_MS;
    unreachable = false;
    revoked = true;
    now += 60_000;
    expect((await session()).status).toBe(401);
  });

  it("clears the browser cookie on logout", async () => {
    const cookie = await login();
    const res = await post("/api/auth/logout", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each([
    "auth/argument-error",
    "auth/quota-exceeded",
  ])("preserves fail-closed handling for SDK rejection %s", async (code) => {
    const cookie = await login();
    firebase.verifySessionCookie.mockRejectedValueOnce(
      Object.assign(new Error("SDK rejection"), { code })
    );
    expect(
      (await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } })).status
    ).toBe(401);
  });

  it("binds authenticated actions to human:operator instead of a body-supplied identity", async () => {
    const cookie = await login();
    const bootstrap = await fetch(`${origin}/api/auth/csrf`, {
      headers: { "X-Rusa-CSRF-Bootstrap": "1", Cookie: cookie },
    });
    const csrfCookie = bootstrap.headers.getSetCookie()[0].split(";")[0];
    const res = await fetch(`${origin}/api/mesh/actors/actor/interrupt`, {
      method: "POST",
      headers: {
        Cookie: `${cookie}; ${csrfCookie}`,
        Origin: origin,
        "Content-Type": "application/json",
        "X-Rusa-CSRF": csrfCookie.split("=")[1],
      },
      body: JSON.stringify({ by: "forged-actor" }),
    });
    expect(res.status).toBe(200);
    expect(interrupt).toHaveBeenCalledWith("actor", "human:operator");
  });

  it("closes live streams on revocation and after an hour", async () => {
    const cookie = await login();
    vi.useFakeTimers();
    const response = () => {
      const res = new EventEmitter() as ServerResponse;
      res.end = vi.fn(() => {
        res.emit("close");
        return res;
      });
      return res;
    };
    const req = { headers: { cookie } } as IncomingMessage;
    const first = response();
    auth.guardStream(req, first);
    // A transport failure during the periodic check leaves the stream open.
    unreachable = true;
    now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.end).not.toHaveBeenCalled();
    unreachable = false;
    revoked = true;
    now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.end).toHaveBeenCalledWith(expect.stringContaining("auth_required"));
    revoked = false;
    const user = principals.findUserByExternalIdentity({ issuer: token.iss, subject: token.sub });
    if (!user) throw new Error("Expected durable user");
    const locallyDisabled = response();
    auth.guardStream(req, locallyDisabled);
    unreachable = true;
    principals.setDisabled(user.id, new Date(now).toISOString());
    now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(locallyDisabled.end).toHaveBeenCalledWith(expect.stringContaining("auth_required"));
    unreachable = false;
    principals.setDisabled(user.id, null);
    const second = response();
    auth.guardStream(req, second);
    now += STREAM_IDLE_MS;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(second.end).toHaveBeenCalledWith(expect.stringContaining("session_idle"));
    // Shutdown closes streams without an auth frame so the browser reconnects on its own.
    const third = response();
    auth.guardStream(req, third);
    await auth.close();
    expect(third.end).toHaveBeenCalledWith(undefined);
  });

  it("preserves unauthenticated mode when auth is absent", async () => {
    const local = createServer(createDashboardRequestHandler({ port: 0 }));
    await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
      expect(await (await fetch(`${base}/api/auth/config`)).json()).toEqual({ enabled: false });
      expect((await fetch(`${base}/api/dashboard/config`)).status).toBe(200);
    } finally {
      local.closeAllConnections();
      await new Promise<void>((resolve) => local.close(() => resolve()));
    }
    expect(() => createDashboardRequestHandler({ port: 0, auth: config })).toThrow(/initialized/);
  });

  it("guards a started server with a pre-built boundary instead of production credentials", async () => {
    // The disposable e2e launcher hands over an emulator boundary; nothing here reads
    // the (nonexistent) service account, so the boundary must be the injected one.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const started = await startDashboardServer({ port, e2eAuth: auth });
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/api/mesh/threads`)).status).toBe(401);
      expect(await (await fetch(`${base}/api/auth/config`)).json()).toEqual(auth.clientConfig());
      // Same boundary instance as the fixture server, so its session is honored here too.
      const cookie = await login();
      expect(
        (await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } })).status
      ).toBe(200);
    } finally {
      await started.close();
    }
  });
});

describe("production boundary startup", () => {
  const db = new Database(":memory:");
  const principals = new PrincipalRepository(db);
  const dir = mkdtempSync(join(tmpdir(), "rusa-auth-"));
  const keyPath = join(dir, "admin.json");
  const withKey = (path = keyPath) => ({
    ...config,
    firebase: { ...config.firebase, serviceAccountKeyPath: path },
  });
  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("names each startup failure without ever serving it", () => {
    // The e2e seam sets this for its own process; the production check must see it unset.
    vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", undefined);
    const missing = join(dir, "missing.json");
    expect(() => createDashboardAuth(withKey(missing), principals)).toThrow(`(ENOENT): ${missing}`);
    writeFileSync(keyPath, "{not json");
    expect(() => createDashboardAuth(withKey(), principals)).toThrow(`not valid JSON: ${keyPath}`);
    writeFileSync(keyPath, JSON.stringify({ project_id: "other-project" }));
    expect(() => createDashboardAuth(withKey(), principals)).toThrow(
      `does not match auth.firebase.projectId (project): ${keyPath}`
    );
    writeFileSync(keyPath, JSON.stringify({ project_id: "project" }));
    expect(() => createDashboardAuth(withKey(), principals)).toThrow(
      /Could not initialize dashboard Firebase authentication: .*private_key/
    );
  });
});
