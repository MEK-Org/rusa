import { describe, expect, it } from "vitest";
import type { ActorRecord } from "../actor/actor-record.js";
import type { PrincipalRepository } from "../db/repositories/principal-repository.js";
import { HUMAN_OPERATOR } from "../mcp/stamp.js";
import type { UserPrincipal } from "../principals/principal-ref.js";
import { resolveObligationOwner } from "./owner.js";

const ACTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_A = "11111111-0000-4000-8000-000000000001";
const USER_B = "22222222-0000-4000-8000-000000000002";

const actors = {
  get: (id: string): ActorRecord | undefined =>
    id === ACTOR
      ? { id, charter: "c", parentId: null, status: "active", createdAt: "2026-01-01T00:00:00Z" }
      : undefined,
};

function user(id: string, disabledAt?: string): UserPrincipal {
  return {
    kind: "user",
    id,
    email: `${id}@example.com`,
    createdAt: "2026-01-01T00:00:00Z",
    disabledAt,
  };
}

function principals(users: UserPrincipal[]): Pick<PrincipalRepository, "get" | "listUsers"> {
  return {
    listUsers: () => users,
    get: (id) => users.find((u) => u.id === id),
  };
}

describe("resolveObligationOwner — durable attribution", () => {
  it("refuses the retired alias with actionable guidance at every user count", () => {
    for (const users of [[], [user(USER_A)], [user(USER_A), user(USER_B)]]) {
      const result = resolveObligationOwner(actors, HUMAN_OPERATOR, principals(users));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("/api/mesh/threads userPrincipalId");
    }
  });
  it("accepts active durable users and actors, refusing disabled or unknown owners", () => {
    expect(
      resolveObligationOwner(actors, USER_B, principals([user(USER_A), user(USER_B)]))
    ).toEqual({ ok: true, ownerId: USER_B });
    expect(resolveObligationOwner(actors, ACTOR)).toEqual({ ok: true, ownerId: ACTOR });
    expect(
      resolveObligationOwner(actors, USER_A, principals([user(USER_A, "2026-02-01")])).ok
    ).toBe(false);
    expect(resolveObligationOwner(actors, "nobody").ok).toBe(false);
  });
});
