import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importLegacyCapabilityGrantState } from "./legacy-capability-grant-import.js";
import { runMigrations } from "./migrations/runner.js";
import { Repositories } from "./repositories/index.js";

const ROOT = "root";
const CHILD = "worker";
const OTHER = "some-other-actor";

function seedActors(db: Database.Database, ...ids: string[]): void {
  const insert = db.prepare(
    "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'test actor', ?, '2026-06-27T00:00:00Z')"
  );
  const [rootId, ...rest] = ids;
  if (rootId === undefined) return;
  insert.run(rootId, null);
  for (const id of rest) insert.run(id, rootId);
}

describe("legacy capability-grant import", () => {
  let home: string;
  let db: Database.Database;
  let repositories: Repositories;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "legacy-capability-grant-import-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    repositories = new Repositories(db);
    seedActors(db, ROOT, CHILD, OTHER);
  });

  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  function writeLegacy(
    grants: Array<{
      actorId: string;
      capability: string;
      grantedBy: string;
      grantedAt: string;
      revokedAt?: string;
    }>
  ): void {
    writeFileSync(join(home, "capability-grants.json"), JSON.stringify({ grants }));
  }

  const importState = () => importLegacyCapabilityGrantState({ mcHome: home, db, repositories });

  it("does nothing on a fresh install and does not create the retired file", () => {
    expect(importState()).toEqual({ importedGrants: 0, backupFiles: [] });
    expect(existsSync(join(home, "capability-grants.json"))).toBe(false);
  });

  it("imports a complete fixture of active and revoked grants and archives the source", () => {
    writeLegacy([
      {
        actorId: CHILD,
        capability: "secret:gemini-api-key",
        grantedBy: ROOT,
        grantedAt: "2026-07-17T00:00:00Z",
      },
      {
        actorId: OTHER,
        capability: "secret:mistral-api-key",
        grantedBy: ROOT,
        grantedAt: "2026-07-01T00:00:00Z",
        revokedAt: "2026-07-10T00:00:00Z",
      },
    ]);

    const result = importState();

    expect(result.importedGrants).toBe(2);
    expect(result.backupFiles).toHaveLength(1);
    expect(result.backupFiles.every(existsSync)).toBe(true);
    expect(existsSync(join(home, "capability-grants.json"))).toBe(false);

    const all = repositories.capabilityGrants.list();
    expect(all).toHaveLength(2);
    expect(repositories.capabilityGrants.activeFor(CHILD)).toEqual(["secret:gemini-api-key"]);
    expect(repositories.capabilityGrants.activeFor(OTHER)).toEqual([]);
    const revoked = all.find((g) => g.actorId === OTHER);
    expect(revoked?.revokedAt).toBe("2026-07-10T00:00:00.000Z");
    expect(revoked?.grantedBy).toBe(ROOT);
  });

  it("is a no-op on rerun once already imported (idempotent)", () => {
    writeLegacy([
      {
        actorId: CHILD,
        capability: "secret:gemini-api-key",
        grantedBy: ROOT,
        grantedAt: "2026-07-17T00:00:00Z",
      },
    ]);
    const first = importState();
    expect(first.importedGrants).toBe(1);

    copyFileSync(first.backupFiles[0], join(home, "capability-grants.json"));
    const retry = importState();

    expect(retry).toEqual({ importedGrants: 0, backupFiles: [retry.backupFiles[0]] });
    expect(existsSync(join(home, "capability-grants.json"))).toBe(false);
    expect(repositories.capabilityGrants.list()).toHaveLength(1);
  });

  it("validates every grant's actor exists before writing any rows (pre-commit failure precedence)", () => {
    writeLegacy([
      {
        actorId: "unknown-actor",
        capability: "secret:gemini-api-key",
        grantedBy: ROOT,
        grantedAt: "2026-07-17T00:00:00Z",
      },
    ]);

    expect(() => importState()).toThrow("references unknown actor");
    expect(repositories.capabilityGrants.list()).toEqual([]);
    // Interrupted before commit: the complete legacy file is left in place.
    expect(existsSync(join(home, "capability-grants.json"))).toBe(true);
  });

  it("fails loudly instead of overwriting SQLite when a leftover file diverges (post-commit failure precedence)", () => {
    writeLegacy([
      {
        actorId: CHILD,
        capability: "secret:gemini-api-key",
        grantedBy: ROOT,
        grantedAt: "2026-07-17T00:00:00Z",
      },
    ]);
    importState();
    // Simulate a stale/recreated file that disagrees with the committed DB state.
    writeLegacy([
      {
        actorId: CHILD,
        capability: "secret:gemini-api-key",
        grantedBy: "someone-else",
        grantedAt: "2026-07-17T00:00:00Z",
      },
    ]);

    expect(() => importState()).toThrow("diverges from SQLite");
    // The database view after the interruption is the complete, unmodified committed state.
    expect(repositories.capabilityGrants.list()).toMatchObject([{ grantedBy: ROOT }]);
  });

  it("leaves a recoverable backup file after commit", () => {
    writeLegacy([
      {
        actorId: CHILD,
        capability: "secret:gemini-api-key",
        grantedBy: ROOT,
        grantedAt: "2026-07-17T00:00:00Z",
      },
    ]);

    const result = importState();

    expect(result.backupFiles).toHaveLength(1);
    const [backupPath] = result.backupFiles;
    expect(backupPath).toMatch(/capability-grants\.json\.imported-.*\.bak$/);
    expect(JSON.parse(readFileSync(backupPath, "utf8"))).toMatchObject({
      grants: [expect.objectContaining({ actorId: CHILD })],
    });
  });

  it("commits rows visibly to a separate connection opened against the same file", () => {
    const filePath = join(home, "mesh-test.db");
    const writerDb = new Database(filePath);
    writerDb.pragma("journal_mode = WAL");
    writerDb.pragma("foreign_keys = ON");
    runMigrations(writerDb);
    const writerRepositories = new Repositories(writerDb);
    seedActors(writerDb, ROOT, CHILD);
    writeLegacy([
      {
        actorId: CHILD,
        capability: "secret:gemini-api-key",
        grantedBy: ROOT,
        grantedAt: "2026-07-17T00:00:00Z",
      },
    ]);

    importLegacyCapabilityGrantState({
      mcHome: home,
      db: writerDb,
      repositories: writerRepositories,
    });

    const readerDb = new Database(filePath, { readonly: true, fileMustExist: true });
    const rows = readerDb
      .prepare("SELECT actor_id, capability FROM capability_grants")
      .all() as Array<{ actor_id: string; capability: string }>;
    expect(rows).toEqual([{ actor_id: CHILD, capability: "secret:gemini-api-key" }]);
    readerDb.close();
    writerDb.close();
  });
});
