import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { CSRF_COOKIE, DashboardCsrf } from "./csrf.js";

const request = (token = "") =>
  ({
    headers: { cookie: `${CSRF_COOKIE}=${token}`, "x-rusa-csrf": token },
  }) as unknown as IncomingMessage;
function issue(csrf: DashboardCsrf, session: string, token = ""): string {
  const appendHeader = vi.fn();
  csrf.issue(request(token), { appendHeader } as unknown as ServerResponse, session, 432000);
  return (appendHeader.mock.calls[0][1] as string).split(";")[0].slice(CSRF_COOKIE.length + 1);
}

it("reuses a valid token across tabs, but replaces the binding at login/renewal/logout", () => {
  const csrf = new DashboardCsrf();
  const prelogin = issue(csrf, "");
  expect(csrf.verify(request(prelogin), "")).toBe(true);
  const loggedIn = issue(csrf, "session-one", prelogin);
  expect(loggedIn).not.toBe(prelogin);
  expect(csrf.verify(request(prelogin), "session-one")).toBe(false);
  expect(issue(csrf, "session-one", loggedIn)).toBe(loggedIn);
  const renewed = issue(csrf, "session-two", loggedIn);
  expect(renewed).not.toBe(loggedIn);
  expect(csrf.verify(request(loggedIn), "session-two")).toBe(false);
  expect(csrf.verify(request(renewed), "session-two")).toBe(true);
  expect(csrf.verify(request(renewed), "")).toBe(false);
  expect(csrf.verify(request(issue(csrf, "", renewed)), "")).toBe(true);
});

it("repairs tokens after restart without changing the authentication session", () => {
  const old = issue(new DashboardCsrf(), "existing-session");
  const restarted = new DashboardCsrf();
  expect(restarted.verify(request(old), "existing-session")).toBe(false);
  const repaired = issue(restarted, "existing-session", old);
  expect(restarted.verify(request(repaired), "existing-session")).toBe(true);
});

it("does not expose the session secret and rejects malformed or repeated headers", () => {
  const csrf = new DashboardCsrf();
  const token = issue(csrf, "secret-session-cookie");
  expect(token).not.toContain("secret-session-cookie");
  for (const bad of ["", "a", `${token}, ${token}`, token.toUpperCase(), "0".repeat(10000)]) {
    expect(csrf.verify(request(bad), "secret-session-cookie")).toBe(false);
  }
  const duplicate = request(token);
  duplicate.headers["x-rusa-csrf"] = [token, token];
  expect(csrf.verify(duplicate, "secret-session-cookie")).toBe(false);
});
