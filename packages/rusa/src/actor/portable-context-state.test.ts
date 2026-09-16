import { describe, expect, it } from "vitest";
import {
  authorableMemoryKindSchema,
  emptyPortableContextState,
  InMemoryPortableContextStore,
  isRetiredMemoryKind,
  parsePortableContextState,
  portableMemoryKindSchema,
  RETIRED_MEMORY_KINDS,
} from "./portable-context-state.js";

describe("parsePortableContextState", () => {
  it("reads a current-version document straight through", () => {
    const state = { ...emptyPortableContextState("actor-a"), generation: 2 };
    expect(parsePortableContextState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("migrates a v2 event watermark to the durable-source cursor", () => {
    const current = emptyPortableContextState("actor-a");
    const legacy = {
      ...current,
      schemaVersion: 2,
      lastFoldedSourceId: undefined,
      lastFoldedMessageEventId: "legacy-message-event",
    };

    expect(parsePortableContextState(JSON.parse(JSON.stringify(legacy)))).toMatchObject({
      schemaVersion: 3,
      lastFoldedSourceId: "legacy-message-event",
    });
  });

  it("still accepts a document holding retired kinds (ISSUE_NUM leg 3)", () => {
    // Every stored snapshot goes through this parse, so the persisted kind enum
    // is a data-compatibility contract, not just a producer constraint.
    // Narrowing it to match what the compactor may author would reject memory
    // already persisted — 17 of 17 live documents and 100 of 127 items when
    // this was measured on 2026-08-21 — and the ZodError reaches `buildPrompt`
    // uncaught, so the owning actor cannot start at all.
    const stored = {
      ...emptyPortableContextState("actor-a"),
      generation: 9,
      items: RETIRED_MEMORY_KINDS.map((kind, index) => ({
        id: `mem-${index}`,
        kind,
        priority: "should" as const,
        status: "active" as const,
        statement: `A pre-cut ${kind}.`,
        evidence: [
          { eventId: "e1", sender: "root", ts: "2026-07-01T00:00:00.000Z", quote: "pre-cut" },
        ],
        updatedAt: "2026-07-01T00:00:00.000Z",
      })),
    };

    expect(
      parsePortableContextState(JSON.parse(JSON.stringify(stored))).items.map((item) => item.kind)
    ).toEqual([...RETIRED_MEMORY_KINDS]);
  });

  it("refuses a document of an unknown schema version rather than reading it as current", () => {
    const future = { ...emptyPortableContextState("actor-a"), schemaVersion: 99 };
    expect(() => parsePortableContextState(future)).toThrow();
  });
});

describe("InMemoryPortableContextStore", () => {
  it("returns an empty state for an actor that has never been folded", () => {
    expect(new InMemoryPortableContextStore().load("actor-a")).toMatchObject({
      actorId: "actor-a",
      generation: 0,
      items: [],
    });
  });

  it("hands back a copy, so a caller cannot mutate stored memory in place", () => {
    const store = new InMemoryPortableContextStore();
    const state = { ...emptyPortableContextState("actor-a"), generation: 2 };
    store.save(state);

    store.load("actor-a").items.push({
      id: "mem-smuggled",
      kind: "decision",
      priority: "must",
      status: "active",
      statement: "Written through a handed-out reference.",
      evidence: [
        { eventId: "e1", sender: "root", ts: "2026-07-01T00:00:00.000Z", quote: "smuggled" },
      ],
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    expect(store.load("actor-a")).toEqual(state);
  });
});

describe("memory kind vocabularies (ISSUE_NUM leg 3)", () => {
  it("keeps every authorable kind persistable, and every retired kind out of the authorable set", () => {
    // The two enums may diverge in exactly one direction. Persisted ⊇ authorable
    // — a kind the compactor can emit but the store cannot hold would fail on
    // save, after the fold has already spent a model call.
    for (const kind of authorableMemoryKindSchema.options) {
      expect(portableMemoryKindSchema.options).toContain(kind);
      expect(isRetiredMemoryKind(kind)).toBe(false);
    }
    // ...and the retired kinds are the whole of the difference, so a kind added
    // to the persisted enum without a decision about its authorability fails here.
    const authorable = new Set<string>(authorableMemoryKindSchema.options);
    expect(portableMemoryKindSchema.options.filter((kind) => !authorable.has(kind))).toEqual([
      ...RETIRED_MEMORY_KINDS,
    ]);
    for (const kind of RETIRED_MEMORY_KINDS) expect(isRetiredMemoryKind(kind)).toBe(true);
  });
});
