import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIdentityGuidance } from "../actor/worker-prompt.js";
import { meshGitIdentityArgs, resolveMeshGitIdentity } from "./mesh-git-identity.js";

const MESH = { name: "Mesh Bot", email: "mesh-bot@example.invalid" };
const UNCARRIABLE =
  "config.yaml gitIdentity contains <, >, a line break or a NUL byte, which a Git command cannot carry intact";

describe("resolveMeshGitIdentity (#909)", () => {
  it("resolves a complete configured pair, trimmed", () => {
    expect(
      resolveMeshGitIdentity({ name: " Mesh Bot ", email: " mesh-bot@example.invalid " })
    ).toEqual({ identity: MESH });
  });

  it.each([
    [undefined, "config.yaml has no gitIdentity"],
    [null, "config.yaml has no gitIdentity"],
    ["Mesh Bot", "config.yaml gitIdentity is not a mapping of name and email"],
    [[MESH], "config.yaml gitIdentity is not a mapping of name and email"],
    [{}, "config.yaml gitIdentity lacks name and email"],
    [{ name: "  ", email: "" }, "config.yaml gitIdentity lacks name and email"],
    [{ name: "Mesh Bot" }, "config.yaml gitIdentity lacks email"],
    [{ email: "mesh-bot@example.invalid" }, "config.yaml gitIdentity lacks name"],
    [{ name: 7, email: "mesh-bot@example.invalid" }, "config.yaml gitIdentity lacks name"],
    [{ name: "Mesh <Bot>", email: "mesh-bot@example.invalid" }, UNCARRIABLE],
    [{ name: "Mesh\nBot", email: "mesh-bot@example.invalid" }, UNCARRIABLE],
    [{ name: "Mesh\u0000Bot", email: "mesh-bot@example.invalid" }, UNCARRIABLE],
  ])("reports a gap for %j", (configured, gap) => {
    expect(resolveMeshGitIdentity(configured)).toEqual({ identity: null, gap });
  });
});

describe("Git identity guidance (#909)", () => {
  it("names the configured identity and its command-scoped use", () => {
    const text = gitIdentityGuidance(resolveMeshGitIdentity(MESH));
    expect(text).toContain("**Mesh Bot\n<mesh-bot@example.invalid>**");
    expect(text).toContain(
      "git -c 'user.name=Mesh Bot' -c user.email=mesh-bot@example.invalid commit"
    );
    expect(text).toContain("`gitIdentity` in rusa's config.yaml");
    expect(text).not.toContain("global Git config");
  });

  it("states the concrete gap and holds commits without stopping other work", () => {
    const text = gitIdentityGuidance(resolveMeshGitIdentity({ name: "Mesh Bot" }));
    expect(text).toContain("The mesh has no Git identity: config.yaml gitIdentity lacks email.");
    expect(text).toContain("don't create\ncommits in your mesh workspace");
    expect(text).toContain("carry on with\nwork that doesn't need one");
    expect(text).not.toContain("git -c");
  });
});

// Synthetic identities only: a disposable HOME and global config file stand in
// for the machine's owner, so no real account's Git config is read or written.
describe("mesh Git identity in a disposable repository (#894, #909)", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let globalConfig: string;

  const git = (cwd: string, args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf-8" }).trim();

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

  it("commits as the configured identity and leaves a person's local and global identity unchanged", () => {
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
    const globalBefore = readFileSync(globalConfig);
    const localBefore = readFileSync(localConfig);

    const { identity } = resolveMeshGitIdentity(MESH);
    if (!identity) throw new Error("expected a resolved identity");
    git(repo, [...meshGitIdentityArgs(identity), "commit", "-q", "--allow-empty", "-m", "mesh"]);

    expect(git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
      "Mesh Bot <mesh-bot@example.invalid>|Mesh Bot <mesh-bot@example.invalid>"
    );
    expect(readFileSync(globalConfig).equals(globalBefore)).toBe(true);
    expect(readFileSync(localConfig).equals(localBefore)).toBe(true);

    // A person's own commit in the same repository still uses their identity.
    git(repo, ["commit", "-q", "--allow-empty", "-m", "human"]);
    expect(git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"])).toBe(
      "Human Local <human-local@example.invalid>|Human Local <human-local@example.invalid>"
    );
  });

  it("keeps a replayed commit's author, and yields to inherited identity variables unless they are cleared", () => {
    const repo = join(root, "repo");
    git(root, ["init", "-q", repo]);
    const { identity } = resolveMeshGitIdentity(MESH);
    if (!identity) throw new Error("expected a resolved identity");
    const mesh = meshGitIdentityArgs(identity);
    const head = () => git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]);
    const person = ["-c", "user.name=Someone", "-c", "user.email=someone@example.invalid"];

    git(repo, [...person, "commit", "-q", "--allow-empty", "-m", "base"]);
    git(repo, ["checkout", "-q", "-b", "side"]);
    git(repo, [...person, "commit", "-q", "--allow-empty", "-m", "theirs"]);
    git(repo, ["checkout", "-q", "-"]);
    git(repo, [...mesh, "cherry-pick", "--allow-empty", "side"]);
    expect(head()).toBe("Someone <someone@example.invalid>|Mesh Bot <mesh-bot@example.invalid>");

    const inherited = {
      GIT_AUTHOR_NAME: "Inherited",
      GIT_AUTHOR_EMAIL: "inherited@example.invalid",
      GIT_COMMITTER_NAME: "Inherited",
      GIT_COMMITTER_EMAIL: "inherited@example.invalid",
    };
    const withInherited = { ...env, ...inherited };
    execFileSync("git", [...mesh, "commit", "-q", "--allow-empty", "-m", "inherited"], {
      cwd: repo,
      env: withInherited,
    });
    expect(head()).toBe(
      "Inherited <inherited@example.invalid>|Inherited <inherited@example.invalid>"
    );

    // What the guidance prescribes: clear them for the command with `env -u`.
    const unset = Object.keys(inherited).flatMap((key) => ["-u", key]);
    execFileSync(
      "env",
      [...unset, "git", ...mesh, "commit", "-q", "--allow-empty", "-m", "cleared"],
      {
        cwd: repo,
        env: withInherited,
      }
    );
    expect(head()).toBe("Mesh Bot <mesh-bot@example.invalid>|Mesh Bot <mesh-bot@example.invalid>");
  });
});
