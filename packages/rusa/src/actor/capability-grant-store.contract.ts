import { describe, expect, it } from "vitest";
import type { CapabilityGrant, CapabilityGrantStore } from "./capability-grants.js";

export const ROOT = "root";
export const IU = "iu-thread-1"; // the IU steward's (stable) actor id
export const OTHER = "bug-thread-1";

export const grant = (over: Partial<CapabilityGrant> = {}): CapabilityGrant => ({
  actorId: IU,
  capability: "understanding-write",
  grantedBy: ROOT,
  grantedAt: "2026-06-27T00:00:00Z",
  ...over,
});

const byKey = (a: CapabilityGrant, b: CapabilityGrant): number =>
  `${a.actorId}:${a.capability}`.localeCompare(`${b.actorId}:${b.capability}`);

/**
 * Behavior every {@link CapabilityGrantStore} implementation must satisfy,
 * independent of backing storage — run against both `InMemoryCapabilityGrantStore`
 * and `DbCapabilityGrantStore`. Implementation-specific concerns (FK/PK
 * enforcement, reopen, cross-connection visibility, migration upgrade) stay in
 * each store's own test file. `list()` has no documented ordering, so
 * multi-row assertions here sort before comparing.
 */
export function testCapabilityGrantStoreContract(
  name: string,
  makeStore: () => CapabilityGrantStore
): void {
  describe(`${name} (CapabilityGrantStore contract)`, () => {
    it("grants a capability and reports it active for the actor", () => {
      const store = makeStore();
      store.grant(grant());
      expect(store.activeFor(IU)).toEqual(["understanding-write"]);
      expect(store.activeFor(OTHER)).toEqual([]);
    });

    it("is idempotent per (actorId, capability)", () => {
      const store = makeStore();
      store.grant(grant());
      store.grant(grant());
      expect(store.list()).toHaveLength(1);
      expect(store.activeFor(IU)).toEqual(["understanding-write"]);
    });

    it("revokes an active grant (and keeps it in the audit list)", () => {
      const store = makeStore();
      store.grant(grant());
      store.revoke(IU, "understanding-write", "2026-06-28T00:00:00Z");
      expect(store.activeFor(IU)).toEqual([]);
      const all = store.list();
      expect(all).toHaveLength(1);
      expect(all[0]?.revokedAt).toBe("2026-06-28T00:00:00Z");
    });

    it("re-granting reactivates a revoked grant", () => {
      const store = makeStore();
      store.grant(grant());
      store.revoke(IU, "understanding-write", "2026-06-28T00:00:00Z");
      store.grant(grant({ grantedAt: "2026-06-29T00:00:00Z" }));
      expect(store.activeFor(IU)).toEqual(["understanding-write"]);
      expect(store.list()[0]?.revokedAt).toBeUndefined();
    });

    it("revoking an unknown grant is a no-op", () => {
      const store = makeStore();
      store.revoke("nobody", "nothing", "2026-06-28T00:00:00Z");
      expect(store.list()).toEqual([]);
    });

    it("revoking an already-revoked grant is a no-op (keeps the original revokedAt)", () => {
      const store = makeStore();
      store.grant(grant());
      store.revoke(IU, "understanding-write", "2026-06-28T00:00:00Z");
      store.revoke(IU, "understanding-write", "2026-06-29T00:00:00Z");
      expect(store.list()[0]?.revokedAt).toBe("2026-06-28T00:00:00Z");
    });

    it("tracks grants per actor and capability independently", () => {
      const store = makeStore();
      store.grant(grant({ actorId: IU, capability: "understanding-write" }));
      store.grant(grant({ actorId: IU, capability: "chat" }));
      store.grant(grant({ actorId: OTHER, capability: "chat" }));
      expect(store.activeFor(IU).sort()).toEqual(["chat", "understanding-write"]);
      expect(store.activeFor(OTHER)).toEqual(["chat"]);
    });

    it("list() includes every grant, active and revoked, in any order", () => {
      const store = makeStore();
      store.grant(grant({ actorId: IU, capability: "understanding-write" }));
      store.grant(grant({ actorId: OTHER, capability: "chat" }));
      store.revoke(IU, "understanding-write", "2026-06-28T00:00:00Z");

      const expected: CapabilityGrant[] = [
        grant({ actorId: OTHER, capability: "chat" }),
        {
          ...grant({ actorId: IU, capability: "understanding-write" }),
          revokedAt: "2026-06-28T00:00:00Z",
        },
      ];
      expect([...store.list()].sort(byKey)).toEqual([...expected].sort(byKey));
    });
  });
}
