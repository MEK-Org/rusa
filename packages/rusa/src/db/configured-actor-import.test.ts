import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActorMesh } from "../actor/actor-mesh.js";
import type { ActorRecord } from "../actor/actor-record.js";
import { DEFAULT_ROOT_CHARTER } from "../actor/handle-generator.js";
import { ROOT_ACTOR_CHARTER } from "../actor/root-prompt.js";
import type { ProviderModelConfig } from "../providers/model-config.js";
import {
  CONFIGURED_ACTOR_IMPORT_SOURCE,
  ConfiguredActorImportError,
  type ConfiguredActorSeed,
  importConfiguredActor,
  planConfiguredActorImport,
} from "./configured-actor-import.js";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";

/**
 * Synthetic fixtures only: every id, handle, charter and model below is made
 * up for these tests.
 */
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const IMPORTED_AT = "2026-10-11T00:00:00.000Z";
const SEED_POOL: ProviderModelConfig[] = [{ provider: "seed-provider", model: "seed-model" }];
const PERSISTED_POOL: ProviderModelConfig[] = [
  { provider: "persisted-provider", model: "persisted-model", effort: "high" },
];

function actor(id: string, overrides: Partial<ActorRecord> = {}): ActorRecord {
  return {
    id,
    charter: `charter ${id}`,
    parentId: "configured",
    modelConfig: PERSISTED_POOL,
    status: "active",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** An upgraded home: what the previous binary left behind for its root and a small tree. */
function upgradedActors(): ActorRecord[] {
  return [
    actor("configured", {
      parentId: null,
      charter: DEFAULT_ROOT_CHARTER,
      context: { type: "native" },
      sessionId: "native-session-1",
      executionConfig: { unsandboxed: true },
    }),
    actor("lead", { executionConfig: { executionTarget: "follower-1" } }),
    actor("worker", { parentId: "lead", context: { type: "portable", mode: "tail" } }),
  ];
}

describe("configured-actor import (#1002)", () => {
  let home: string;
  let dbPath: string;
  let db: Database.Database;
  let repositories: Repositories;
  let modelConfig: ReturnType<
    typeof vi.fn<(portable: boolean, actorId: string) => ProviderModelConfig[]>
  >;

  const open = () => {
    db = new Database(dbPath);
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    repositories = new Repositories(db);
  };
  const reopen = () => {
    db.close();
    open();
  };

  const seed = (overrides: Partial<ConfiguredActorSeed> = {}): ConfiguredActorSeed => ({
    charter: undefined,
    context: undefined,
    handle: "ember-familiar",
    executionConfig: { unsandboxed: true },
    modelConfig,
    ...overrides,
  });

  const run = (
    overrides: {
      seed?: Partial<ConfiguredActorSeed>;
      selectedActorId?: string;
      idgen?: () => string;
    } = {}
  ) =>
    importConfiguredActor({
      db,
      actors: repositories.actors,
      receipts: repositories.legacyImportReceipts,
      seed: seed(overrides.seed),
      workersDir: join(home, "workers"),
      avatarCachePath: join(home, "avatars", "root.png"),
      selectedActorId: overrides.selectedActorId,
      idgen: overrides.idgen ?? (() => "minted-id"),
      now: () => IMPORTED_AT,
    });

  const plan = (selectedActorId?: string) =>
    planConfiguredActorImport({
      actors: repositories.actors,
      receipts: repositories.legacyImportReceipts,
      workersDir: join(home, "workers"),
      selectedActorId,
    });

  const receiptRows = () => db.prepare("SELECT * FROM legacy_import_receipts").all();

  /** Everything the import must leave alone, captured for before/after parity. */
  const snapshot = () => ({
    actors: repositories.actors.list(),
    grants: repositories.capabilityGrants.list(),
    placement: repositories.actors
      .list()
      .map((record) => [record.id, record.executionConfig ?? null] as const),
  });

  const insertAll = (records: ActorRecord[]) => {
    for (const record of records) repositories.actors.upsert(record);
  };
  /** Rows an older binary or a hand edit could leave behind: parents that do not exist or loop. */
  const insertDetached = (records: ActorRecord[]) => {
    db.pragma("foreign_keys = OFF");
    try {
      insertAll(records);
    } finally {
      db.pragma("foreign_keys = ON");
    }
  };

  const refusal = (fn: () => unknown): ConfiguredActorImportError => {
    try {
      fn();
    } catch (err) {
      if (err instanceof ConfiguredActorImportError) return err;
      throw err;
    }
    throw new Error("expected a ConfiguredActorImportError");
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rusa-configured-actor-import-"));
    dbPath = join(home, "mesh.db");
    modelConfig = vi.fn((_portable: boolean, _actorId: string) => SEED_POOL);
    open();
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  describe("empty home", () => {
    it("creates the configured actor from config and records the receipt in one step", () => {
      const result = run({
        seed: {
          charter: "configured charter",
          context: { type: "portable", mode: "ledger" },
          sessionId: "ignored-for-portable",
        },
      });

      expect(result).toMatchObject({ plan: { kind: "create", actorId: "minted-id" } });
      expect(modelConfig).toHaveBeenCalledWith(true, "minted-id");
      expect(repositories.actors.list()).toEqual([
        {
          id: "minted-id",
          charter: "configured charter",
          parentId: null,
          modelConfig: SEED_POOL,
          context: { type: "portable", mode: "ledger" },
          executionConfig: { unsandboxed: true },
          displayHandle: "ember-familiar",
          status: "active",
          createdAt: IMPORTED_AT,
        },
      ]);
      expect(receiptRows()).toEqual([
        {
          source: CONFIGURED_ACTOR_IMPORT_SOURCE,
          imported_at: IMPORTED_AT,
          row_count: 1,
          actor_id: "minted-id",
        },
      ]);
    });

    it("uses the built-in charter and folds a deferred legacy session into a native actor", () => {
      run({ seed: { sessionId: "legacy-session" } });

      expect(repositories.actors.get("minted-id")).toMatchObject({
        charter: ROOT_ACTOR_CHARTER,
        sessionId: "legacy-session",
        context: { type: "native" },
      });
      expect(modelConfig).toHaveBeenCalledWith(false, "minted-id");
    });

    it("writes nothing when the configured tuple cannot seed a pool", () => {
      modelConfig.mockImplementation(() => {
        throw new Error("provider not declared");
      });

      expect(() => run()).toThrow(/provider not declared/);
      expect(repositories.actors.list()).toEqual([]);
      expect(receiptRows()).toEqual([]);
    });
  });

  describe("repeated import and restart", () => {
    it("runs once: a repeat, a reopen and changed or removed config all leave the actor alone", () => {
      run({ seed: { charter: "first charter", context: { type: "native" } } });
      const created = snapshot();
      const receipt = receiptRows();
      modelConfig.mockClear();

      const changed = {
        charter: "edited charter",
        context: { type: "portable", mode: "tail" } as const,
        handle: "renamed-handle",
        executionConfig: {},
        sessionId: "another-session",
      };
      expect(run({ seed: changed, idgen: () => "second-mint" }).plan).toEqual({
        kind: "completed",
        actorId: "minted-id",
      });
      reopen();
      // A removed rootActor leaves only the boot defaults to offer.
      expect(run({ seed: { handle: "silicon-familiar" }, idgen: () => "third-mint" }).plan).toEqual(
        { kind: "completed", actorId: "minted-id" }
      );

      expect(modelConfig).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(created);
      expect(receiptRows()).toEqual(receipt);
    });
  });

  describe("upgraded home", () => {
    beforeEach(() => {
      insertAll(upgradedActors());
      repositories.capabilityGrants.grant({
        actorId: "configured",
        capability: "update",
        grantedBy: "configured-actor-bootstrap",
        grantedAt: CREATED_AT,
      });
      repositories.capabilityGrants.grant({
        actorId: "lead",
        capability: "deploy",
        grantedBy: "configured",
        grantedAt: CREATED_AT,
      });
      repositories.capabilityGrants.revoke("lead", "deploy", CREATED_AT);
    });

    it("adopts the sole top-level actor, filling only what it lacks, with state, grant and placement parity", () => {
      const before = snapshot();

      const result = run({
        seed: {
          charter: undefined,
          // Conflicting config: none of these may replace a stored value.
          context: { type: "portable", mode: "ledger" },
          executionConfig: {},
          sessionId: "legacy-session",
        },
      });

      expect(result.plan).toEqual({ kind: "adopt", actorId: "configured", selected: false });
      expect(result.filled).toEqual(["charter", "displayHandle"]);
      expect(modelConfig).not.toHaveBeenCalled();
      const after = snapshot();
      expect(after.grants).toEqual(before.grants);
      expect(after.placement).toEqual(before.placement);
      expect(after.actors).toEqual(
        before.actors.map((record) =>
          record.id === "configured"
            ? { ...record, charter: ROOT_ACTOR_CHARTER, displayHandle: "ember-familiar" }
            : record
        )
      );
      expect(repositories.legacyImportReceipts.actorFor(CONFIGURED_ACTOR_IMPORT_SOURCE)).toBe(
        "configured"
      );
    });

    it("keeps established durable values over conflicting config", () => {
      repositories.actors.patch("configured", {
        charter: "operator-edited charter",
        displayHandle: "stored-handle",
        executionConfig: { unsandboxed: true, executionTarget: "follower-2" },
      });
      const before = snapshot();

      const result = run({
        seed: {
          charter: "config charter",
          context: { type: "portable", mode: "tail" },
          handle: "config-handle",
          executionConfig: {},
        },
      });

      expect(result.filled).toEqual([]);
      expect(modelConfig).not.toHaveBeenCalled();
      expect(snapshot()).toEqual(before);
      expect(repositories.actors.get("configured")).toMatchObject({
        charter: "operator-edited charter",
        displayHandle: "stored-handle",
        context: { type: "native" },
        sessionId: "native-session-1",
        modelConfig: PERSISTED_POOL,
        executionConfig: { unsandboxed: true, executionTarget: "follower-2" },
      });
    });

    it("fills a genuinely missing context and pool, validating the pool for that context", () => {
      db.prepare("UPDATE actors SET context_config = NULL, model_config = NULL WHERE id = ?").run(
        "configured"
      );

      const result = run({ seed: { context: { type: "portable", mode: "tail" } } });

      expect(result.filled).toEqual(["charter", "context", "displayHandle", "modelConfig"]);
      expect(modelConfig).toHaveBeenCalledWith(true, "configured");
      expect(repositories.actors.get("configured")).toMatchObject({
        context: { type: "portable", mode: "tail" },
        modelConfig: SEED_POOL,
      });
    });

    it("never seeds a pool over a class binding", () => {
      db.prepare(
        `UPDATE actors SET model_config = '{"schemaVersion":4,"modelClass":"missing-class"}' WHERE id = ?`
      ).run("configured");
      expect(repositories.actors.get("configured")).toMatchObject({
        modelClass: "missing-class",
        modelClassError: expect.any(String),
      });

      const result = run();

      expect(result.filled).not.toContain("modelConfig");
      expect(modelConfig).not.toHaveBeenCalled();
      expect(repositories.actors.get("configured")?.modelClass).toBe("missing-class");
    });
  });

  describe("interrupted import", () => {
    beforeEach(() => insertAll(upgradedActors()));

    it("rolls back the row and receipt together and completes on the next attempt", () => {
      const before = snapshot();
      const record = repositories.legacyImportReceipts.record.bind(
        repositories.legacyImportReceipts
      );
      const crash = vi.spyOn(repositories.legacyImportReceipts, "record").mockImplementation(() => {
        throw new Error("process killed mid-import");
      });

      expect(() => run()).toThrow(/process killed mid-import/);
      expect(snapshot()).toEqual(before);
      expect(receiptRows()).toEqual([]);

      crash.mockImplementation(record);
      reopen();
      const result = importConfiguredActor({
        db,
        actors: repositories.actors,
        receipts: repositories.legacyImportReceipts,
        seed: seed(),
        workersDir: join(home, "workers"),
        avatarCachePath: join(home, "avatars", "root.png"),
        now: () => IMPORTED_AT,
      });
      expect(result.plan).toEqual({ kind: "adopt", actorId: "configured", selected: false });
      expect(repositories.actors.get("configured")?.displayHandle).toBe("ember-familiar");
      expect(repositories.legacyImportReceipts.actorFor(CONFIGURED_ACTOR_IMPORT_SOURCE)).toBe(
        "configured"
      );
    });

    it("copies the configured avatar once, before the commit, and never over an existing image", () => {
      const avatar = join(home, "configured-avatar.png");
      writeFileSync(avatar, "configured-image");
      const cache = join(home, "avatars", "root.png");
      vi.spyOn(repositories.legacyImportReceipts, "record").mockImplementationOnce(() => {
        throw new Error("process killed after the avatar copy");
      });

      expect(() => run({ seed: { avatarPath: avatar } })).toThrow(/after the avatar copy/);
      expect(readFileSync(cache, "utf8")).toBe("configured-image");
      expect(receiptRows()).toEqual([]);

      // The retry finds the image already cached, leaves it, and commits.
      writeFileSync(avatar, "edited-image");
      expect(run({ seed: { avatarPath: avatar } }).avatarImported).toBe(false);
      expect(readFileSync(cache, "utf8")).toBe("configured-image");
      expect(repositories.legacyImportReceipts.has(CONFIGURED_ACTOR_IMPORT_SOURCE)).toBe(true);
    });

    it("keeps an uploaded image and skips a configured path that does not exist", () => {
      mkdirSync(join(home, "avatars"));
      writeFileSync(join(home, "avatars", "root.png"), "uploaded-image");
      const avatar = join(home, "configured-avatar.png");
      writeFileSync(avatar, "configured-image");

      expect(run({ seed: { avatarPath: avatar } }).avatarImported).toBe(false);
      expect(readFileSync(join(home, "avatars", "root.png"), "utf8")).toBe("uploaded-image");

      rmSync(join(home, "avatars"), { recursive: true });
      db.prepare("DELETE FROM legacy_import_receipts").run();
      expect(run({ seed: { avatarPath: join(home, "missing.png") } }).avatarImported).toBe(false);
      expect(existsSync(join(home, "avatars", "root.png"))).toBe(false);
    });
  });

  describe("ambiguous state needs an explicit operator choice", () => {
    it("refuses two top-level actors, naming both, and writes nothing", () => {
      insertAll([actor("top-a", { parentId: null }), actor("top-b", { parentId: null })]);
      const before = snapshot();

      const err = refusal(() => run());
      expect(err.message).toMatch(/2 top-level actors \(top-a, top-b\)/);
      expect(err.action).toMatch(/--import-actor/);
      expect(err.candidates).toEqual(["top-a", "top-b"]);
      // Naming one does not get around the single top-level runtime guard.
      expect(refusal(() => run({ selectedActorId: "top-a" })).message).toMatch(
        /top-b is also top-level/
      );
      expect(snapshot()).toEqual(before);
      expect(receiptRows()).toEqual([]);
    });

    it("refuses a home with actors but no top-level actor", () => {
      insertDetached([actor("a", { parentId: "b" }), actor("b", { parentId: "a" })]);

      expect(refusal(() => run()).message).toMatch(/no top-level actor among 2/);
      expect(receiptRows()).toEqual([]);
    });

    it.each([
      {
        name: "actors that do not descend from it",
        setup: () =>
          insertDetached([
            actor("configured", { parentId: null }),
            actor("orphan", { parentId: "gone" }),
          ]),
        reason: /orphan do not descend from it/,
      },
      {
        name: "a spawned-actor workspace",
        setup: (insert: (records: ActorRecord[]) => void, workers: string) => {
          insert([actor("configured", { parentId: null })]);
          mkdirSync(join(workers, "configured"), { recursive: true });
        },
        reason: /spawned-actor workspace at workers\/configured/,
      },
      {
        name: "a native session another actor also records",
        setup: (insert: (records: ActorRecord[]) => void) =>
          insert([
            actor("configured", { parentId: null, sessionId: "shared-session" }),
            actor("child", { sessionId: "shared-session" }),
          ]),
        reason: /session is also recorded for child/,
      },
    ])("refuses a sole top-level candidate with $name until it is named", ({ setup, reason }) => {
      setup(insertAll, join(home, "workers"));
      const before = snapshot();

      const err = refusal(() => run());
      expect(err.message).toMatch(reason);
      expect(err.candidates).toEqual(["configured"]);
      expect(snapshot()).toEqual(before);
      expect(receiptRows()).toEqual([]);

      const result = run({ selectedActorId: "configured" });
      expect(result.plan).toEqual({ kind: "adopt", actorId: "configured", selected: true });
      expect(repositories.legacyImportReceipts.actorFor(CONFIGURED_ACTOR_IMPORT_SOURCE)).toBe(
        "configured"
      );
    });

    it("refuses a named actor that does not exist or is not top-level", () => {
      insertAll(upgradedActors());

      expect(refusal(() => run({ selectedActorId: "nobody" })).message).toMatch(
        /names nobody, which has no actor record/
      );
      expect(refusal(() => run({ selectedActorId: "lead" })).message).toMatch(
        /lead, which is not top-level/
      );
      expect(receiptRows()).toEqual([]);
    });

    it("consults the operator's choice only before the import completes", () => {
      insertAll(upgradedActors());
      run();

      expect(plan("configured")).toEqual({ kind: "completed", actorId: "configured" });
      expect(refusal(() => plan("lead")).message).toMatch(/already imported as configured/);
    });
  });

  describe("retired and missing imported actor", () => {
    beforeEach(() => {
      insertAll(upgradedActors());
      run();
    });

    it("refuses a retired imported actor without reviving or replacing it", () => {
      repositories.actors.patch("configured", { status: "retired" });
      const before = snapshot();

      const err = refusal(() => run({ idgen: () => "replacement" }));
      expect(err.message).toMatch(/imported configured actor configured is retired/);
      expect(snapshot()).toEqual(before);
      expect(repositories.actors.get("configured")?.status).toBe("retired");
      expect(repositories.actors.get("replacement")).toBeUndefined();
    });

    it("refuses a missing imported actor without minting a replacement", () => {
      db.pragma("foreign_keys = OFF");
      db.prepare("DELETE FROM actors WHERE id = ?").run("configured");
      db.pragma("foreign_keys = ON");
      const before = snapshot();

      const err = refusal(() => run({ idgen: () => "replacement" }));
      expect(err.message).toMatch(/configured has no actor record/);
      expect(err.action).toMatch(/will not create a replacement/);
      expect(snapshot()).toEqual(before);
      // Not even an empty-home create: the receipt alone decides.
      db.prepare("DELETE FROM actors").run();
      expect(refusal(() => run({ idgen: () => "replacement" })).message).toMatch(/no actor record/);
      expect(repositories.actors.list()).toEqual([]);
    });

    it("refuses an imported actor that has been reparented", () => {
      repositories.actors.upsert(actor("new-top", { parentId: null }));
      repositories.actors.patch("configured", { parentId: "new-top" });

      expect(refusal(() => run()).message).toMatch(/no longer top-level \(parent new-top\)/);
    });

    it("refuses a receipt that names no actor", () => {
      db.prepare("UPDATE legacy_import_receipts SET actor_id = NULL").run();

      expect(refusal(() => run()).message).toMatch(/receipt names no actor/);
    });
  });

  describe("single top-level guard", () => {
    it("stays in force after the import: the receipt never admits a second top-level actor", () => {
      insertAll(upgradedActors());
      run();
      // A second top-level row that appears after the import is not refused by
      // the import (the receipt decides which actor is configured) ...
      repositories.actors.upsert(actor("second-top", { parentId: null }));
      expect(plan()).toEqual({ kind: "completed", actorId: "configured" });

      // ... but adoption still refuses to run with two.
      const mesh = new ActorMesh({
        actors: repositories.actors,
        createActor: () => {
          throw new Error("not booted in this test");
        },
      });
      const stored = repositories.actors.get("configured");
      if (!stored) throw new Error("configured actor missing");
      expect(() => mesh.adopt(stored, { requestRun: () => {} } as never)).toThrow(
        /Cannot add configured as a second top-level actor: second-top is already top-level/
      );
    });
  });
});
