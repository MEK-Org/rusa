import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedPortableBriefState } from "../../actor/portable-context-brief.js";
import {
  emptyPortableContextState,
  PORTABLE_CONTEXT_SCHEMA_VERSION,
  type PortableContextState,
  type PortableMemoryItem,
  StaleBriefWriteError,
} from "../../actor/portable-context-state.js";
import { runMigrations } from "../migrations/runner.js";
import { widenToWal } from "../wal.js";
import { DbPortableContextStore } from "./portable-context-repository.js";

const ACTOR_A = "actor-thread-a";
const ACTOR_B = "actor-thread-b";

const item = (over: Partial<PortableMemoryItem> = {}): PortableMemoryItem => ({
  id: "mem-1",
  kind: "decision",
  priority: "must",
  status: "active",
  statement: "The instruction remains durable.",
  evidence: [
    {
      eventId: "chat-1",
      sender: "operator",
      ts: "2026-07-01T00:00:00.000Z",
      quote: "Remember this.",
    },
  ],
  updatedAt: "2026-07-01T00:00:00.000Z",
  ...over,
});

const state = (over: Partial<PortableContextState> = {}): PortableContextState => ({
  ...emptyPortableContextState(ACTOR_A),
  generation: 1,
  updatedAt: "2026-07-01T00:00:00.000Z",
  lastFoldedSourceId: "chat-1",
  compactor: { provider: "gemini", model: "gemini-3-flash" },
  items: [item()],
  ...over,
});

