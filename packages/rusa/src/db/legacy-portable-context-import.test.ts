import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyPortableContextState,
  type PortableContextState,
  type PortableMemoryItem,
} from "../actor/portable-context-state.js";
import {
  applyLegacyPortableContextImport,
  importLegacyPortableContextState,
  PORTABLE_CONTEXT_DIRNAME,
  PORTABLE_CONTEXT_IMPORT_SOURCE,
  planLegacyPortableContextImport,
} from "./legacy-portable-context-import.js";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";

const ROOT = "root-thread";
const ACTOR_A = "actor-thread-a";
const ACTOR_B = "actor-thread-b";

const item = (over: Partial<PortableMemoryItem> = {}): PortableMemoryItem => ({
  id: "mem-1",
  kind: "decision",
  priority: "must",
  status: "active",
  statement: "The root instruction remains durable.",
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

const state = (
  actorId: string,
  over: Partial<PortableContextState> = {}
): PortableContextState => ({
  ...emptyPortableContextState(actorId),
  generation: 3,
  updatedAt: "2026-07-01T00:00:00.000Z",
  lastFoldedSourceId: "chat-1",
  compactor: { provider: "gemini", model: "gemini-3-flash" },
  items: [item()],
  ...over,
});

describe("legacy portable-context import", () => {
  let home: string;
  let directoryPath: string;
  let db: Database.Database;
  let repositories: Repositories;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rusa-portable-context-import-"));
    directoryPath = join(home, PORTABLE_CONTEXT_DIRNAME);
    db = new Database(join(home, "mesh.db"));
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    const insert = db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'test actor', ?, '2026-06-27T00:00:00Z')"
    );
    insert.run(ROOT, null);
    insert.run(ACTOR_A, ROOT);
    insert.run(ACTOR_B, ROOT);
    repositories = new Repositories(db);
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(home, { recursive: true, force: true });
  });

  /** Write one legacy snapshot file the way `FilePortableContextStore.save()` wrote it. */
  const writeLegacy = (name: string, value: unknown): void => {
    mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    writeFileSync(join(directoryPath, name), `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
    });
  };

  const backups = (): string[] => readdirSync(home).filter((name) => name.endsWith(".bak"));

  const runImport = (): ReturnType<typeof importLegacyPortableContextState> =>
    importLegacyPortableContextState({ mcHome: home, db, repositories });

  it("is a no-op when no legacy directory is present, and creates none", () => {
    const result = runImport();
    expect(result).toEqual({ importedSnapshots: 0, backupFiles: [] });
    expect(repositories.portableContext.find(ACTOR_A)).toBeUndefined();
    expect(existsSync(directoryPath)).toBe(false);
  });

  it("is a no-op on an empty legacy directory, and still archives it", () => {
    mkdirSync(directoryPath, { recursive: true });
    const result = runImport();
    expect(result.importedSnapshots).toBe(0);
    expect(result.backupFiles).toHaveLength(1);
    expect(existsSync(directoryPath)).toBe(false);
  });

  it("imports every snapshot whole, then archives the source recoverably", () => {
    const a = state(ACTOR_A, {
      generation: 7,
      lastFoldedSourceId: "run-42",
      items: [
        item({ id: "mem-1", priority: "must", status: "active" }),
        item({ id: "mem-2", kind: "constraint", priority: "background", status: "superseded" }),
        item({ id: "mem-3", kind: "commitment", priority: "should", status: "resolved" }),
      ],
    });
    const b = state(ACTOR_B, { generation: 1, lastFoldedSourceId: null, compactor: null });
    writeLegacy(`${ACTOR_A}.json`, a);
    writeLegacy(`${ACTOR_B}.json`, b);

    const result = runImport();

    expect(result.importedSnapshots).toBe(2);
    // Item ids, kinds, statuses, priorities, generation history and the fold
    // cursor all survive the move — none of them is derivable from the sources.
    expect(repositories.portableContext.load(ACTOR_A)).toEqual(a);
    expect(repositories.portableContext.load(ACTOR_B)).toEqual(b);

    // The source is renamed, never deleted: its bytes stay recoverable.
    expect(existsSync(directoryPath)).toBe(false);
    expect(result.backupFiles).toHaveLength(1);
    const restored = JSON.parse(
      readFileSync(join(result.backupFiles[0] as string, `${ACTOR_A}.json`), "utf8")
    );
    expect(restored.items).toHaveLength(3);
  });

  it("reads a v2 snapshot forward, keeping its event watermark as the durable cursor", () => {
    writeLegacy(`${ACTOR_A}.json`, {
      ...state(ACTOR_A),
      schemaVersion: 2,
      lastFoldedSourceId: undefined,
      lastFoldedMessageEventId: "legacy-message-event",
    });

    expect(runImport().importedSnapshots).toBe(1);
    expect(repositories.portableContext.load(ACTOR_A)).toMatchObject({
      schemaVersion: 3,
      lastFoldedSourceId: "legacy-message-event",
    });
  });

  it("carries a crashed save's temp file into the archive rather than parsing it", () => {
    writeLegacy(`${ACTOR_A}.json`, state(ACTOR_A));
    // `FilePortableContextStore.save()` wrote `<path>.<pid>.<uuid>.tmp` and
    // renamed it into place; losing the process between the two left this
    // behind. It is a partial write by construction, never read as state.
    writeLegacy(`${ACTOR_A}.json.1234.abcd.tmp`, { half: "written" });

    const result = runImport();

    expect(result.importedSnapshots).toBe(1);
    expect(readdirSync(result.backupFiles[0] as string).some((name) => name.endsWith(".tmp"))).toBe(
      true
    );
  });

  it("re-running after a completed import is a no-op", () => {
    writeLegacy(`${ACTOR_A}.json`, state(ACTOR_A));
    runImport();
    const before = repositories.portableContext.load(ACTOR_A);

    const second = runImport();
    expect(second).toEqual({ importedSnapshots: 0, backupFiles: [] });
    expect(repositories.portableContext.load(ACTOR_A)).toEqual(before);
  });

  describe("refuses rather than importing a partial memory view", () => {
    const expectRefusal = (pattern: RegExp): void => {
      expect(() => runImport()).toThrow(pattern);
      expect(repositories.portableContext.find(ACTOR_A)).toBeUndefined();
      expect(repositories.portableContext.find(ACTOR_B)).toBeUndefined();
      expect(repositories.legacyImportReceipts.has(PORTABLE_CONTEXT_IMPORT_SOURCE)).toBe(false);
      expect(existsSync(directoryPath)).toBe(true);
      expect(backups()).toEqual([]);
    };

    // A readable subset would make "this actor never remembered any of that"
    // durable while the cursor it kept moves on.
    it("refuses a malformed snapshot instead of dropping that actor's memory", () => {
      writeLegacy(`${ACTOR_A}.json`, state(ACTOR_A));
      writeLegacy(`${ACTOR_B}.json`, { schemaVersion: 3, actorId: ACTOR_B });
      expectRefusal(/cannot read .*actor-thread-b\.json/);
    });

    it("refuses unparseable JSON", () => {
      mkdirSync(directoryPath, { recursive: true });
      writeFileSync(join(directoryPath, `${ACTOR_A}.json`), "{ not json");
      expectRefusal(/cannot read/);
    });

    it("refuses a snapshot of an unknown schema version", () => {
      writeLegacy(`${ACTOR_A}.json`, { ...state(ACTOR_A), schemaVersion: 99 });
      expectRefusal(/cannot read/);
    });

    it("refuses a file whose document names a different actor than its name does", () => {
      writeLegacy(`${ACTOR_A}.json`, state(ACTOR_B));
      expectRefusal(/refusing to file one actor's memory under another/);
    });

    it("refuses a snapshot owned by an actor with no actors row", () => {
      writeLegacy("no-such-actor.json", state("no-such-actor"));
      expectRefusal(/references unknown actor 'no-such-actor'/);
    });

    it("refuses when a durable snapshot exists with no import receipt", () => {
      repositories.portableContext.save(state(ACTOR_A, { generation: 9 }));
      writeLegacy(`${ACTOR_A}.json`, state(ACTOR_A, { generation: 1 }));

      expect(() => runImport()).toThrow(/written without an import receipt/);
      // The durable memory is untouched and the source is still there.
      expect(repositories.portableContext.load(ACTOR_A).generation).toBe(9);
      expect(existsSync(directoryPath)).toBe(true);
      expect(backups()).toEqual([]);
    });

    // Preflight plans every import against one un-mutated copy, so a snapshot's
    // actor may legitimately be planned rather than committed.
    it("accepts an actor a legacy actor import has planned but not committed", () => {
      writeLegacy("pending-actor.json", state("pending-actor"));
      const planned = planLegacyPortableContextImport({
        mcHome: home,
        repositories,
        pendingActorIds: ["pending-actor"],
      });
      expect(planned.plannedSnapshots).toBe(1);
      // Planning performs no write of its own.
      expect(repositories.portableContext.find("pending-actor")).toBeUndefined();
      expect(existsSync(directoryPath)).toBe(true);
    });
  });

  describe("interruption precedence", () => {
    it("interrupted before commit leaves the complete legacy view, and a retry imports it", () => {
      writeLegacy(`${ACTOR_A}.json`, state(ACTOR_A));
      writeLegacy(`${ACTOR_B}.json`, state(ACTOR_B));

      // Planning is the whole pre-commit half; losing the process here writes
      // nothing at all, so the directory is still the complete view.
      planLegacyPortableContextImport({ mcHome: home, repositories });
      expect(repositories.portableContext.find(ACTOR_A)).toBeUndefined();
      expect(repositories.legacyImportReceipts.has(PORTABLE_CONTEXT_IMPORT_SOURCE)).toBe(false);
      expect(existsSync(directoryPath)).toBe(true);

      expect(runImport().importedSnapshots).toBe(2);
      expect(repositories.portableContext.load(ACTOR_B).generation).toBe(3);
    });

    it("a failure inside the transaction commits nothing, and the retry gets everything", () => {
      writeLegacy(`${ACTOR_A}.json`, state(ACTOR_A));
      writeLegacy(`${ACTOR_B}.json`, state(ACTOR_B));
      const planResult = planLegacyPortableContextImport({ mcHome: home, repositories });

      expect(() =>
        applyLegacyPortableContextImport(planResult, {
          db,
          repositories,
          now: () => {
            throw new Error("interrupted after the snapshots, before the receipt");
          },
        })
      ).toThrow(/interrupted/);

      expect(repositories.portableContext.find(ACTOR_A)).toBeUndefined();
      expect(repositories.portableContext.find(ACTOR_B)).toBeUndefined();
      expect(repositories.legacyImportReceipts.has(PORTABLE_CONTEXT_IMPORT_SOURCE)).toBe(false);
      expect(existsSync(directoryPath)).toBe(true);
      expect(backups()).toEqual([]);

      expect(runImport().importedSnapshots).toBe(2);
      expect(repositories.portableContext.load(ACTOR_A).generation).toBe(3);
    });

    it("a source surviving the commit is archived unread, never replayed over newer memory", () => {
      writeLegacy(`${ACTOR_A}.json`, state(ACTOR_A, { generation: 3 }));
      runImport();

      // The mesh moves on: the actor folds again.
      repositories.portableContext.save(
        state(ACTOR_A, { generation: 4, lastFoldedSourceId: "chat-9" })
      );

      // Someone restores the pre-import directory — an older view of the same memory.
      writeLegacy(`${ACTOR_A}.json`, state(ACTOR_A, { generation: 3 }));
      const result = runImport();

      expect(result.importedSnapshots).toBe(0);
      expect(result.backupFiles).toHaveLength(1);
      expect(existsSync(directoryPath)).toBe(false);
      // The durable memory stands; the stale source did not roll it back.
      expect(repositories.portableContext.load(ACTOR_A)).toMatchObject({
        generation: 4,
        lastFoldedSourceId: "chat-9",
      });
    });
  });

  // Rollback story for the release that performs the import: a downgraded build
  // has no `portable_context_snapshots` reader and goes back to reading
  // `portable-context/`, so the archive has to be a faithful copy an operator
  // can simply rename back.
  it("leaves byte-identical backups a downgraded build can be rolled back onto", () => {
    writeLegacy(`${ACTOR_A}.json`, state(ACTOR_A));
    writeLegacy(`${ACTOR_B}.json`, state(ACTOR_B));
    const before = new Map(
      readdirSync(directoryPath).map((name) => [
        name,
        readFileSync(join(directoryPath, name), "utf8"),
      ])
    );

    const result = runImport();

    const backup = result.backupFiles[0] as string;
    expect(readdirSync(backup).sort()).toEqual([...before.keys()].sort());
    for (const [name, content] of before) {
      expect(readFileSync(join(backup, name), "utf8")).toBe(content);
    }
  });

  it("survives a restart with the database authoritative and no JSON source recreated", () => {
    writeLegacy(`${ACTOR_A}.json`, state(ACTOR_A));
    runImport();
    repositories.portableContext.save(
      state(ACTOR_A, { generation: 4, lastFoldedSourceId: "run-77" })
    );
    db.close();

    const reopened = new Database(join(home, "mesh.db"));
    reopened.pragma("foreign_keys = ON");
    const afterRestart = new Repositories(reopened);
    const rerun = importLegacyPortableContextState({
      mcHome: home,
      db: reopened,
      repositories: afterRestart,
    });

    expect(rerun).toEqual({ importedSnapshots: 0, backupFiles: [] });
    expect(afterRestart.portableContext.load(ACTOR_A)).toMatchObject({
      generation: 4,
      lastFoldedSourceId: "run-77",
    });
    expect(existsSync(directoryPath)).toBe(false);
    reopened.close();

    // Reassigned so afterEach's close() is not a double close of `db`.
    db = new Database(join(home, "mesh.db"));
  });
});
