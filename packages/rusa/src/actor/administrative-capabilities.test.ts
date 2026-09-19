import { describe, expect, it } from "vitest";
import {
  ACTOR_ADMIN_CAPABILITY,
  ADMINISTRATIVE_CAPABILITIES,
  bootstrapCapabilitiesFor,
  CAPABILITY_ADMIN_CAPABILITY,
  CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES,
  CONFIGURED_ACTOR_BOOTSTRAP_GRANTOR,
  EXPERIMENT_ADMIN_CAPABILITY,
  MODEL_ADMIN_CAPABILITY,
  seedConfiguredActorGrants,
} from "./administrative-capabilities.js";
import { InMemoryCapabilityGrantStore } from "./capability-grants.js";

describe("administrative capabilities", () => {
  // The exact compatibility set is a deliberate checkpoint: adding a name here
  // widens what the configured actor is seeded with on upgrade.
  it("names exactly the administrative surfaces the configured actor is seeded with", () => {
    expect(CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES).toEqual([
      CAPABILITY_ADMIN_CAPABILITY,
      EXPERIMENT_ADMIN_CAPABILITY,
      MODEL_ADMIN_CAPABILITY,
      ACTOR_ADMIN_CAPABILITY,
      "update",
      "pnpm-hardlinks",
    ]);
  });

  it("seeds every bootstrap capability for the configured actor with bootstrap provenance", () => {
    const store = new InMemoryCapabilityGrantStore();
    const seeded = seedConfiguredActorGrants(store, "configured", () => "2026-01-01T00:00:00Z");
    expect(seeded).toEqual([...CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES]);
    expect([...store.activeFor("configured")].sort()).toEqual(
      [...CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES].sort()
    );
    expect(
      store.list().every((grant) => grant.grantedBy === CONFIGURED_ACTOR_BOOTSTRAP_GRANTOR)
    ).toBe(true);
  });

  it("is idempotent across boots and never re-seeds a revoked capability", () => {
    const store = new InMemoryCapabilityGrantStore();
    seedConfiguredActorGrants(store, "configured", () => "2026-01-01T00:00:00Z");
    store.revoke("configured", CAPABILITY_ADMIN_CAPABILITY, "2026-01-02T00:00:00Z");

    const reseeded = seedConfiguredActorGrants(store, "configured", () => "2026-01-03T00:00:00Z");

    expect(reseeded).toEqual([]);
    expect(store.activeFor("configured")).not.toContain(CAPABILITY_ADMIN_CAPABILITY);
    const revoked = store.list().find((grant) => grant.capability === CAPABILITY_ADMIN_CAPABILITY);
    expect(revoked?.revokedAt).toBe("2026-01-02T00:00:00Z");
  });

  // A host whose deploy checkout can't be resolved boots without the `update`
  // server; a grant with nothing behind it would read as authority that does
  // nothing, so the seed takes only what this boot can actually mount.
  it("seeds the host-maintenance capabilities only when the boot can mount them", () => {
    expect(bootstrapCapabilitiesFor(new Set(["pnpm-hardlinks", "understanding-write"]))).toEqual([
      CAPABILITY_ADMIN_CAPABILITY,
      EXPERIMENT_ADMIN_CAPABILITY,
      MODEL_ADMIN_CAPABILITY,
      ACTOR_ADMIN_CAPABILITY,
      "pnpm-hardlinks",
    ]);
    const store = new InMemoryCapabilityGrantStore();
    const seeded = seedConfiguredActorGrants(
      store,
      "configured",
      () => "2026-01-01T00:00:00Z",
      bootstrapCapabilitiesFor(new Set(["pnpm-hardlinks"]))
    );
    expect(seeded).toEqual([...ADMINISTRATIVE_CAPABILITIES, "pnpm-hardlinks"]);
    expect(store.activeFor("configured")).not.toContain("update");
    // A later boot that can mount it seeds the pair then — unless it was
    // revoked meanwhile, which the once-per-pair rule still honours.
    store.revoke("configured", "pnpm-hardlinks", "2026-01-02T00:00:00Z");
    expect(
      seedConfiguredActorGrants(
        store,
        "configured",
        () => "2026-01-03T00:00:00Z",
        bootstrapCapabilitiesFor(new Set(["update", "pnpm-hardlinks"]))
      )
    ).toEqual(["update"]);
    expect(store.activeFor("configured")).not.toContain("pnpm-hardlinks");
  });

  it("seeds only the named actor, leaving every other actor ungranted", () => {
    const store = new InMemoryCapabilityGrantStore();
    seedConfiguredActorGrants(store, "configured");
    expect(store.activeFor("other-parentless")).toEqual([]);
  });
});
