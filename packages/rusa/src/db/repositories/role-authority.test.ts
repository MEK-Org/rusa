import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { closeDb, getDb, getRepositories, initDb } from "../index.js";
import { runMigrations } from "../migrations/runner.js";
import { ActorRunRepository } from "./actor-run-repository.js";
import { createFollowerRepositories, Repositories } from "./index.js";

const migrated = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
};

/** Every object reachable from `root` through own data properties and prototypes. */
function reachable(root: unknown): unknown[] {
  const seen = new Set<unknown>();
  const walk = (value: unknown) => {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) walk(descriptor.value);
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== Function.prototype) walk(proto);
  };
  walk(root);
  return [...seen];
}

describe("follower repository authority (#1019)", () => {
  afterEach(() => closeDb());

  it("returns only the host-local run capabilities, with no global repository or database handle reachable", () => {
    const db = migrated();
    const follower = createFollowerRepositories(db);

    expect(Object.keys(follower).sort()).toEqual(["actorRuns", "runPrompts"]);
    expect(Object.getPrototypeOf(follower)).toBe(Object.prototype);
    expect(Object.isFrozen(follower)).toBe(true);
    expect(Object.isFrozen(follower.actorRuns)).toBe(true);
    expect(Object.isFrozen(follower.runPrompts)).toBe(true);
    expect(Reflect.ownKeys(follower.actorRuns).sort()).toEqual([
      "abandon",
      "abandonOpen",
      "complete",
      "listRecentCompleted",
      "start",
    ]);
    expect(Reflect.ownKeys(follower.runPrompts)).toEqual(["recordForActor"]);

    // Negative authority: the global aggregate's members and the old raw escape
    // hatches are absent, and nothing reachable is a repository or the database.
    const untyped = follower as unknown as Record<string, unknown>;
    for (const name of Reflect.ownKeys(new Repositories(db)).map(String))
      if (name !== "actorRuns" && name !== "runPrompts")
        expect(untyped[name], name).toBeUndefined();
    for (const name of ["db", "role", "rawObligations", "rawSqliteInbox", "portableContext"])
      expect(untyped[name], name).toBeUndefined();
    for (const value of reachable(follower)) {
      expect(value).not.toBeInstanceOf(Database);
      expect(value).not.toBeInstanceOf(ActorRunRepository);
    }
    expect(() => Object.assign(untyped, { obligations: {} })).toThrow(TypeError);
    expect(() => Object.assign(follower.actorRuns, { getById: () => undefined })).toThrow(
      TypeError
    );
    db.close();
  });

  it("writes host-local runs and prompts that read back from the follower database", () => {
    const db = migrated();
    const follower = createFollowerRepositories(db);
    const modelConfig = { version: 1 as const, provider: "claude", model: "sonnet" };

    follower.actorRuns.start({
      id: "run-1",
      actorId: "actor-1",
      startedAt: "2026-10-18T08:00:00.000Z",
      modelConfig,
    });
    follower.runPrompts.recordForActor("actor-1", "run-1", "Prompt for run 1");
    follower.actorRuns.complete("run-1", {
      endedAt: "2026-10-18T08:01:00.000Z",
      success: true,
      exitCode: 0,
      output: "Run 1 output",
    });

    expect(follower.actorRuns.listRecentCompleted("actor-1", 5).map((run) => run.id)).toEqual([
      "run-1",
    ]);
    expect(db.prepare("SELECT id, actor_id, outcome, output FROM actor_runs").all()).toEqual([
      { id: "run-1", actor_id: "actor-1", outcome: "completed", output: "Run 1 output" },
    ]);
    expect(db.prepare("SELECT run_id, prompt FROM run_prompts").all()).toEqual([
      { run_id: "run-1", prompt: "Prompt for run 1" },
    ]);
    db.close();
  });

  it("binds one role per process at the getRepositories boundary, leaving the leader aggregate unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-role-authority-"));
    try {
      initDb(dir);
      const follower = getRepositories("follower");
      expect(Object.keys(follower).sort()).toEqual(["actorRuns", "runPrompts"]);
      expect(getRepositories("follower")).toBe(follower);
      expect(() => getRepositories("leader")).toThrow(
        /already initialized for role "follower", cannot access as "leader"/
      );
      expect(() => getRepositories()).toThrow(/cannot access as "leader"/);
      closeDb();

      initDb(dir);
      const leader = getRepositories();
      expect(leader).toBeInstanceOf(Repositories);
      expect(getRepositories("leader")).toBe(leader);
      expect(leader.obligations).toBeDefined();
      expect(leader.actorRuns).toBeInstanceOf(ActorRunRepository);
      expect(() => getRepositories("follower")).toThrow(/cannot access as "follower"/);
      expect(getDb()).toBeInstanceOf(Database);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not bind a role when the database is unavailable", () => {
    closeDb();
    expect(() => getRepositories("follower")).toThrow();
    const dir = mkdtempSync(join(tmpdir(), "rusa-role-authority-"));
    try {
      initDb(dir);
      expect(getRepositories()).toBeInstanceOf(Repositories);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
