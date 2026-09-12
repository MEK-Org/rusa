// @vitest-environment node
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import { createDashboardRequestHandler } from "../webhook/server.js";
import { DashboardAuth } from "./auth.js";
import { DashboardIdentityResolver } from "./identity.js";

// Requires a built dashboard and Playwright Chromium; no Firebase project/network login.
it.skipIf(process.env.RUSA_AUTH_BROWSER_SMOKE !== "1")(
  "boots the built login shell and auth-disabled Flutter dashboard in Chromium",
  async () => {
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
    const config = {
      email: "owner@example.com",
      firebase: {
        projectId: "fixture-project",
        apiKey: "fixture-public-key",
        authDomain: "fixture-project.firebaseapp.com",
        serviceAccountKeyPath: "/fixture/admin.json",
      },
    };
    const denied = async (): Promise<never> => {
      throw new Error("unauthenticated fixture");
    };
    const auth = new DashboardAuth(
      config,
      {
        verifyIdToken: denied,
        verifySessionCookie: denied,
        createSessionCookie: denied,
      },
      new DashboardIdentityResolver(() => {
        throw new Error("Anonymous smoke must not access identity storage");
      })
    );
    const servers = [
      createServer(createDashboardRequestHandler({ port: 0, auth: config }, null, null, auth)),
      createServer(createDashboardRequestHandler({ port: 0 })),
    ];
    try {
      for (const server of servers)
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = (index: number) =>
        `http://127.0.0.1:${(servers[index].address() as AddressInfo).port}`;
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin(0)}/actors/example`);
      await page.getByRole("button", { name: "Sign in with Google" }).waitFor();
      expect(await page.locator("flutter-view").count()).toBe(0);
      expect((await page.request.get(`${origin(0)}/api/mesh/threads`)).status()).toBe(401);
      expect(await page.content()).not.toContain(config.email);
      await page.goto(origin(1));
      await page.locator("flutter-view").waitFor({ timeout: 30_000 });
      expect(errors).toEqual([]);
    } finally {
      await browser.close();
      await auth.close();
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  },
  60_000
);
