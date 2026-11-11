import { describe, expect, it } from "vitest";
import type { ActorRecord } from "../actor/actor-record.js";
import {
  CONFIGURED_ACTOR_IMPORT_SOURCE,
  ConfiguredActorImportError,
  resolveConfiguredActor,
} from "./configured-actor-import.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

function makeActor(id: string, overrides: Partial<ActorRecord> = {}): ActorRecord {
  return {
    id,
    charter: `charter ${id}`,
    parentId: null,
    modelConfig: [{ provider: "mock", model: "mock-model" }],
    status: "active",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

describe("resolveConfiguredActor (#1002, #1261)", () => {
  it("returns undefined when no receipt exists", () => {
    const receipts = {
      has: (_source: string) => false,
      actorFor: (_source: string) => undefined,
      rowCount: (_source: string) => 0,
    };
    const actors = {
      get: (_id: string) => undefined,
    };

    const resolved = resolveConfiguredActor({ receipts, actors });
    expect(resolved).toBeUndefined();
  });

  it("returns undefined when receipt row_count is 0 and actor_id is null (empty store boot)", () => {
    const receipts = {
      has: (source: string) => source === CONFIGURED_ACTOR_IMPORT_SOURCE,
      actorFor: (_source: string) => undefined,
      rowCount: (_source: string) => 0,
    };
    const actors = {
      get: (_id: string) => undefined,
    };

    const resolved = resolveConfiguredActor({ receipts, actors });
    expect(resolved).toBeUndefined();
  });

  it("returns the stored actor record when receipt names a valid actor", () => {
    const rootActor = makeActor("root-actor-uuid", { displayHandle: "ember-familiar" });
    const receipts = {
      has: (source: string) => source === CONFIGURED_ACTOR_IMPORT_SOURCE,
      actorFor: (source: string) =>
        source === CONFIGURED_ACTOR_IMPORT_SOURCE ? "root-actor-uuid" : undefined,
      rowCount: (_source: string) => 1,
    };
    const actors = {
      get: (id: string) => (id === "root-actor-uuid" ? rootActor : undefined),
    };

    const resolved = resolveConfiguredActor({ receipts, actors });
    expect(resolved).toEqual(rootActor);
  });

  it("throws ConfiguredActorImportError when receipt exists but names no actor", () => {
    const receipts = {
      has: (source: string) => source === CONFIGURED_ACTOR_IMPORT_SOURCE,
      actorFor: (_source: string) => undefined,
      rowCount: (_source: string) => 1,
    };
    const actors = {
      get: (_id: string) => undefined,
    };

    expect(() => resolveConfiguredActor({ receipts, actors })).toThrow(ConfiguredActorImportError);
    expect(() => resolveConfiguredActor({ receipts, actors })).toThrow(
      /the configured-actor import receipt names no actor/
    );
  });

  it("throws ConfiguredActorImportError when receipt names an actor missing from actors table", () => {
    const receipts = {
      has: (source: string) => source === CONFIGURED_ACTOR_IMPORT_SOURCE,
      actorFor: (source: string) =>
        source === CONFIGURED_ACTOR_IMPORT_SOURCE ? "missing-actor-id" : undefined,
      rowCount: (_source: string) => 1,
    };
    const actors = {
      get: (_id: string) => undefined,
    };

    expect(() => resolveConfiguredActor({ receipts, actors })).toThrow(ConfiguredActorImportError);
    expect(() => resolveConfiguredActor({ receipts, actors })).toThrow(
      /the imported configured actor missing-actor-id has no actor record/
    );
  });

  it("returns stored actor record even if retired (caller handles retirement status)", () => {
    const retiredActor = makeActor("retired-uuid", { status: "retired" });
    const receipts = {
      has: (source: string) => source === CONFIGURED_ACTOR_IMPORT_SOURCE,
      actorFor: (source: string) =>
        source === CONFIGURED_ACTOR_IMPORT_SOURCE ? "retired-uuid" : undefined,
      rowCount: (_source: string) => 1,
    };
    const actors = {
      get: (id: string) => (id === "retired-uuid" ? retiredActor : undefined),
    };

    const resolved = resolveConfiguredActor({ receipts, actors });
    expect(resolved).toEqual(retiredActor);
  });
});
