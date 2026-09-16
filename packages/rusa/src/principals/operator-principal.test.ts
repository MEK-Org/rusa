import { describe, expect, it } from "vitest";
import { listActiveUsers, resolveSoleActiveUser } from "./operator-principal.js";
import type { UserPrincipal } from "./principal-ref.js";

const USER_A = "11111111-0000-4000-8000-000000000001";
const USER_B = "22222222-0000-4000-8000-000000000002";

function user(id: string, disabledAt?: string): UserPrincipal {
  return {
    kind: "user",
    id,
    email: `${id}@example.com`,
    createdAt: "2026-01-01T00:00:00Z",
    disabledAt,
  };
}

describe("resolveSoleActiveUser (auth-disabled local mode)", () => {
  it("attributes to the one active user", () => {
    const result = resolveSoleActiveUser({ listUsers: () => [user(USER_A)] });
    expect(result).toEqual({ ok: true, user: user(USER_A) });
  });

  it("does not count a disabled user", () => {
    expect(listActiveUsers({ listUsers: () => [user(USER_A, "2026-02-01T00:00:00Z")] })).toEqual(
      []
    );
    const result = resolveSoleActiveUser({
      listUsers: () => [user(USER_A, "2026-02-01T00:00:00Z"), user(USER_B)],
    });
    expect(result.ok && result.user.id).toBe(USER_B);
  });

  it("refuses with a bootstrap hint when no user exists, including with no storage", () => {
    for (const source of [{ listUsers: () => [] }, undefined]) {
      const result = resolveSoleActiveUser(source);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("none");
        expect(result.error).toContain("migrate:legacy-principal");
        expect(result.error).not.toContain("human:operator");
      }
    }
  });

  it("refuses rather than guessing when several users are active", () => {
    const result = resolveSoleActiveUser({ listUsers: () => [user(USER_A), user(USER_B)] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
      expect(result.error).toContain("2 active durable user principals");
      expect(result.error).toContain("dashboard auth");
    }
  });
});
