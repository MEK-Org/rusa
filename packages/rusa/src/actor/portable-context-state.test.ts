import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorableMemoryKindSchema,
  emptyPortableContextState,
  FilePortableContextStore,
  isRetiredMemoryKind,
  portableMemoryKindSchema,
  RETIRED_MEMORY_KINDS,
} from "./portable-context-state.js";

describe("FilePortableContextStore", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns an empty state when no materialized cache exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "portable-context-store-"));
    dirs.push(dir);
    const state = new FilePortableContextStore(dir).load("actor-a");
    expect(state).toMatchObject({ actorId: "actor-a", generation: 0, items: [] });
  });

  it("atomically writes human-readable state without leaving a temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "portable-context-store-"));
    dirs.push(dir);
    const store = new FilePortableContextStore(dir);
    const state = { ...emptyPortableContextState("actor-a"), generation: 2 };
    store.save(state);

    expect(store.load("actor-a")).toEqual(state);
    expect(readFileSync(store.pathFor("actor-a"), "utf8")).toContain('"generation": 2');
    expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("migrates a v2 event watermark to the durable-source cursor on load", () => {
    const dir = mkdtempSync(join(tmpdir(), "portable-context-store-"));
    dirs.push(dir);
    const store = new FilePortableContextStore(dir);
    const current = emptyPortableContextState("actor-a");
    const legacy = {
      ...current,
      schemaVersion: 2,
      lastFoldedSourceId: undefined,
      lastFoldedMessageEventId: "legacy-message-event",
    };
    writeFileSync(store.pathFor("actor-a"), JSON.stringify(legacy), "utf8");

    expect(store.load("actor-a")).toMatchObject({
      schemaVersion: 3,
      lastFoldedSourceId: "legacy-message-event",
    });
  });

  it("still loads a file holding retired kinds (ISSUE_NUM leg 3)", () => {
    // The load path `parse()`s persisted state, so the persisted kind enum is a
    // data-compatibility contract, not just a producer constraint. Narrowing it
    // to match what the compactor may author would reject files already on disk
    // — 17 of 17 live state files and 100 of 127 items when this was measured
    // on 2026-08-21 — and the ZodError reaches `buildPrompt` uncaught, so the
    // owning actor cannot start at all. This test is the guard on that.
    const dir = mkdtempSync(join(tmpdir(), "portable-context-store-"));
    dirs.push(dir);
    const store = new FilePortableContextStore(dir);
    const onDisk = {
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
    // Written as bytes rather than through save(), because save() would only
    // prove the schema agrees with itself. The file is the input under test.
    writeFileSync(store.pathFor("actor-a"), JSON.stringify(onDisk), "utf8");

    expect(store.load("actor-a").items.map((item) => item.kind)).toEqual([...RETIRED_MEMORY_KINDS]);
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
