import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EVENT_SUBSCRIPTIONS_FILENAME,
  type EventSourceOwnership,
} from "../actor/event-subscriptions.js";
import {
  applyLegacyEventSubscriptionImport,
  EVENT_SUBSCRIPTION_IMPORT_SOURCE,
  importLegacyEventSubscriptionState,
  planLegacyEventSubscriptionImport,
} from "./legacy-event-subscription-import.js";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";

const ROOT = "root-thread";
const ACTOR_A = "actor-thread-a";
const ACTOR_B = "actor-thread-b";
const REPO = "github:dummy-org/dummy-repo";
const OTHER = "github:dummy-org/other";

const row = (over: Partial<EventSourceOwnership> = {}): EventSourceOwnership => ({
  resource: REPO,
  actorId: ACTOR_A,
  subscribedBy: ROOT,
  subscribedAt: "2026-06-27T00:00:00Z",
  ...over,
});

describe("legacy event-subscription import", () => {
  let home: string;
  let filePath: string;
  let db: Database.Database;
  let repositories: Repositories;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rusa-subscription-import-"));
    filePath = join(home, EVENT_SUBSCRIPTIONS_FILENAME);
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
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  // `null` writes a pre-versioning document; a number writes that version.
  const writeLegacy = (subscriptions: unknown[], version: number | null = 3): void => {
    writeFileSync(
      filePath,
      JSON.stringify(version === null ? { subscriptions } : { version, subscriptions })
    );
  };

  const runImport = () =>
    importLegacyEventSubscriptionState({ mcHome: home, db, repositories, rootId: ROOT });

  const backups = (): string[] => readdirSync(home).filter((name) => name.endsWith(".bak"));

  it("is a no-op when no legacy file is present, and creates none", () => {
    const result = runImport();
    expect(result).toEqual({ importedSubscriptions: 0, backupFiles: [] });
    expect(existsSync(filePath)).toBe(false);
    expect(repositories.eventSourceOwners.list()).toEqual([]);
    expect(repositories.legacyImportReceipts.has(EVENT_SUBSCRIPTION_IMPORT_SOURCE)).toBe(false);
  });

  it("imports active rows and tombstones, then archives the source recoverably", () => {
    const original = [
      row({ resource: REPO, actorId: ACTOR_A }),
      row({ resource: OTHER, actorId: ACTOR_B, unsubscribedAt: "2026-06-28T00:00:00Z" }),
    ];
    writeLegacy(original);
    const before = readFileSync(filePath, "utf8");

    const result = runImport();

    expect(result.importedSubscriptions).toBe(2);
    expect(repositories.eventSourceOwners.activeForResource(REPO).map((s) => s.actorId)).toEqual([
      ACTOR_A,
    ]);
    expect(repositories.eventSourceOwners.activeForResource(OTHER)).toEqual([]);
    expect(repositories.eventSourceOwners.list()).toHaveLength(2);
    expect(repositories.legacyImportReceipts.has(EVENT_SUBSCRIPTION_IMPORT_SOURCE)).toBe(true);

    // The source is archived, not deleted: still byte-identical on disk.
    expect(existsSync(filePath)).toBe(false);
    expect(result.backupFiles).toHaveLength(1);
    expect(readFileSync(result.backupFiles[0] as string, "utf8")).toBe(before);
  });

  it("normalizes legacy reference spellings onto the canonical key", () => {
    writeLegacy([row({ resource: "github_repo:dummy-org/dummy-repo" })]);
    runImport();
    expect(repositories.eventSourceOwners.list()[0]?.resource).toBe(REPO);
  });

  it("drops an unversioned document's config-implied root rows and keeps explicit ones", () => {
    writeLegacy(
      [
        row({ resource: REPO, actorId: ROOT, subscribedBy: ROOT }),
        row({ resource: OTHER, actorId: ACTOR_A, subscribedBy: ROOT }),
      ],
      null
    );
    const result = runImport();

    expect(result.importedSubscriptions).toBe(1);
    expect(repositories.eventSourceOwners.list()).toEqual([
      expect.objectContaining({ resource: OTHER, actorId: ACTOR_A }),
    ]);
  });

  it("re-running after a completed import is a no-op", () => {
    writeLegacy([row()]);
    runImport();
    const after = repositories.eventSourceOwners.list();

    const second = runImport();
    expect(second).toEqual({ importedSubscriptions: 0, backupFiles: [] });
    expect(repositories.eventSourceOwners.list()).toEqual(after);
  });

  describe("refuses rather than importing a partial ownership view", () => {
    const expectRefusal = (pattern: RegExp): void => {
      const before = readFileSync(filePath, "utf8");
      expect(() => runImport()).toThrow(pattern);
      expect(repositories.eventSourceOwners.list()).toEqual([]);
      expect(repositories.legacyImportReceipts.has(EVENT_SUBSCRIPTION_IMPORT_SOURCE)).toBe(false);
      // The source stays exactly where the operator can repair it.
      expect(readFileSync(filePath, "utf8")).toBe(before);
      expect(backups()).toEqual([]);
    };

    it("refuses a malformed row instead of dropping it", () => {
      writeLegacy([row(), { ...row({ resource: OTHER }), actorId: "" }]);
      expectRefusal(/unresolved row\(s\)/);
    });

    it("refuses two active owners of one resource instead of picking the newer", () => {
      writeLegacy([
        row({ actorId: ACTOR_A, subscribedAt: "2026-06-27T00:00:00Z" }),
        row({ actorId: ACTOR_B, subscribedAt: "2026-06-29T00:00:00Z" }),
      ]);
      expectRefusal(/a newer active subscriber already owns/);
    });

    it("refuses tied active owners", () => {
      writeLegacy([
        row({ actorId: ACTOR_A, subscribedAt: "2026-06-27T00:00:00Z" }),
        row({ actorId: ACTOR_B, subscribedAt: "2026-06-26T20:00:00-04:00" }),
      ]);
      expectRefusal(/ambiguous active subscribers/);
    });

    it("refuses a subscription for an actor with no actors row", () => {
      writeLegacy([row({ actorId: "no-such-actor" })]);
      expectRefusal(/references unknown actor/);
    });

    it("refuses when durable rows exist with no import receipt", () => {
      repositories.eventSourceOwners.subscribe(row({ resource: OTHER, actorId: ACTOR_B }));
      writeLegacy([row()]);

      const before = readFileSync(filePath, "utf8");
      expect(() => runImport()).toThrow(/without an import receipt/);
      expect(repositories.eventSourceOwners.list()).toHaveLength(1);
      expect(readFileSync(filePath, "utf8")).toBe(before);
    });
  });

  describe("interruption precedence", () => {
    it("interrupted before commit leaves the complete legacy view, and a retry imports it", () => {
      writeLegacy([row({ resource: REPO }), row({ resource: OTHER, actorId: ACTOR_B })]);
      const before = readFileSync(filePath, "utf8");

      // Crash between plan and apply.
      planLegacyEventSubscriptionImport({ mcHome: home, repositories, rootId: ROOT });
      expect(repositories.eventSourceOwners.list()).toEqual([]);
      expect(repositories.legacyImportReceipts.has(EVENT_SUBSCRIPTION_IMPORT_SOURCE)).toBe(false);
      expect(readFileSync(filePath, "utf8")).toBe(before);

      expect(runImport().importedSubscriptions).toBe(2);
      expect(repositories.eventSourceOwners.list()).toHaveLength(2);
    });

    it("a failure inside the transaction commits nothing", () => {
      writeLegacy([row({ resource: REPO })]);
      const planResult = planLegacyEventSubscriptionImport({
        mcHome: home,
        repositories,
        rootId: ROOT,
      });
      expect(planResult.plan.kind).toBe("import");
      if (planResult.plan.kind !== "import") throw new Error("unreachable");

      // A second row the plan never validated: the FK rejects it mid-transaction.
      planResult.plan.subscriptions.push(row({ resource: OTHER, actorId: "no-such-actor" }));
      expect(() => applyLegacyEventSubscriptionImport(planResult, { db, repositories })).toThrow();

      expect(repositories.eventSourceOwners.list()).toEqual([]);
      expect(repositories.legacyImportReceipts.has(EVENT_SUBSCRIPTION_IMPORT_SOURCE)).toBe(false);
      expect(existsSync(filePath)).toBe(true);
    });

    it("a source file surviving the commit is archived unread, never replayed over newer rows", () => {
      writeLegacy([row({ resource: REPO, actorId: ACTOR_A })]);
      runImport();

      // The mesh moves on: ownership is handed to another actor.
      repositories.eventSourceOwners.unsubscribe(REPO, ACTOR_A, "2026-06-28T00:00:00Z");
      repositories.eventSourceOwners.subscribe(
        row({ actorId: ACTOR_B, subscribedAt: "2026-06-28T00:00:01Z" })
      );

      // The pre-import file reappears — a failed archive rename, or a restored
      // backup. The receipt makes it stale by construction.
      writeLegacy([row({ resource: REPO, actorId: ACTOR_A })]);
      const result = runImport();

      expect(result.importedSubscriptions).toBe(0);
      expect(result.backupFiles).toHaveLength(1);
      expect(existsSync(filePath)).toBe(false);
      expect(repositories.eventSourceOwners.activeForResource(REPO).map((s) => s.actorId)).toEqual([
        ACTOR_B,
      ]);
    });
  });
});
