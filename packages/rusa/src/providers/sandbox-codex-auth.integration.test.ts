import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildActorBwrapArgs, codexRolloutStoreDir, teardownFlutterOverlay } from "./sandbox.js";

function probeBwrapCapable(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BWRAP_CAPABLE = probeBwrapCapable();

describe.skipIf(!BWRAP_CAPABLE)("Codex shared auth bind (real bwrap)", () => {
  const originalHome = process.env.HOME;
  let actorDir: string;
  let fixtureHome: string;

  beforeEach(() => {
    fixtureHome = mkdtempSync(join(tmpdir(), "codex-auth-home-"));
    process.env.HOME = fixtureHome;
    actorDir = mkdtempSync(join(tmpdir(), "codex-auth-actor-"));
  });

  afterEach(() => {
    rmSync(codexRolloutStoreDir(actorDir), { recursive: true, force: true });
    teardownFlutterOverlay(actorDir);
    rmSync(actorDir, { recursive: true, force: true });
    rmSync(fixtureHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("persists a sandbox write through /tmp/auth.json to the host auth file", () => {
    const hostAuthPath = join(fixtureHome, ".codex", "auth.json");
    mkdirSync(join(fixtureHome, ".codex"), { recursive: true });
    writeFileSync(hostAuthPath, "host-before", { mode: 0o600 });

    const { args } = buildActorBwrapArgs(actorDir, "codex");
    execFileSync(
      "bwrap",
      [...args, "--", "/bin/sh", "-c", "printf sandbox-after > /tmp/auth.json"],
      { stdio: "pipe" }
    );

    expect(readFileSync(hostAuthPath, "utf8")).toBe("sandbox-after");
  });
});
