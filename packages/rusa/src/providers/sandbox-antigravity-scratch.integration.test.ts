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

describe.skipIf(!BWRAP_CAPABLE)("Antigravity provider-state isolation (real bwrap)", () => {
  const originalHome = process.env.HOME;
  let fixtureHome: string;
  let actorDir: string;
  let actorScratchDir: string;
  let actorConversationsDir: string;
  let scratchDir: string;
  let conversationsDir: string;
  let siblingCheckout: string;
  let siblingActorCheckout: string;
  let siblingConversation: string;

  beforeEach(() => {
    fixtureHome = mkdtempSync(join(tmpdir(), "antigravity-scratch-home-"));
    process.env.HOME = fixtureHome;
    actorDir = join(fixtureHome, ".rusa", "workers", "actor-one");
    actorScratchDir = join(actorDir, ".antigravity-scratch");
    actorConversationsDir = join(actorDir, ".antigravity-conversations");
    scratchDir = join(fixtureHome, ".gemini", "antigravity-cli", "scratch");
    conversationsDir = join(fixtureHome, ".gemini", "antigravity-cli", "conversations");
    siblingCheckout = join(scratchDir, "worker-sibling", "checkout.txt");
    siblingActorCheckout = join(fixtureHome, ".rusa", "workers", "actor-two", "checkout.txt");
    siblingConversation = join(conversationsDir, "sibling.db");
    mkdirSync(actorScratchDir, { recursive: true });
    mkdirSync(actorConversationsDir, { recursive: true });
    mkdirSync(join(scratchDir, "worker-sibling"), { recursive: true });
    mkdirSync(conversationsDir, { recursive: true });
    mkdirSync(join(siblingActorCheckout, ".."), { recursive: true });
    writeFileSync(join(actorScratchDir, "owned.txt"), "actor-owned");
    writeFileSync(siblingCheckout, "sibling-only");
    writeFileSync(siblingActorCheckout, "sibling-only");
    writeFileSync(siblingConversation, "sibling-only");
  });

  afterEach(() => {
    teardownFlutterOverlay(actorDir);
    rmSync(fixtureHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("hides sibling scratch, worktree, and conversation paths", () => {
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
          `test ! -e '${siblingConversation}'`,
          `printf sandbox-write > '${join(scratchDir, "created.txt")}'`,
          `printf sandbox-conversation > '${join(conversationsDir, "created.db")}'`,
          "printf isolated",
        ].join("\n"),
      ],
      { encoding: "utf8" }
    );

    expect(output).toBe("isolated");
    expect(existsSync(join(actorScratchDir, "created.txt"))).toBe(true);
    expect(existsSync(join(actorConversationsDir, "created.db"))).toBe(true);
    expect(existsSync(join(scratchDir, "created.txt"))).toBe(false);
    expect(existsSync(join(conversationsDir, "created.db"))).toBe(false);
    expect(existsSync(siblingCheckout)).toBe(true);
    expect(existsSync(siblingActorCheckout)).toBe(true);
    expect(existsSync(siblingConversation)).toBe(true);
  });
});
