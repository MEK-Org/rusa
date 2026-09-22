// @vitest-environment node
import { chromium, type Page } from "@playwright/test";
import { expect, it } from "vitest";

/** Flutter draws controls on canvas until its accessibility bridge is enabled. */
async function enableFlutterSemantics(page: Page): Promise<void> {
  const placeholder = page.locator("flt-semantics-placeholder");
  await placeholder.waitFor({ timeout: 45_000 });
  await placeholder.evaluate((element) => {
    (element as HTMLElement).style.cssText =
      "position:fixed;left:0;top:0;width:20px;height:20px;z-index:9999";
  });
  await placeholder.click({ force: true });
}

/**
 * Drive the emulator's simulated Google popup. Its account list loads after
 * the popup opens; a click that lands before that load is reset by the list.
 */
async function signInThroughPopup(page: Page, email: string): Promise<void> {
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("networkidle");
  await popup.getByText("Add new account", { exact: true }).click();
  await popup.locator("#email-input").fill(email);
  await popup.getByRole("button", { name: "Sign in with Google.com", exact: true }).click();
}

function sessionCreated(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/session") &&
      response.request().method() === "GET" &&
      response.status() === 200
  );
}

// Requires --auth-emails operator@example.com,colleague@example.com.
it.skipIf(!process.env.RUSA_SHARED_AUTH_EMULATOR_E2E)(
  "lets two Google users share one mesh without sharing browser sessions",
  async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const pages = [];
      for (const email of ["operator@example.com", "colleague@example.com"]) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(process.env.RUSA_SHARED_AUTH_EMULATOR_E2E as string);
        await enableFlutterSemantics(page);
        const created = sessionCreated(page);
        await signInThroughPopup(page, email);
        await created;
        pages.push(page);
      }
      const snapshots = await Promise.all(
        pages.map((page) =>
          page.evaluate(async () => {
            const response = await fetch("/api/mesh/threads");
            return {
              status: response.status,
              ids: (await response.json()).threads
                .map((thread: { id: string }) => thread.id)
                .sort(),
            };
          })
        )
      );
      expect(snapshots[0].status).toBe(200);
      expect(snapshots[0].ids.length).toBeGreaterThan(0);
      expect(snapshots[1]).toEqual(snapshots[0]);
      // Exercise the actual profile dropdown for the first user only.
      await pages[0].getByRole("button", { name: "Profile menu" }).click();
      await pages[0].getByRole("menuitem", { name: "Log out", exact: true }).click();
      await pages[0].getByRole("button", { name: "Sign in with Google", exact: true }).waitFor();
      expect(await pages[0].evaluate(async () => (await fetch("/api/mesh/threads")).status)).toBe(
        401
      );
      expect(await pages[1].evaluate(async () => (await fetch("/api/mesh/threads")).status)).toBe(
        200
      );
    } finally {
      await browser.close();
    }
  },
  90_000
);

// Requires the real Firebase emulator and am-up --auth-emulator, with built assets.
it.skipIf(!process.env.RUSA_AUTH_EMULATOR_E2E)(
  "authenticates through the emulator popup, survives reload, renews, and signs in again",
  async () => {
    const origin = process.env.RUSA_AUTH_EMULATOR_E2E as string;
    const browser = await chromium.launch({ headless: true });
    try {
      for (const email of ["not-the-operator@example.com", "operator@example.com"]) {
        const context = await browser.newContext();
        const productionAuthRequests: string[] = [];
        await context.route(
          /^https:\/\/(identitytoolkit|securetoken)\.googleapis\.com\//,
          async (route) => {
            productionAuthRequests.push(route.request().url());
            await route.abort();
          }
        );
        const page = await context.newPage();
        // Browser fetch honors Secure cookies on loopback; Playwright's Node HTTP client does not.
        const status = (path: string) =>
          page.evaluate(async (url) => (await fetch(url)).status, path);
        await page.goto(origin);
        expect(await status("/api/mesh/threads")).toBe(401);
        await enableFlutterSemantics(page);
        const created = email.startsWith("not-") ? null : sessionCreated(page);
        await signInThroughPopup(page, email);
        if (email.startsWith("not-")) {
          await page.getByText("Unable to sign in.", { exact: false }).waitFor();
          expect(await status("/api/auth/session")).toBe(401);
        } else {
          await created;
          expect(await status("/api/auth/session")).toBe(200);
          expect(await status("/api/mesh/threads")).toBe(200);
          await page.reload();
          await enableFlutterSemantics(page);
          await page.getByRole("button", { name: "Profile menu" }).waitFor({ timeout: 15_000 });
          expect(await status("/api/auth/session")).toBe(200);
          await page.getByText("Running in emulator mode.", { exact: false }).waitFor();
          expect(productionAuthRequests).toEqual([]);
          const cookie = (await context.cookies()).find(
            (entry) => entry.name === "__Host-rusa_session"
          );
          expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Strict" });
          const csrfCookie = (await context.cookies()).find(
            (entry) => entry.name === "__Host-rusa_csrf"
          );
          expect(csrfCookie).toMatchObject({ secure: true, httpOnly: false, sameSite: "Strict" });
          // Authenticated cross-site-style submissions cannot log the user out.
          expect(
            await page.evaluate(
              async () => (await fetch("/api/auth/logout", { method: "POST" })).status
            )
          ).toBe(403);
          expect(await status("/api/auth/session")).toBe(200);
          const refresh = page.waitForResponse(
            (response) =>
              response.url().endsWith("/api/auth/refresh") && response.request().method() === "POST"
          );
          // Renew through the tab-visible hook. A synthetic null-state popstate
          // is read by Flutter's web history as leaving the app and unloads the
          // page before the renewal response can land.
          await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
          const renewed = await refresh;
          expect(renewed.status()).toBe(200);
          expect(renewed.request().headers()["x-rusa-csrf"]).toBeTruthy();
          // Semantics are already enabled so this exercises the actual profile menu.
          // Exercise Flutter's mutation client without leaving fixture obligations behind.
          await page.route("**/api/mesh/obligations", async (route) => {
            if (route.request().method() === "POST") {
              await route.fulfill({
                status: 503,
                contentType: "application/json",
                body: '{"error":"test-only write interception"}',
              });
            } else await route.continue();
          });
          await page.getByRole("button", { name: "New Obligation", exact: true }).click();
          await page.getByRole("textbox").first().click();
          await page.keyboard.type("CSRF browser verification", { delay: 20 });
          await page.keyboard.press("Tab");
          const mutation = page.waitForRequest(
            (request) =>
              request.method() === "POST" && request.url().endsWith("/api/mesh/obligations")
          );
          await page.getByRole("button", { name: "Create", exact: true }).click();
          const sent = await mutation;
          expect(sent.headers()["x-rusa-csrf"]).toBe(
            (await context.cookies()).find((entry) => entry.name === "__Host-rusa_csrf")?.value
          );
          expect(sent.headers()["x-rusa-csrf"]).toBeTruthy();
          await page.getByRole("button", { name: "Cancel", exact: true }).click();
          await page.getByRole("button", { name: "Profile menu" }).click();
          await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
          await page.getByRole("button", { name: "Sign in with Google", exact: true }).waitFor();
          expect(await status("/api/auth/session")).toBe(401);
          await page.reload();
          await enableFlutterSemantics(page);
          const signedInAgain = sessionCreated(page);
          await signInThroughPopup(page, email);
          await signedInAgain;
          await page.getByRole("button", { name: "Profile menu" }).waitFor();
          expect(await status("/api/auth/session")).toBe(200);
          expect(productionAuthRequests).toEqual([]);
        }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
  90_000
);
