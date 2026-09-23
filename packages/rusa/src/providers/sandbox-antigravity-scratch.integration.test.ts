import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildActorBwrapArgs, teardownFlutterOverlay } from "./sandbox.js";

function probeBwrapCapable(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BWRAP_CAPABLE = probeBwrapCapable();

describe.skipIf(!BWRAP_CAPABLE)("Antigravity scratch isolation (real bwrap)", () => {
  const originalHome = process.env.HOME;
  let fixtureHome: string;
  let actorDir: string;
  let actorScratchDir: string;
  let scratchDir: string;
  let siblingCheckout: string;
  let siblingActorCheckout: string;

  beforeEach(() => {
    fixtureHome = mkdtempSync(join(tmpdir(), "antigravity-scratch-home-"));
    process.env.HOME = fixtureHome;
    actorDir = join(fixtureHome, ".rusa", "workers", "actor-one");
    actorScratchDir = join(actorDir, ".antigravity-scratch");
    scratchDir = join(fixtureHome, ".gemini", "antigravity-cli", "scratch");
    siblingCheckout = join(scratchDir, "worker-sibling", "checkout.txt");
    siblingActorCheckout = join(fixtureHome, ".rusa", "workers", "actor-two", "checkout.txt");
    mkdirSync(actorScratchDir, { recursive: true });
    mkdirSync(join(scratchDir, "worker-sibling"), { recursive: true });
    mkdirSync(join(siblingActorCheckout, ".."), { recursive: true });
    writeFileSync(join(actorScratchDir, "owned.txt"), "actor-owned");
    writeFileSync(siblingCheckout, "sibling-only");
    writeFileSync(siblingActorCheckout, "sibling-only");
  });

  afterEach(() => {
    teardownFlutterOverlay(actorDir);
    rmSync(fixtureHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("hides sibling scratch and durable paths and keeps provider writes private", () => {
    const { args } = buildActorBwrapArgs(actorDir, "antigravity");
    const output = execFileSync(
      "bwrap",
      [
        ...args,
        "--",
        "/bin/sh",
        "-c",
        [
          `test "$(cat '${join(scratchDir, "owned.txt")}')" = actor-owned`,
          `test ! -e '${siblingCheckout}'`,
          `test ! -e '${siblingActorCheckout}'`,
          `printf sandbox-write > '${join(scratchDir, "created.txt")}'`,
          "printf isolated",
        ].join("\n"),
      ],
      { encoding: "utf8" }
    );

    expect(output).toBe("isolated");
    expect(existsSync(join(actorScratchDir, "created.txt"))).toBe(true);
    expect(existsSync(join(scratchDir, "created.txt"))).toBe(false);
    expect(existsSync(siblingCheckout)).toBe(true);
    expect(existsSync(siblingActorCheckout)).toBe(true);
  });
});
