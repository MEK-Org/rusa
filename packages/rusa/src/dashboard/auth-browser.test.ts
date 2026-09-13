import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  user: {
    photoURL: "https://example.com/operator.png",
    getIdToken: vi.fn(async () => "fresh-token"),
  },
  auth: {
    currentUser: null as null | { getIdToken: () => Promise<string> },
    authStateReady: vi.fn(async () => {}),
    onAuthStateChanged: vi.fn(),
  },
  signOut: vi.fn(async () => {}),
}));
vi.mock("firebase/app", () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock("firebase/auth", () => ({
  getAuth: () => sdk.auth,
  browserLocalPersistence: {},
  setPersistence: vi.fn(async () => {}),
  signOut: sdk.signOut,
  signInWithPopup: vi.fn(async () => ({ user: sdk.user })),
  GoogleAuthProvider: class {
    setCustomParameters() {}
  },
}));

import { startDashboardAuth as start } from "./auth-browser.js";

const reload = vi.fn();
const startDashboardAuth = () => start(reload);

describe("dashboard login and activity", () => {
  let enabled: boolean;
  let sessionStatus: number;
  let refreshStatus: number;
  const requests: string[] = [];
  const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    enabled = true;
    sessionStatus = 200;
    refreshStatus = 200;
    requests.length = 0;
    document.body.innerHTML = "";
    delete document.documentElement.dataset.rusaAuth;
    delete document.documentElement.dataset.rusaProfilePhoto;
    delete document.documentElement.dataset.rusaSessionIdle;
    sdk.auth.currentUser = sdk.user;
    vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-rusa_csrf=test-csrf");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requests.push(url);
        if (url.endsWith("/config"))
          return Response.json({ enabled, firebase: { projectId: "project" } });
        if (url.endsWith("/csrf")) return Response.json({ ok: true });
        const status = url.endsWith("/refresh") ? refreshStatus : sessionStatus;
        return Response.json({}, { status });
      })
    );
    for (const target of [window, document]) {
      const add = target.addEventListener.bind(target);
      vi.spyOn(target, "addEventListener").mockImplementation((type, callback, options) => {
        if (callback) listeners.push([target, type, callback]);
        add(type, callback, options);
      });
    }
  });
  afterEach(() => {
    for (const [target, type, listener] of listeners.splice(0))
      target.removeEventListener(type, listener);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const bootstrap = () => document.querySelector('script[src="/flutter_bootstrap.js"]');

  it("boots immediately without Firebase when auth is absent", async () => {
    enabled = false;
    await startDashboardAuth();
    expect(bootstrap()).not.toBeNull();
    expect(requests).toEqual(["/api/auth/config"]);
    expect(sdk.auth.authStateReady).not.toHaveBeenCalled();
  });

  it("requires explicit login when the cookie expired, even with a remembered Firebase user", async () => {
    sessionStatus = 401;
    await startDashboardAuth();
    expect(sdk.signOut).toHaveBeenCalled();
    expect(bootstrap()).toBeNull();
    expect(document.body.textContent).toContain("Sign in with Google");
    expect(requests).not.toContain("/api/auth/refresh");
  });

  it("renews on a visit, pauses after one idle hour, and resumes on navigation", async () => {
    await startDashboardAuth();
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/csrf",
      expect.objectContaining({ headers: { "X-Rusa-CSRF-Bootstrap": "1" } })
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/auth/refresh",
      expect.objectContaining({ headers: expect.objectContaining({ "X-Rusa-CSRF": "test-csrf" }) })
    );
    expect(document.documentElement.dataset.rusaProfilePhoto).toBe(sdk.user.photoURL);
    expect(bootstrap()).not.toBeNull();
    expect(requests.filter((url) => url.endsWith("/refresh"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(document.documentElement.dataset.rusaSessionIdle).toBe("true");
    await vi.advanceTimersByTimeAsync(4 * 24 * 60 * 60 * 1000);
    expect(requests.filter((url) => url.endsWith("/refresh"))).toHaveLength(1);
    window.dispatchEvent(new Event("rusa-navigation"));
    await vi.waitFor(() =>
      expect(document.documentElement.dataset.rusaSessionIdle).toBeUndefined()
    );
    expect(requests.filter((url) => url.endsWith("/refresh"))).toHaveLength(2);
  });

  it("covers cached dashboard contents and pauses streams when renewal is denied", async () => {
    await startDashboardAuth();
    refreshStatus = 401;
    window.dispatchEvent(new Event("rusa-navigation"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Your session has ended"));
    expect(document.documentElement.dataset.rusaSessionIdle).toBe("true");
    expect(sdk.signOut).toHaveBeenCalled();
  });

  it("handles an API/SSE authentication failure and logout without token leakage", async () => {
    await startDashboardAuth();
    localStorage.setItem("rusa.dashboard.actors.v1", "private cached hierarchy");
    localStorage.setItem("unrelated-preference", "keep");
    window.dispatchEvent(new Event("rusa-auth-required"));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Your session has ended"));
    expect(document.body.textContent).not.toContain("fresh-token");
    expect(reload).toHaveBeenCalled();
    expect(localStorage.getItem("rusa.dashboard.actors.v1")).toBeNull();
    expect(localStorage.getItem("unrelated-preference")).toBe("keep");
  });

  it("clears the cookie before signing out Firebase", async () => {
    await startDashboardAuth();
    window.dispatchEvent(new Event("rusa-logout"));
    await vi.waitFor(() => expect(sdk.signOut).toHaveBeenCalled());
    expect(requests).toContain("/api/auth/logout");
  });
});
