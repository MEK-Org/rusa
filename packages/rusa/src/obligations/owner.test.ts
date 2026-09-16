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

describe("resolveObligationOwner — legacy operator alias after #460", () => {
  it("resolves the alias to the sole active durable user instead of minting the legacy row", () => {
    expect(resolveObligationOwner(actors, HUMAN_OPERATOR, principals([user(USER_A)]))).toEqual({
      ok: true,
      ownerId: USER_A,
    });
    // Whitespace around the alias is still the alias.
    expect(
      resolveObligationOwner(actors, `  ${HUMAN_OPERATOR} `, principals([user(USER_A)]))
    ).toEqual({
      ok: true,
      ownerId: USER_A,
    });
  });

  it("ignores a disabled user when choosing the sole active one", () => {
    expect(
      resolveObligationOwner(
        actors,
        HUMAN_OPERATOR,
        principals([user(USER_A, "2026-02-01T00:00:00Z"), user(USER_B)])
      )
    ).toEqual({ ok: true, ownerId: USER_B });
  });

  it("refuses the alias as ambiguous when several users are active", () => {
    const result = resolveObligationOwner(
      actors,
      HUMAN_OPERATOR,
      principals([user(USER_A), user(USER_B)])
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ambiguous");
      expect(result.error).toContain("durable user principal id");
    }
  });

  it("keeps the literal alias only while no durable user exists yet", () => {
    expect(resolveObligationOwner(actors, HUMAN_OPERATOR, principals([]))).toEqual({
      ok: true,
      ownerId: HUMAN_OPERATOR,
    });
    expect(resolveObligationOwner(actors, HUMAN_OPERATOR)).toEqual({
      ok: true,
      ownerId: HUMAN_OPERATOR,
    });
  });

  it("accepts a durable user id directly and a live actor as before", () => {
    expect(
      resolveObligationOwner(actors, USER_B, principals([user(USER_A), user(USER_B)]))
    ).toEqual({ ok: true, ownerId: USER_B });
    expect(resolveObligationOwner(actors, ACTOR, principals([user(USER_A)]))).toEqual({
      ok: true,
      ownerId: ACTOR,
    });
    expect(resolveObligationOwner(actors, "nobody", principals([user(USER_A)])).ok).toBe(false);
  });
});
