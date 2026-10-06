import { describe, expect, it } from "vitest";
import type { ActorRecord } from "../actor/actor-record.js";
import type { UserPrincipal } from "../principals/principal-ref.js";
import { resolveObligationOwner } from "./owner.js";

const ACTOR = "aaaaaaaa-0000-4000-8000-000000000001";
const USER_A = "11111111-0000-4000-8000-000000000001";
const USER_B = "22222222-0000-4000-8000-000000000002";
const actors = {
  get: (id: string): ActorRecord | undefined =>
    id === ACTOR
      ? {
          id,
          charter: "c",
          parentId: null,
          sandboxed: false,
          status: "active",
          createdAt: "2026-01-01T00:00:00Z",
        }
      : undefined,
};
const users: UserPrincipal[] = [USER_A, USER_B].map((id) => ({
  kind: "user",
  id,
  email: `${id}@example.com`,
  createdAt: "2026-01-01T00:00:00Z",
}));
const principals = { get: (id: string) => users.find((user) => user.id === id) };

describe("resolveObligationOwner", () => {
  it("accepts each explicitly named durable user without guessing", () => {
    for (const ownerId of [USER_A, USER_B]) {
      expect(resolveObligationOwner(actors, ` ${ownerId} `, principals)).toEqual({
        ok: true,
        ownerId,
      });
    }
  });

  it("accepts a live actor", () => {
    expect(resolveObligationOwner(actors, ACTOR, principals)).toEqual({ ok: true, ownerId: ACTOR });
  });

  it("rejects unknown ids, including before any user exists", () => {
    for (const source of [principals, { get: () => undefined }, undefined]) {
      expect(resolveObligationOwner(actors, "unknown", source)).toEqual({
        ok: false,
        error: "unknown obligation owner: unknown",
      });
    }
  });

  it("rejects retired actors and system owners", () => {
    const actor = actors.get(ACTOR);
    if (!actor) throw new Error("Expected actor fixture");
    expect(resolveObligationOwner({ get: () => ({ ...actor, status: "retired" }) }, ACTOR).ok).toBe(
      false
    );
    expect(resolveObligationOwner(actors, "system:mesh", principals).ok).toBe(false);
  });
});
