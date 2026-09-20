// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { expect, it, vi } from "vitest";
import type { DashboardDataDeps } from "../dashboard/api.js";
import { DashboardAuth } from "../dashboard/auth.js";
import { DashboardIdentityResolver } from "../dashboard/identity.js";
import { createDashboardRequestHandler, type DashboardMeshRefs } from "../webhook/server.js";

// Requires a built Flutter dashboard and installed Playwright Chromium.
it.skipIf(!process.env.RUSA_BRANDING_BROWSER_TEST)(
  "keeps instance branding through signed-out Flutter startup and reload",
  async () => {
    const unexpected = async (): Promise<never> => {
      throw new Error("Signed-out branding must not call Firebase session verification");
    };
    const auth = new DashboardAuth(
      {
        email: "operator@example.com",
        firebase: {
          projectId: "demo-rusa",
          apiKey: "fake-api-key",
          authDomain: "demo-rusa.firebaseapp.com",
          appId: "1:123456789:web:abcdef",
          messagingSenderId: "123456789",
        },
      },
      {
        verifyIdToken: unexpected,
        verifySessionCookie: unexpected,
        createSessionCookie: unexpected,
      },
      new DashboardIdentityResolver(() => {
        throw new Error("Signed-out branding must not resolve a user");
      }, "demo-rusa")
    );
    const home = mkdtempSync(join(tmpdir(), "rusa-branding-browser-"));
    vi.stubEnv("RUSA_HOME", home);
    const avatarPath = join(home, "custom.png");
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=",
      "base64"
    );
    writeFileSync(avatarPath, image);
    const rootIdentity = { handle: "ember-familiar", avatarPath };
    const server = createServer(
      createDashboardRequestHandler(
        { port: 0, mesh: { rootIdentity } as DashboardMeshRefs },
        { rootIdentity } as DashboardDataDeps,
        null,
        auth
      )
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP server");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      for (let visit = 0; visit < 2; visit++) {
        if (visit) await page.reload();
        const semantics = page.locator("flt-semantics-placeholder");
        await semantics.waitFor({ state: "attached" });
        await semantics.evaluate((element) => (element as HTMLElement).click());
        await page.getByText("Sign in with Google", { exact: true }).waitFor();
        expect(await page.title()).toBe("Ember Familiar");
        const icons = await page
          .locator('link[rel="icon"]')
          .evaluateAll((elements) => elements.map((element) => element.getAttribute("href")));
        expect(icons).toHaveLength(1);
        expect(icons[0]).toContain("/api/mesh/avatar/root.png?v=");
        const icon = await page.request.get(new URL(icons[0] as string, origin).href);
        expect(icon.status()).toBe(200);
        expect(await icon.body()).toEqual(image);
        expect(icon.headers()["content-type"]).toContain("image/");
        expect((await page.request.get(`${origin}/manifest.json`)).status()).toBe(200);
        expect((await page.request.get(`${origin}/api/mesh/threads`)).status()).toBe(401);
      }
    } finally {
      await browser.close();
      await auth.close();
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  90_000
);
