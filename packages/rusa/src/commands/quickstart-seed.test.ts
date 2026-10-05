import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startGitHttpServer } from "../gitops/git-http-server.js";
import { addWorktree, generateRepoKey } from "../gitops/worktree.js";
import { createSeedBundle, runQuickstartSeed } from "./quickstart.js";

// Real git, real bridge: the host repo travels as a bundle (as quickstart hands
// it to the setup container) and must come out of the bridge as a usable base.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function commit(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${message}\n`, "utf8");
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

// Clients must not block the event loop: the bridge runs in this process.
async function gitAsync(
  cwd: string,
  args: string[]
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stderr };
}

describe("quickstart seeding through the real git bridge", () => {
  let root: string;
  let mcHome: string;
  let hostRepo: string;
  let server: Server;
  let bridgeUrl: string;
  const repoKey = "local/demo";

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "rusa-quickstart-seed-"));
    mcHome = join(root, "home");
    hostRepo = join(root, "demo");
    execFileSync("git", ["init", "-b", "main", hostRepo], { stdio: "pipe" });
    git(hostRepo, "config", "user.name", "Quickstart Tester");
    git(hostRepo, "config", "user.email", "quickstart@example.com");
    server = startGitHttpServer(mcHome, 0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    bridgeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${repoKey}.git`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  function seed(): void {
    const bundle = createSeedBundle(hostRepo, "main", root);
    runQuickstartSeed({ home: mcHome, repo: repoKey, bundle, branch: "main" });
  }

  it("serves the host HEAD as the base branch and addWorktree branches from it", async () => {
    const head = commit(hostRepo, "README.md", "initial");
    seed();

    const clone = join(root, "clone");
    const cloned = await gitAsync(root, ["clone", bridgeUrl, clone]);
    expect(cloned.stderr).not.toContain("fatal");
    expect(cloned.code).toBe(0);
    expect(git(clone, "rev-parse", "HEAD")).toBe(head);
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

    const worktree = addWorktree({
      mcHome,
      repoKey: generateRepoKey(repoKey),
      key: "task-1",
      branchName: "mc/task-1",
      baseBranch: "main",
    });
    expect(worktree.error).toBeUndefined();
    expect(worktree.success).toBe(true);
    expect(git(worktree.path, "rev-parse", "HEAD")).toBe(head);
    // No invented identity lands in the repository's config (#909).
    expect(() => git(worktree.path, "config", "--local", "--get-regexp", "^user\\.")).toThrow();
  });

  it("keeps the mc/* receive restriction on the seeded repo", async () => {
    commit(hostRepo, "README.md", "initial");
    seed();

    const clone = join(root, "clone");
    expect((await gitAsync(root, ["clone", bridgeUrl, clone])).code).toBe(0);
    git(clone, "config", "user.name", "Agent");
    git(clone, "config", "user.email", "agent@example.com");
    commit(clone, "agent.md", "agent work");

    expect((await gitAsync(clone, ["push", "origin", "HEAD:refs/heads/mc/agent"])).code).toBe(0);
    const rejected = await gitAsync(clone, ["push", "origin", "HEAD:refs/heads/main"]);
    expect(rejected.code).not.toBe(0);
    expect(rejected.stderr).toContain("rejects writes outside refs/heads/mc/*");
  });

  it("reseeding fast-forwards the base and keeps existing agent branches", async () => {
    commit(hostRepo, "README.md", "initial");
    seed();

    const clone = join(root, "clone");
    expect((await gitAsync(root, ["clone", bridgeUrl, clone])).code).toBe(0);
    git(clone, "config", "user.name", "Agent");
    git(clone, "config", "user.email", "agent@example.com");
    const agentHead = commit(clone, "agent.md", "agent work");
    expect((await gitAsync(clone, ["push", "origin", "HEAD:refs/heads/mc/agent"])).code).toBe(0);

    const newHead = commit(hostRepo, "CHANGELOG.md", "host follow-up");
    seed();

    expect((await gitAsync(clone, ["fetch", "origin"])).code).toBe(0);
    expect(git(clone, "rev-parse", "origin/main")).toBe(newHead);
    expect(git(clone, "rev-parse", "origin/mc/agent")).toBe(agentHead);
  });

  it("fails without touching the bridge when the host base no longer fast-forwards", () => {
    commit(hostRepo, "README.md", "initial");
    const seeded = commit(hostRepo, "a.md", "seeded");
    seed();

    git(hostRepo, "reset", "--hard", "HEAD~1");
    commit(hostRepo, "b.md", "rewritten");
    expect(() => seed()).toThrow(/fast-forward/);

    const bare = join(mcHome, "workspaces", generateRepoKey(repoKey), "repo.git");
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(seeded);
  });
});
