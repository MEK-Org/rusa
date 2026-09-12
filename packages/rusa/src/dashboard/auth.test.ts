// @vitest-environment node
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DecodedIdToken } from "firebase-admin/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardRequestHandler } from "../webhook/server.js";
import type { DashboardDataDeps } from "./api.js";
import { DashboardAuth, SESSION_COOKIE, SESSION_MS, STREAM_IDLE_MS } from "./auth.js";

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
  iss: "issuer",
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
  const firebase = {
    verifyIdToken: vi.fn(async (value: string, _check: boolean) => {
      if (value !== "id-token" || revoked)
        throw new Error("sensitive Firebase error /private/credential.json");
      return token;
    }),
    verifySessionCookie: vi.fn(async (value: string, check: boolean) => {
      const cookie = cookies.get(value);
      if (!cookie || (check && revoked)) throw new Error("sensitive session error");
      return cookie;
    }),
    createSessionCookie: vi.fn(async (_value: string, options: { expiresIn: number }) => {
      const name = `cookie-${++serial}`;
      cookies.set(name, claim({ exp: (now + options.expiresIn) / 1000 }));
      return name;
    }),
  };
  let auth: DashboardAuth;
  let server: ReturnType<typeof createServer>;
  let origin: string;
  const interrupt = vi.fn(() => ({ interrupted: true, status: "interrupted" }));
  beforeEach(async () => {
    now = Date.now();
    serial = 0;
    revoked = false;
    token = claim();
    cookies.clear();
    vi.clearAllMocks();
    auth = new DashboardAuth(config, firebase, () => now);
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
    vi.useRealTimers();
  });
  const post = (path: string, cookie?: string, extra: Record<string, string> = {}) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        ...extra,
      },
      body: JSON.stringify({ idToken: "id-token" }),
    });
  async function login(): Promise<string> {
    const res = await post("/api/auth/session");
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie");
    if (!cookie) throw new Error("Expected a session cookie");
    return cookie.split(";")[0];
  }

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
    expect(await shell.text()).not.toContain(config.email);
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
    expect(res.headers.get("set-cookie")).toBe(
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

  it("clears the browser cookie on logout", async () => {
    const cookie = await login();
    const res = await post("/api/auth/logout", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("binds authenticated actions to human:operator instead of a body-supplied identity", async () => {
    const cookie = await login();
    const res = await fetch(`${origin}/api/mesh/actors/actor/interrupt`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
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
    revoked = true;
    now += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.end).toHaveBeenCalledWith(expect.stringContaining("auth_required"));
    revoked = false;
    const second = response();
    auth.guardStream(req, second);
    now += STREAM_IDLE_MS;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(second.end).toHaveBeenCalledWith(expect.stringContaining("session_idle"));
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
});