describe("DbPortableContextStore", () => {
  let home: string;
  let dbPath: string;
  let db: Database.Database;
  let store: DbPortableContextStore;

  // Opened exactly as `initDb` opens the live database, so the concurrency
  // these tests assert about is the concurrency production runs under.
  const open = (): Database.Database => {
    const connection = new Database(dbPath);
    widenToWal(connection);
    connection.pragma("foreign_keys = ON");
    return connection;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "portable-context-store-"));
    dbPath = join(home, "mesh.db");
    db = open();
    runMigrations(db);
    const insert = db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'test actor', ?, '2026-06-27T00:00:00Z')"
    );
    insert.run(ACTOR_A, null);
    insert.run(ACTOR_B, ACTOR_A);
    store = new DbPortableContextStore(db);
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("reports no stored snapshot for an actor that has never been folded", () => {
    expect(store.find(ACTOR_A)).toBeUndefined();
    expect(store.load(ACTOR_A)).toEqual(emptyPortableContextState(ACTOR_A));
  });

  it("round-trips a snapshot whole — item ids, statuses, priorities, generation and cursor", () => {
    const saved = state({
      generation: 7,
      items: [
        item({ id: "mem-1", priority: "must", status: "active" }),
        item({ id: "mem-2", kind: "constraint", priority: "background", status: "superseded" }),
        item({ id: "mem-3", kind: "commitment", priority: "should", status: "resolved" }),
      ],
    });
    store.save(saved);

    expect(store.load(ACTOR_A)).toEqual(saved);
  });

  it("advances an actor's memory in place rather than accumulating snapshots", () => {
    store.save(state({ generation: 1, lastFoldedSourceId: "chat-1" }));
    store.save(state({ generation: 2, lastFoldedSourceId: "chat-2" }));

    expect(store.load(ACTOR_A)).toMatchObject({ generation: 2, lastFoldedSourceId: "chat-2" });
    const rows = db.prepare("SELECT actor_id FROM portable_context_snapshots").all();
    expect(rows).toEqual([{ actor_id: ACTOR_A }]);
    expect(store.count()).toBe(1);
  });

  it("keeps each actor's memory to itself", () => {
    store.save(state({ actorId: ACTOR_A, generation: 1 }));
    store.save(state({ actorId: ACTOR_B, generation: 5 }));

    expect(store.load(ACTOR_A).generation).toBe(1);
    expect(store.load(ACTOR_B).generation).toBe(5);
  });

  it("refuses to store a malformed state instead of writing a document nothing can read", () => {
    const malformed = { ...state(), generation: -1 } as PortableContextState;
    expect(() => store.save(malformed)).toThrow();
    expect(store.find(ACTOR_A)).toBeUndefined();
  });

  it("reads a stored v2 document forward to the current schema version", () => {
    // Written as bytes rather than through save(), because save() would only
    // prove the schema agrees with itself. The stored document is the input.
    const legacy = {
      ...state(),
      schemaVersion: 2,
      lastFoldedSourceId: undefined,
      lastFoldedMessageEventId: "legacy-message-event",
    };
    db.prepare("INSERT INTO portable_context_snapshots (actor_id, snapshot) VALUES (?, ?)").run(
      ACTOR_A,
      JSON.stringify(legacy)
    );

    expect(store.load(ACTOR_A)).toMatchObject({
      schemaVersion: PORTABLE_CONTEXT_SCHEMA_VERSION,
      lastFoldedSourceId: "legacy-message-event",
    });
  });

  // Degrading to an empty state here would let the next fold overwrite
  // unreconstructable memory with a generation-1 document.
  it("names an unreadable stored snapshot rather than reporting the actor as unfolded", () => {
    db.prepare(
      "INSERT INTO portable_context_snapshots (actor_id, snapshot) VALUES (?, 'not json at all')"
    ).run(ACTOR_A);

    expect(() => store.load(ACTOR_A)).toThrow(/invalid portable-context snapshot/);
  });

  it("refuses a snapshot filed under the wrong actor", () => {
    db.prepare("INSERT INTO portable_context_snapshots (actor_id, snapshot) VALUES (?, ?)").run(
      ACTOR_B,
      JSON.stringify(state({ actorId: ACTOR_A }))
    );

    expect(() => store.load(ACTOR_B)).toThrow(/actor mismatch/);
  });

  // The property `DbHostJobStore` has and the retired file store did not: no
  // process-local cache, so a committed write is visible to every other reader.
  it("serves a committed snapshot to a separate connection immediately", () => {
    store.save(state({ generation: 3 }));

    const reader = open();
    try {
      expect(new DbPortableContextStore(reader).load(ACTOR_A).generation).toBe(3);
    } finally {
      reader.close();
    }
  });

  it("shows a reader on another connection nothing from an uncommitted fold", () => {
    store.save(state({ generation: 1 }));
    const reader = open();
    try {
      const writes = db.transaction(() => {
        store.save(state({ generation: 2 }));
        expect(new DbPortableContextStore(reader).load(ACTOR_A).generation).toBe(1);
      });
      writes();
      expect(new DbPortableContextStore(reader).load(ACTOR_A).generation).toBe(2);
    } finally {
      reader.close();
    }
  });

  it("survives a restart: memory read back after reopening is the memory folded before", () => {
    const saved = state({ generation: 4, lastFoldedSourceId: "run-9" });
    store.save(saved);
    db.close();

    db = open();
    expect(new DbPortableContextStore(db).load(ACTOR_A)).toEqual(saved);
  });

  describe("brief writes and history", () => {
    const SEEDED_AT = "2026-10-10T00:00:00.000Z";
    const brief = (n: number): string =>
      `## WHAT\nPrinciple number ${n}. [mesh:messages/m-${n}]\n\n## HOW\n\n## DOMAIN\n`;
    const commit = (
      target: DbPortableContextStore,
      expectedGeneration: number,
      n: number,
      explanation?: string
    ) =>
      target.commitBrief({
        actorId: ACTOR_A,
        expectedGeneration,
        text: brief(n),
        ...(explanation === undefined ? {} : { explanation }),
        actingPrincipal: ACTOR_A,
        at: `2026-10-10T00:0${n}:00.000Z`,
      });
    const rowCount = (): number =>
      (db.prepare("SELECT COUNT(*) AS n FROM portable_brief_revisions").get() as { n: number }).n;

    beforeEach(() => {
      store.save(seedPortableBriefState(state(), SEEDED_AT));
    });

    it("replaces the current brief and appends one revision carrying before, after and explanation", () => {
      const seed = store.load(ACTOR_A).brief?.text;
      const revision = commit(store, 0, 1, "first distillation");

      expect(revision).toEqual({
        generation: 1,
        updatedAt: "2026-10-10T00:01:00.000Z",
        actingPrincipal: ACTOR_A,
        before: seed,
        after: brief(1),
        explanation: "first distillation",
      });
      expect(store.load(ACTOR_A)).toEqual({
        ...state(),
        brief: { text: brief(1), generation: 1, updatedAt: "2026-10-10T00:01:00.000Z" },
      });
      expect(store.listBriefRevisions(ACTOR_A, 10)).toEqual([revision]);
    });

    it("lists newest first, pages by limit, and keeps every accepted write", () => {
      for (let n = 1; n <= 4; n += 1) commit(store, n - 1, n);

      expect(store.listBriefRevisions(ACTOR_A, 2).map((r) => r.generation)).toEqual([4, 3]);
      expect(store.listBriefRevisions(ACTOR_A, 10).map((r) => r.generation)).toEqual([4, 3, 2, 1]);
      expect(store.listBriefRevisions(ACTOR_A, 10)[0]).toMatchObject({
        before: brief(3),
        after: brief(4),
      });
      expect(store.listBriefRevisions(ACTOR_B, 10)).toEqual([]);
      expect(rowCount()).toBe(4);
    });

    it("refuses a stale expected generation and changes nothing", () => {
      commit(store, 0, 1);
      const before = store.load(ACTOR_A);

      expect(() => commit(store, 0, 2)).toThrow(StaleBriefWriteError);
      expect(() => commit(store, 5, 2)).toThrow(/expected generation 5, current is 1/);
      expect(store.load(ACTOR_A)).toEqual(before);
      expect(rowCount()).toBe(1);
    });

    it("refuses a write for an actor with no brief", () => {
      expect(() =>
        store.commitBrief({
          actorId: ACTOR_B,
          expectedGeneration: 0,
          text: brief(1),
          actingPrincipal: ACTOR_B,
          at: SEEDED_AT,
        })
      ).toThrow(/has no brief to replace/);
      expect(rowCount()).toBe(0);
    });

    it("lets only one of two connections that read the same generation commit", () => {
      const other = open();
      try {
        const otherStore = new DbPortableContextStore(other);
        expect(otherStore.load(ACTOR_A).brief?.generation).toBe(0);
        commit(store, 0, 1);

        expect(() => commit(otherStore, 0, 2)).toThrow(StaleBriefWriteError);
        expect(otherStore.load(ACTOR_A).brief?.text).toBe(brief(1));
        expect(rowCount()).toBe(1);
      } finally {
        other.close();
      }
    });

    it("rolls the snapshot back when the history append fails", () => {
      // A row already holding generation 1 makes the append violate
      // UNIQUE(actor_id, generation) after the snapshot write in the same
      // transaction; the snapshot must not keep a brief its history lacks.
      db.prepare(
        `INSERT INTO portable_brief_revisions (actor_id, generation, acting_principal, timestamp, payload)
         VALUES (?, 1, ?, ?, ?)`
      ).run(ACTOR_A, ACTOR_A, SEEDED_AT, '{"schemaVersion":1,"before":"","after":""}');
      const before = store.load(ACTOR_A);

      expect(() => commit(store, 0, 1)).toThrow(/UNIQUE/);
      expect(store.load(ACTOR_A)).toEqual(before);
    });

    it("survives a restart: brief and history read back after reopening", () => {
      commit(store, 0, 1, "why");
      commit(store, 1, 2);
      const current = store.load(ACTOR_A);
      const history = store.listBriefRevisions(ACTOR_A, 10);
      db.close();

      db = open();
      const reopened = new DbPortableContextStore(db);
      expect(reopened.load(ACTOR_A)).toEqual(current);
      expect(reopened.listBriefRevisions(ACTOR_A, 10)).toEqual(history);
    });

    it("names a history row whose payload it cannot read", () => {
      db.prepare(
        `INSERT INTO portable_brief_revisions (actor_id, generation, acting_principal, timestamp, payload)
         VALUES (?, 1, ?, ?, ?)`
      ).run(ACTOR_A, ACTOR_A, SEEDED_AT, '{"schemaVersion":9}');
      expect(() => store.listBriefRevisions(ACTOR_A, 10)).toThrow();
    });
  });
});
