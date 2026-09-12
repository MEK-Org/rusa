// @vitest-environment node
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";

// Requires the real Firebase emulator and am-up --auth-emulator, with built assets.
it.skipIf(!process.env.RUSA_AUTH_EMULATOR_E2E)(
  "authenticates through the emulator popup, renews, and logs out",
  async () => {
    const origin = process.env.RUSA_AUTH_EMULATOR_E2E as string;
    const browser = await chromium.launch({ headless: true });
    try {
      for (const email of ["not-the-operator@example.com", "operator@example.com"]) {
        const context = await browser.newContext();
        const page = await context.newPage();
        // Browser fetch honors Secure cookies on loopback; Playwright's Node HTTP client does not.
        const status = (path: string) =>
          page.evaluate(async (url) => (await fetch(url)).status, path);
        await page.goto(origin);
        expect(await status("/api/mesh/threads")).toBe(401);
        const popupPromise = page.waitForEvent("popup");
        await page.getByRole("button", { name: "Sign in with Google", exact: true }).click();
        const popup = await popupPromise;
        await popup.getByText("Add new account", { exact: true }).click();
        await popup.locator("#email-input").fill(email);
        await popup.getByRole("button", { name: "Sign in with Google.com", exact: true }).click();
        if (email.startsWith("not-")) {
          await page.getByText("Unable to sign in.", { exact: false }).waitFor();
          expect(await status("/api/auth/session")).toBe(401);
        } else {
          await page.locator("flutter-view").waitFor({ timeout: 45_000 });
          expect(await status("/api/auth/session")).toBe(200);
          expect(await status("/api/mesh/threads")).toBe(200);
          const cookie = (await context.cookies()).find(
            (entry) => entry.name === "__Host-rusa_session"
          );
          expect(cookie).toMatchObject({ secure: true, httpOnly: true, sameSite: "Strict" });
          const refresh = page.waitForResponse(
            (response) =>
              response.url().endsWith("/api/auth/refresh") && response.request().method() === "POST"
          );
          await page.evaluate(() => window.dispatchEvent(new Event("rusa-navigation")));
          expect((await refresh).status()).toBe(200);
          // Enable Flutter's accessibility tree to exercise the actual profile menu.
          await page.locator("flt-semantics-placeholder").evaluate((element) => {
            (element as HTMLElement).style.cssText =
              "position:fixed;left:0;top:0;width:20px;height:20px;z-index:9999";
          });
          await page.locator("flt-semantics-placeholder").click({ force: true });
          await page.getByRole("button", { name: "Profile menu" }).click();
          await page.getByRole("menuitem", { name: "Log out", exact: true }).click();
          await page.getByRole("button", { name: "Sign in with Google", exact: true }).waitFor();
          expect(await status("/api/auth/session")).toBe(401);
        }
        await context.close();
      }
    } finally {
      await browser.close();
    }
  },
  90_000
);
