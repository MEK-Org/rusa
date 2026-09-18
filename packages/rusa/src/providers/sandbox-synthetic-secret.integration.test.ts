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

describe.skipIf(!BWRAP_CAPABLE)("Generic synthetic secret grant entrypoint (real bwrap)", () => {
  const originalHome = process.env.HOME;
  const fixtureRoots: string[] = [];

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    for (const root of fixtureRoots.splice(0)) {
      teardownFlutterOverlay(join(root, ".rusa", "workers", "worker-synthetic-test"));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("grants access to synthetic secret, masks ungranted secret, and removes access after revoke on next spawn", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "mc-synthetic-bwrap-"));
    fixtureRoots.push(fixtureRoot);
    process.env.HOME = fixtureRoot;

    const actorId = "worker-synthetic-test";
    const mcHome = join(fixtureRoot, ".rusa");
    const actorDir = join(mcHome, "workers", actorId);
    const secretsDir = join(mcHome, "secrets");
    const syntheticSecretPath = join(secretsDir, "synthetic-test-secret");
    const unrelatedSecretPath = join(secretsDir, "unrelated-secret");
    const syntheticValue = "synthetic-dummy-value-12345";
    const unrelatedValue = "unrelated-dummy-value-67890";

    mkdirSync(actorDir, { recursive: true });
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(syntheticSecretPath, `${syntheticValue}\n`, { mode: 0o600 });
    writeFileSync(unrelatedSecretPath, `${unrelatedValue}\n`, { mode: 0o600 });

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

    // Initial grant: secret:synthetic-test-secret is active
    db.prepare(
      `INSERT INTO capability_grants (actor_id, capability, granted_by, granted_at, revoked_at)
       VALUES (?, 'secret:synthetic-test-secret', 'parent-test', '2026-08-12T00:00:00Z', NULL)`
    ).run(actorId);

    // 1. First spawn with active grant:
    const result1 = buildActorBwrapArgs(actorDir, "antigravity");
    const argv1 = buildActorBwrapCommand(result1, "/bin/sh", [
      "-c",
      'test -f "$HOME/.rusa/secrets/synthetic-test-secret" && cat "$HOME/.rusa/secrets/synthetic-test-secret" && test ! -e "$HOME/.rusa/secrets/unrelated-secret"',
    ]);

    expect(argv1.join("\0")).not.toContain(syntheticValue);
    expect(argv1.join("\0")).not.toContain(unrelatedValue);

    const out1 = execFileSync("bwrap", argv1, { encoding: "utf8" });
    expect(out1.trim()).toBe(syntheticValue);

    // Also check derived env var
    const argvEnv = buildActorBwrapCommand(result1, "/bin/sh", [
      "-c",
      'printf "%s" "$SYNTHETIC_TEST_SECRET"',
    ]);
    expect(execFileSync("bwrap", argvEnv, { encoding: "utf8" })).toBe(syntheticValue);

    // 2. Revoke grant in DB
    db.prepare(
      "UPDATE capability_grants SET revoked_at = '2026-08-12T01:00:00Z' WHERE actor_id = ? AND capability = 'secret:synthetic-test-secret'"
    ).run(actorId);
    db.close();

    // 3. Next spawn after revocation:
    const result2 = buildActorBwrapArgs(actorDir, "antigravity");
    const argv2 = buildActorBwrapCommand(result2, "/bin/sh", [
      "-c",
      'test ! -e "$HOME/.rusa/secrets/synthetic-test-secret" && [ -z "$SYNTHETIC_TEST_SECRET" ] && printf "%s" "revoked"',
    ]);
    const out2 = execFileSync("bwrap", argv2, { encoding: "utf8" });
    expect(out2).toBe("revoked");
  });
});
