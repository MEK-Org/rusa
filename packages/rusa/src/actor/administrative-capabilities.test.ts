import { describe, expect, it, vi } from "vitest";
import type { ChatConfig } from "../config/types.js";
import {
  ACTOR_ADMIN_CAPABILITY,
  CAPABILITY_ADMIN_CAPABILITY,
  CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES,
  CONFIGURED_ACTOR_BOOTSTRAP_GRANTOR,
  defaultActorBootstrapCapabilities,
  defaultGrantRecipient,
  EXPERIMENT_ADMIN_CAPABILITY,
  MODEL_ADMIN_CAPABILITY,
  ROOM_ADMIN_CAPABILITY,
  seedConfiguredActorGrants,
  withDefaultActorCapabilities,
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
      ROOM_ADMIN_CAPABILITY,
      "obligations-admin",
      "obligation-responsive",
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

  it.each<[Pick<ChatConfig, "gchat"> | undefined, string[]]>([
    [undefined, []],
    [{ gchat: undefined }, ["chat-write:*"]],
    [{ gchat: "all" }, ["chat-write:*"]],
    [{ gchat: ["spaces/A", "spaces/B"] }, ["chat-write:spaces/A", "chat-write:spaces/B"]],
    [{ gchat: [] }, []],
  ])("preserves the configured Chat write scope: %j", (chat, expected) => {
    const config = chat
      ? { chat: { projectId: "test", subscription: "test", pubsubKeyPath: "/dev/null", ...chat } }
      : {};
    expect(defaultActorBootstrapCapabilities(config)).toEqual([
      ...CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES,
      ...expected,
    ]);
  });

  it("seeds configured Slack write without reviving an existing revocation", () => {
    const capabilities = defaultActorBootstrapCapabilities({
      slack: { botTokenPath: "/synthetic/bot", appTokenPath: "/synthetic/app" },
    });
    expect(capabilities).toEqual([...CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES, "slack-write:*"]);
    const store = new InMemoryCapabilityGrantStore();
    seedConfiguredActorGrants(store, "default", undefined, capabilities);
    for (const capability of capabilities)
      store.revoke("default", capability, "2026-01-02T00:00:00Z");
    const before = store.list();
    expect(seedConfiguredActorGrants(store, "default", undefined, capabilities)).toEqual([]);
    expect(store.list()).toEqual(before);
    expect(store.activeFor("default")).toEqual([]);
  });

  it("seeds only the named actor, leaving every other actor ungranted", () => {
    const store = new InMemoryCapabilityGrantStore();
    seedConfiguredActorGrants(store, "configured");
    expect(store.activeFor("other-parentless")).toEqual([]);
  });
});

describe("in-memory default actor authority", () => {
  it("supplies defaults without changing the durable grant audit", () => {
    const store = new InMemoryCapabilityGrantStore();
    const grant = vi.spyOn(store, "grant");
    const revoke = vi.spyOn(store, "revoke");
    const effective = withDefaultActorCapabilities(store, () => "default", ["capability-admin"]);
    expect(effective.activeFor("default")).toEqual(["capability-admin"]);
    expect(effective.activeFor("other")).toEqual([]);
    expect(effective.list()).toEqual([]);
    expect(grant).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("ignores legacy default rows while preserving independent explicit grants and revocations", () => {
    const store = new InMemoryCapabilityGrantStore();
    seedConfiguredActorGrants(store, "former-default");
    const effective = withDefaultActorCapabilities(store, () => "default", ["capability-admin"]);
    expect(effective.activeFor("former-default")).toEqual([]);
    effective.grant({
      actorId: "former-default",
      capability: "capability-admin",
      grantedBy: "operator",
      grantedAt: "2026-01-01T00:00:00Z",
    });
    expect(effective.activeFor("former-default")).toEqual(["capability-admin"]);
    effective.revoke("former-default", "capability-admin", "2026-01-02T00:00:00Z");
    expect(effective.activeFor("former-default")).toEqual([]);
    expect(effective.list()).toEqual(store.list());
    expect(store.list()).toHaveLength(CONFIGURED_ACTOR_BOOTSTRAP_CAPABILITIES.length);
    // An explicit revocation never removes role-derived authority.
    effective.grant({
      actorId: "default",
      capability: "capability-admin",
      grantedBy: "operator",
      grantedAt: "2026-01-01T00:00:00Z",
    });
    effective.revoke("default", "capability-admin", "2026-01-02T00:00:00Z");
    expect(effective.activeFor("default")).toEqual(["capability-admin"]);
  });

  it("recomputes selection and configured scope without carrying default authority forward", () => {
    const store = new InMemoryCapabilityGrantStore();
    seedConfiguredActorGrants(store, "oldest", undefined, ["chat-write:*"]);
    const before = store.list();
    const boot = (id: string, space: string) =>
      withDefaultActorCapabilities(
        store,
        () => id,
        defaultActorBootstrapCapabilities({
          chat: {
            projectId: "test",
            subscription: "test",
            pubsubKeyPath: "/dev/null",
            gchat: [space],
          },
        })
      );
    expect(boot("oldest", "spaces/A").activeFor("oldest")).toContain("chat-write:spaces/A");
    const restarted = boot("replacement", "spaces/B");
    expect(restarted.activeFor("oldest")).toEqual([]);
    expect(restarted.activeFor("replacement")).toContain("chat-write:spaces/B");
    expect(restarted.activeFor("replacement")).not.toContain("chat-write:*");
    expect(restarted.activeFor("replacement")).not.toContain("chat-write:spaces/A");
    expect(store.list()).toEqual(before);
  });
});

describe("default grant recipient (#1087)", () => {
  const record = (
    id: string,
    createdAt: string,
    parentId: string | null = null,
    status: "active" | "retired" = "active"
  ) => ({
    id,
    charter: id,
    createdAt,
    parentId,
    status,
  });

  it("selects the earliest created active parentless actor, independent of listing order", () => {
    const oldest = record("oldest", "2026-01-02T00:00:00Z");
    const records = [
      record("later", "2026-01-03T00:00:00Z"),
      record("retired", "2026-01-01T00:00:00Z", null, "retired"),
      record("child", "2026-01-01T00:00:00Z", "oldest"),
      oldest,
    ];
    expect(defaultGrantRecipient(records)).toBe(oldest);
    expect(defaultGrantRecipient([...records].reverse())).toBe(oldest);
    expect(defaultGrantRecipient([])).toBeUndefined();
    expect(defaultGrantRecipient(records.slice(1, 3))).toBeUndefined();
  });

  it("compares instants across offsets and breaks equal creation timestamps by id", () => {
    const a = record("a", "2026-01-01T01:00:00+01:00");
    const b = record("b", "2026-01-01T00:00:00Z");
    expect(defaultGrantRecipient([b, a])).toBe(a);
    expect(defaultGrantRecipient([a, record("earlier", "2026-01-01T00:30:00+01:00")])?.id).toBe(
      "earlier"
    );
  });
});
