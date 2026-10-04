import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { meshGitIdentityArgs, resolveMeshGitIdentity } from "./mesh-git-identity.js";

// Synthetic identities only: a disposable HOME and global config file stand in
// for the machine's owner, so no real account's Git config is read or written.
describe("mesh Git identity (#894)", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let globalConfig: string;

  const git = (cwd: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    execFileSync("git", args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf-8" }).trim();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mesh-git-identity-"));
    globalConfig = join(root, "global.gitconfig");
    env = {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the identity from global config without writing it", () => {
    writeFileSync(globalConfig, "[user]\n\tname = Mesh Bot\n\temail = mesh-bot@example.invalid\n");
    const before = readFileSync(globalConfig, "utf-8");

    expect(resolveMeshGitIdentity(env)).toEqual({
      name: "Mesh Bot",
      email: "mesh-bot@example.invalid",
    });
    expect(readFileSync(globalConfig, "utf-8")).toBe(before);
  });

  it("reports no identity when global config lacks a name or email", () => {
    writeFileSync(globalConfig, "[user]\n\tname = Mesh Bot\n");
    expect(resolveMeshGitIdentity(env)).toBeNull();
  });

  it("commits as the mesh for one command and leaves a person's local and global identity unchanged", () => {
    // The machine's owner: a global identity plus a different repo-local one.
    writeFileSync(
      globalConfig,
      "[user]\n\tname = Human Global\n\temail = human-global@example.invalid\n"
    );
    const repo = join(root, "repo");
    git(root, ["init", "-q", repo]);
    git(repo, ["config", "user.name", "Human Local"]);
    git(repo, ["config", "user.email", "human-local@example.invalid"]);
    const localConfig = join(repo, ".git", "config");
    const globalBefore = readFileSync(globalConfig, "utf-8");
    const localBefore = readFileSync(localConfig, "utf-8");

    const mesh = { name: "Mesh Bot", email: "mesh-bot@example.invalid" };
    git(repo, [...meshGitIdentityArgs(mesh), "commit", "-q", "--allow-empty", "-m", "mesh"]);

    expect(git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
      "Mesh Bot <mesh-bot@example.invalid>|Mesh Bot <mesh-bot@example.invalid>"
    );
    expect(readFileSync(globalConfig, "utf-8")).toBe(globalBefore);
    expect(readFileSync(localConfig, "utf-8")).toBe(localBefore);

    // A person's own commit in the same repository still uses their identity.
    git(repo, ["commit", "-q", "--allow-empty", "-m", "human"]);
    expect(git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
      "Human Local <human-local@example.invalid>|Human Local <human-local@example.invalid>"
    );
  });
});
