import { initializeApp } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  GoogleAuthProvider,
  getAuth,
  setPersistence,
  signInWithPopup,
  signOut,
} from "firebase/auth";

const IDLE_MS = 60 * 60 * 1000;

function clearDashboardCaches(): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("rusa.dashboard.")) localStorage.removeItem(key);
    }
  } catch {
    /* Storage may be unavailable in private browsing. */
  }
}

function bootDashboard(): void {
  document.getElementById("rusa-login")?.remove();
  const script = document.createElement("script");
  script.src = "/flutter_bootstrap.js";
  script.async = true;
  document.body.append(script);
}

function loginView(
  message: string,
  action?: () => Promise<void>,
  label = "Sign in with Google"
): void {
  document.getElementById("rusa-login")?.remove();
  const panel = document.createElement("main");
  panel.id = "rusa-login";
  panel.style.cssText =
    "position:fixed;inset:0;display:grid;place-content:center;gap:20px;padding:24px;background:#0f172a;color:#f8fafc;font:16px system-ui;text-align:center;z-index:2147483647";
  const title = document.createElement("h1");
  title.textContent = "Rusa";
  const text = document.createElement("p");
  text.textContent = message;
  text.setAttribute("role", "status");
  const button = document.createElement("button");
  button.textContent = label;
  button.style.cssText =
    "padding:14px 24px;border:0;border-radius:8px;background:#38bdf8;color:#0f172a;font:inherit;cursor:pointer";
  button.onclick = async () => {
    button.disabled = true;
    try {
      await action?.();
    } catch {
      text.textContent =
        "Unable to sign in. Check your connection and use the configured Google account.";
    } finally {
      button.disabled = false;
    }
  };
  panel.append(title, text);
  if (action) panel.append(button);
  document.body.append(panel);
}

export async function startDashboardAuth(reload = () => window.location.reload()): Promise<void> {
  loginView("Connecting to Rusa…");
  const response = await fetch("/api/auth/config", { cache: "no-store" });
  if (!response.ok) throw new Error("Configuration unavailable");
  const config = await response.json();
  if (config.enabled === false) {
    bootDashboard();
    return;
  }
  if (config.enabled !== true || !config.firebase) throw new Error("Configuration unavailable");
  const auth = getAuth(initializeApp(config.firebase, "rusa-dashboard"));
  if (config.emulatorUrl) connectAuthEmulator(auth, config.emulatorUrl);
  // Firebase's refresh credential is retained solely to renew a still-valid Rusa cookie.
  // A remembered Firebase identity never suffices to recreate an expired Rusa session.
  await setPersistence(auth, browserLocalPersistence);
  await auth.authStateReady();

  const post = (path: string, idToken?: string) =>
    fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(idToken ? { idToken } : {}),
      credentials: "same-origin",
      cache: "no-store",
    });
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });

  const login = async () => {
    const result = await signInWithPopup(auth, provider);
    const response = await post("session", await result.user.getIdToken(true));
    if (!response.ok) {
      await signOut(auth);
      throw new Error("Sign in denied");
    }
    // The next bootstrap verifies that the browser actually accepted the Secure cookie.
    reload();
  };

  const session = await fetch("/api/auth/session", { cache: "no-store" });
  if (session.status === 401 || !auth.currentUser) {
    clearDashboardCaches();
    await signOut(auth);
    loginView("Sign in to your agent dashboard.", login);
    return;
  }
  if (!session.ok) throw new Error("Session unavailable");

  let expiring = false;
  const idle = () => {
    document.documentElement.dataset.rusaSessionIdle = "true";
    window.dispatchEvent(new Event("rusa-session-idle"));
  };
  const expire = async () => {
    if (expiring) return;
    expiring = true;
    clearDashboardCaches();
    idle();
    // Cover the UI immediately, including data held by Flutter/browser caches.
    loginView("Your session has ended. Sign in to continue.", login);
    await signOut(auth);
    // Tear down Flutter, polling, microphone capture, and audio as well as SSE.
    // The next boot sees no Firebase user and remains at the login screen.
    reload();
  };
  let idleTimer: ReturnType<typeof setTimeout>;
  let renewing: Promise<void> | undefined;
  const activity = (): Promise<void> => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(idle, IDLE_MS);
    // Coalesce simultaneous navigation notifications, never background polls.
    if (renewing) return renewing;
    renewing = (async () => {
      if (expiring) return;
      const user = auth.currentUser;
      if (!user) {
        await expire();
        return;
      }
      const refreshed = await post("refresh", await user.getIdToken(true));
      if (refreshed.status === 401) {
        await expire();
        return;
      }
      if (!refreshed.ok) throw new Error("Session refresh unavailable");
      delete document.documentElement.dataset.rusaSessionIdle;
      window.dispatchEvent(new Event("rusa-session-active"));
    })().finally(() => {
      renewing = undefined;
    });
    return renewing;
  };

  window.addEventListener("rusa-navigation", () => {
    void activity().catch(() => {});
  });
  window.addEventListener("popstate", () => {
    void activity().catch(() => {});
  });
  // Returning to a visible tab is a visit, but leaving an unattended tab open is not.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void activity().catch(() => {});
  });
  window.addEventListener("rusa-auth-required", () => {
    void expire();
  });
  window.addEventListener("rusa-logout", () => {
    void (async () => {
      const result = await post("logout");
      if (!result.ok) throw new Error("Logout failed");
      await expire();
    })().catch(() =>
      loginView(
        "Unable to sign out. Check your connection and retry.",
        async () => {
          const result = await post("logout");
          if (!result.ok) throw new Error("Logout failed");
          await expire();
        },
        "Retry sign out"
      )
    );
  });
  // Firebase sign-out is shared across tabs, so every open dashboard is covered.
  auth.onAuthStateChanged((user) => {
    if (!user) void expire();
  });
  await activity();
  if (!expiring) {
    // Restore private instance branding only after authentication. The public
    // login shell must not expose the configured actor's name or avatar.
    const manifestResponse = await fetch("/manifest.json", { cache: "no-store" });
    if (manifestResponse.status === 401) {
      await expire();
      return;
    }
    if (manifestResponse.ok) {
      const manifest = await manifestResponse.json();
      if (typeof manifest.name === "string") document.title = manifest.name;
      const link = document.createElement("link");
      link.rel = "manifest";
      link.href = "/manifest.json";
      document.head.append(link);
      const icon = manifest.icons?.[0]?.src;
      if (typeof icon === "string") {
        const favicon = document.createElement("link");
        favicon.rel = "icon";
        favicon.href = icon;
        document.head.append(favicon);
      }
    }
    document.documentElement.dataset.rusaAuth = "enabled";
    document.documentElement.dataset.rusaProfilePhoto = auth.currentUser?.photoURL ?? "";
    bootDashboard();
  }
}

export function showAuthStartupError(): void {
  loginView(
    "Unable to connect to Rusa. Please try again.",
    async () => window.location.reload(),
    "Retry"
  );
}
