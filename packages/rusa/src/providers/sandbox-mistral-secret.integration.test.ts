import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    writeFileSync(
      join(mcHome, "capability-grants.json"),
      JSON.stringify({
        grants: [
          {
            actorId,
            capability: "secret:mistral-api-key",
            grantedBy: "parent-test",
            grantedAt: "2026-08-12T00:00:00Z",
          },
        ],
      })
    );

    const result = buildActorBwrapArgs(actorDir, "antigravity");
    const argv = buildActorBwrapCommand(result, "/bin/sh", [
      "-c",
      'printf "%s" "$MISTRAL_API_KEY"',
    ]);

    expect(argv.join("\0")).not.toContain(fixtureValue);
    expect(execFileSync("bwrap", argv, { encoding: "utf8" })).toBe(fixtureValue);
  });
});
