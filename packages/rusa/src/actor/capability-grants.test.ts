import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CapabilityGrant,
  FileCapabilityGrantStore,
  InMemoryCapabilityGrantStore,
  PARENT_GRANTABLE_CAPABILITIES,
  SECRET_GEMINI_API_KEY_CAPABILITY,
  SECRET_MISTRAL_API_KEY_CAPABILITY,
} from "./capability-grants.js";

const IU = "iu-thread-1"; // the IU steward's (stable) actor id
const grant = (over: Partial<CapabilityGrant> = {}): CapabilityGrant => ({
  actorId: IU,
  capability: "understanding-write",
  grantedBy: "root",
  grantedAt: "2026-06-27T00:00:00Z",
  ...over,
});

describe("parent-grantable capabilities", () => {
  it("includes both file-backed API-key secrets", () => {
    expect(PARENT_GRANTABLE_CAPABILITIES).toEqual(
      new Set([SECRET_GEMINI_API_KEY_CAPABILITY, SECRET_MISTRAL_API_KEY_CAPABILITY])
    );
  });
});

describe("InMemoryCapabilityGrantStore", () => {
  it("grants a capability and reports it active for the actor", () => {
    const store = new InMemoryCapabilityGrantStore();
    store.grant(grant());
    expect(store.activeFor(IU)).toEqual(["understanding-write"]);
    expect(store.activeFor("someone-else")).toEqual([]);
  });

  it("is idempotent per (actorId, capability)", () => {
    const store = new InMemoryCapabilityGrantStore();
    store.grant(grant());
    store.grant(grant());
    expect(store.list()).toHaveLength(1);
    expect(store.activeFor(IU)).toEqual(["understanding-write"]);
  });

  it("revokes an active grant (and keeps it in the audit list)", () => {
    const store = new InMemoryCapabilityGrantStore();
    store.grant(grant());
    store.revoke(IU, "understanding-write", "2026-06-28T00:00:00Z");
    expect(store.activeFor(IU)).toEqual([]);
    const all = store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.revokedAt).toBe("2026-06-28T00:00:00Z");
  });

  it("re-granting reactivates a revoked grant", () => {
    const store = new InMemoryCapabilityGrantStore();
    store.grant(grant());
    store.revoke(IU, "understanding-write", "2026-06-28T00:00:00Z");
    store.grant(grant({ grantedAt: "2026-06-29T00:00:00Z" }));
    expect(store.activeFor(IU)).toEqual(["understanding-write"]);
    expect(store.list()[0]?.revokedAt).toBeUndefined();
  });

  it("revoking an unknown grant is a no-op", () => {
    const store = new InMemoryCapabilityGrantStore();
    store.revoke("nobody", "nothing", "2026-06-28T00:00:00Z");
    expect(store.list()).toEqual([]);
  });

  it("tracks grants per actor and capability independently", () => {
    const store = new InMemoryCapabilityGrantStore();
    store.grant(grant({ actorId: IU, capability: "understanding-write" }));
    store.grant(grant({ actorId: IU, capability: "chat" }));
    store.grant(grant({ actorId: "bug-thread-1", capability: "chat" }));
    expect(store.activeFor(IU).sort()).toEqual(["chat", "understanding-write"]);
    expect(store.activeFor("bug-thread-1")).toEqual(["chat"]);
  });
});

describe("FileCapabilityGrantStore", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "capgrants-"));
    file = join(dir, "capability-grants.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists grants across instances", () => {
    const a = new FileCapabilityGrantStore(file);
    a.grant(grant());
    // A fresh instance reading the same file sees the grant.
    const b = new FileCapabilityGrantStore(file);
    expect(b.activeFor(IU)).toEqual(["understanding-write"]);
  });

  it("sees grants written after this store was constructed", () => {
    const orchestratorStore = new FileCapabilityGrantStore(file);
    expect(orchestratorStore.activeFor(IU)).toEqual([]);

    const laterGrantWriter = new FileCapabilityGrantStore(file);
    laterGrantWriter.grant(grant({ capability: "distiller" }));

    expect(orchestratorStore.activeFor(IU)).toEqual(["distiller"]);
  });

  it("persists revocations across instances (active + revoked state survives reload)", () => {
    const a = new FileCapabilityGrantStore(file);
    a.grant(grant({ capability: "understanding-write" }));
    a.grant(grant({ capability: "chat" }));
    a.revoke(IU, "chat", "2026-06-28T00:00:00Z");

    const b = new FileCapabilityGrantStore(file);
    expect(b.activeFor(IU)).toEqual(["understanding-write"]);
    expect(b.list().find((g) => g.capability === "chat")?.revokedAt).toBe("2026-06-28T00:00:00Z");
  });

  it("starts empty when the file is missing", () => {
    const store = new FileCapabilityGrantStore(join(dir, "does-not-exist.json"));
    expect(store.list()).toEqual([]);
  });
});
