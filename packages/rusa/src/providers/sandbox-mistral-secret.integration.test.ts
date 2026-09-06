import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrations/runner.js";
import { buildActorBwrapArgs, buildActorBwrapCommand, teardownFlutterOverlay } from "./sandbox.js";

vi.mock("../config/loader.js", () => ({
  loadConfig: () => ({
    github: { account: "test" },
    providers: {},
    webhook: { port: 9742, secret: "secret" },
    gitBridge: false,
  }),
}));

function probeBwrapCapable(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BWRAP_CAPABLE = probeBwrapCapable();

describe.skipIf(!BWRAP_CAPABLE)("Mistral grant entrypoint (real bwrap)", () => {
  const originalHome = process.env.HOME;
  const fixtureRoots: string[] = [];

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const root of fixtureRoots.splice(0)) {
      teardownFlutterOverlay(join(root, ".rusa", "workers", "worker-mistral-test"));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the bound dummy key inside the sandbox and exports it to the real command", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "mc-mistral-bwrap-"));
    fixtureRoots.push(fixtureRoot);
    process.env.HOME = fixtureRoot;

    const actorId = "worker-mistral-test";
    const mcHome = join(fixtureRoot, ".rusa");
    const actorDir = join(mcHome, "workers", actorId);
    const secretsDir = join(mcHome, "secrets");
    const keyPath = join(secretsDir, "mistral-api-key");
    const fixtureValue = "dummy-mistral-value-from-bound-file";
    mkdirSync(actorDir, { recursive: true });
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(keyPath, `${fixtureValue}\n`, { mode: 0o600 });

    // Grants live in `<mcHome>/data/mesh.db`'s `capability_grants` table
    // (0036_capability_grants), not `capability-grants.json`.
    const dataDir = join(mcHome, "data");
    mkdirSync(dataDir, { recursive: true });
    const db = new Database(join(dataDir, "mesh.db"));
    runMigrations(db);
    db.pragma("foreign_keys = ON");
    db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES ('root', 'test actor', NULL, '2026-06-27T00:00:00Z')"
    ).run();
    db.prepare(
      "INSERT INTO actors (id, charter, parent_id, created_at) VALUES (?, 'test actor', 'root', '2026-06-27T00:00:00Z')"
    ).run(actorId);
    db.prepare(
      `INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at, revoked_at)
       VALUES (?, 'secret:mistral-api-key', 'parent-test', '2026-08-12T00:00:00Z', NULL)`
    ).run(actorId);
    db.close();

    const result = buildActorBwrapArgs(actorDir, "antigravity");
    const argv = buildActorBwrapCommand(result, "/bin/sh", [
      "-c",
      'printf "%s" "$MISTRAL_API_KEY"',
    ]);

    expect(argv.join("\0")).not.toContain(fixtureValue);
    expect(execFileSync("bwrap", argv, { encoding: "utf8" })).toBe(fixtureValue);
  });
});
