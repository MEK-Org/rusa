import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grant, IU, testCapabilityGrantStoreContract } from "./capability-grant-store.contract.js";
import {
  FileCapabilityGrantStore,
  GRANT_MUTATION_EFFECT,
  type GrantMutationEffect,
  GrantMutationListenerSlot,
  InMemoryCapabilityGrantStore,
  PARENT_GRANTABLE_CAPABILITIES,
  PARENT_GRANTABLE_SECRET_FILENAMES,
  SECRET_CAPABILITY_BASE,
  SECRET_CAPABILITY_PREFIX,
} from "./capability-grants.js";

describe("parent-grantable capabilities", () => {
  it("is exactly the two file-backed LLM API-key secrets, by FULL capability name", () => {
    expect(PARENT_GRANTABLE_SECRET_FILENAMES).toEqual(["gemini-api-key", "mistral-api-key"]);
    expect(PARENT_GRANTABLE_CAPABILITIES).toEqual(
      new Set(["secret:gemini-api-key", "secret:mistral-api-key"])
    );
  });

  it("never contains the generic secret base or prefix (that would delegate every file)", () => {
    expect(PARENT_GRANTABLE_CAPABILITIES.has(SECRET_CAPABILITY_BASE)).toBe(false);
    expect(PARENT_GRANTABLE_CAPABILITIES.has(SECRET_CAPABILITY_PREFIX)).toBe(false);
    for (const cap of PARENT_GRANTABLE_CAPABILITIES) {
      expect(cap.startsWith(SECRET_CAPABILITY_PREFIX)).toBe(true);
      expect(cap.length).toBeGreaterThan(SECRET_CAPABILITY_PREFIX.length);
    }
  });
});

testCapabilityGrantStoreContract(
  "InMemoryCapabilityGrantStore",
  () => new InMemoryCapabilityGrantStore()
);

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

describe("GrantMutationListenerSlot (#1289 D1)", () => {
  const effect: GrantMutationEffect = {
    kind: GRANT_MUTATION_EFFECT,
    change: "granted",
    actorId: "worker",
    capability: "understanding-write",
    by: "root",
  };

  it("delivers to its one listener and stays synchronous when the listener is", () => {
    const slot = new GrantMutationListenerSlot();
    expect(slot.deliver(effect)).toBeUndefined();
    const seen: GrantMutationEffect[] = [];
    slot.on((e) => {
      seen.push(e);
    });
    expect(slot.deliver(effect)).toBeUndefined();
    expect(seen).toEqual([effect]);
  });

  it("returns an async listener's promise so the writer awaits it", async () => {
    const slot = new GrantMutationListenerSlot();
    let settled = false;
    slot.on(async () => {
      await Promise.resolve();
      settled = true;
    });
    const out = slot.deliver(effect);
    expect(out).toBeInstanceOf(Promise);
    await out;
    expect(settled).toBe(true);
  });

  it("refuses a second subscriber until the first unsubscribes", () => {
    const slot = new GrantMutationListenerSlot();
    const off = slot.on(() => {});
    expect(() => slot.on(() => {})).toThrow("already subscribed");
    off();
    const seen: string[] = [];
    const offNext = slot.on(() => {
      seen.push("next");
    });
    // A stale unsubscribe does not remove a later listener.
    off();
    slot.deliver(effect);
    expect(seen).toEqual(["next"]);
    offNext();
  });

  it("keeps a re-subscribed callback when the first subscription's unsubscribe runs again", () => {
    const slot = new GrantMutationListenerSlot();
    const seen: GrantMutationEffect[] = [];
    const listener = (e: GrantMutationEffect) => {
      seen.push(e);
    };
    const off = slot.on(listener);
    off();
    const offAgain = slot.on(listener);
    off();
    slot.deliver(effect);
    expect(seen).toEqual([effect]);
    offAgain();
    slot.deliver(effect);
    expect(seen).toEqual([effect]);
  });
});
