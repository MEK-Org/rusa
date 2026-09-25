import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The sandbox mounts a fresh tmpfs at /tmp, which would hide a /tmp fixture's
// sibling paths regardless of the isolation under test. Keep it outside /tmp.
const FIXTURE_PARENT = join(process.cwd(), "node_modules", ".cache", "bwrap-fixtures");

describe.skipIf(!BWRAP_CAPABLE)("Antigravity provider-state isolation (real bwrap)", () => {
  const originalHome = process.env.HOME;
  let fixtureHome: string;
  let actorDir: string;
  let actorStateDir: string;
  let stateDir: string;
  let siblingPaths: string[];

  beforeEach(() => {
    mkdirSync(FIXTURE_PARENT, { recursive: true });
    fixtureHome = mkdtempSync(join(FIXTURE_PARENT, "home-"));
    process.env.HOME = fixtureHome;
    actorDir = join(fixtureHome, ".rusa", "workers", "actor-one");
    actorStateDir = join(actorDir, ".antigravity-state");
    stateDir = join(fixtureHome, ".gemini", "antigravity-cli");
    siblingPaths = [
      join(fixtureHome, ".rusa", "workers", "actor-two", "checkout.txt"),
      join(stateDir, "scratch", "worker-sibling", "checkout.txt"),
      join(stateDir, "conversations", "sibling.db"),
      join(stateDir, "brain", "sibling", "transcript_full.jsonl"),
      join(stateDir, "annotations", "sibling.pbtxt"),
    ];
    for (const path of siblingPaths) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "sibling-only");
    }
    writeFileSync(join(stateDir, "conversation_summaries.db"), "sibling-only");
    writeFileSync(join(stateDir, "history.jsonl"), "sibling-only");
    writeFileSync(join(stateDir, "antigravity-oauth-token"), "shared-auth");
    mkdirSync(join(actorStateDir, "scratch"), { recursive: true });
    writeFileSync(join(actorStateDir, "scratch", "owned.txt"), "actor-owned");
  });

  afterEach(() => {
    teardownFlutterOverlay(actorDir);
    rmSync(fixtureHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("hides sibling worktrees and conversation state while sharing auth", () => {
    expect(fixtureHome.startsWith("/tmp/")).toBe(false);
    const { args } = buildActorBwrapArgs(actorDir, "antigravity");
    const output = execFileSync(
      "bwrap",
      [
        ...args,
        "--",
        "/bin/sh",
        "-c",
        [
          "set -e",
          `test "$(cat '${join(stateDir, "scratch", "owned.txt")}')" = actor-owned`,
          `test "$(cat '${join(stateDir, "antigravity-oauth-token")}')" = shared-auth`,
          ...siblingPaths.map((path) => `test ! -e '${path}'`),
          `! grep -q sibling-only '${join(stateDir, "conversation_summaries.db")}'`,
          `! grep -q sibling-only '${join(stateDir, "history.jsonl")}'`,
          `mkdir -p '${join(stateDir, "brain", "own")}'`,
          `printf own > '${join(stateDir, "brain", "own", "transcript_full.jsonl")}'`,
          `printf own > '${join(stateDir, "conversation_summaries.db")}'`,
          "printf isolated",
        ].join("\n"),
      ],
      { encoding: "utf8" }
    );

    expect(output).toBe("isolated");
    expect(readFileSync(join(actorStateDir, "brain", "own", "transcript_full.jsonl"), "utf8")).toBe(
      "own"
    );
    expect(readFileSync(join(actorStateDir, "conversation_summaries.db"), "utf8")).toBe("own");
    expect(existsSync(join(stateDir, "brain", "own"))).toBe(false);
    expect(readFileSync(join(stateDir, "conversation_summaries.db"), "utf8")).toBe("sibling-only");
    for (const path of siblingPaths) expect(existsSync(path)).toBe(true);
  });
});
