import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitIdentityGuidance } from "../actor/worker-prompt.js";
import { meshGitIdentityArgs, resolveMeshGitIdentity } from "./mesh-git-identity.js";

const MESH = { name: "Mesh Bot", email: "mesh-bot@example.invalid" };
const UNCARRIABLE =
  "config.yaml gitIdentity contains <, >, a line break or a NUL byte, which is not accepted for a mesh Git identity";

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
    [{ name: "Mesh\rBot", email: "mesh-bot@example.invalid" }, UNCARRIABLE],
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
      "git -c 'author.name=Mesh Bot' -c author.email=mesh-bot@example.invalid -c 'committer.name=Mesh Bot' -c committer.email=mesh-bot@example.invalid commit"
    );
    expect(text).toContain(
      "env -u GIT_AUTHOR_NAME -u GIT_AUTHOR_EMAIL -u GIT_COMMITTER_NAME -u\nGIT_COMMITTER_EMAIL git …"
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

  it("commits and replays as the configured identity over a person's Git config, leaving it unchanged", () => {
    // The machine's owner: a global identity, including the role-specific keys
    // Git reads before user.*, plus a different repo-local one.
    writeFileSync(
      globalConfig,
      [
        "[user]\n\tname = Human Global\n\temail = human-global@example.invalid\n",
        "[author]\n\tname = Human Author\n\temail = human-author@example.invalid\n",
        "[committer]\n\tname = Human Committer\n\temail = human-committer@example.invalid\n",
      ].join("")
    );
    const repo = join(root, "repo");
    git(root, ["init", "-q", repo]);
    git(repo, ["config", "user.name", "Human Local"]);
    git(repo, ["config", "user.email", "human-local@example.invalid"]);
    const localConfig = join(repo, ".git", "config");
    const globalBefore = readFileSync(globalConfig);
    const localBefore = readFileSync(localConfig);
    const head = () => git(repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"]);

    const { identity } = resolveMeshGitIdentity(MESH);
    if (!identity) throw new Error("expected a resolved identity");
    const mesh = meshGitIdentityArgs(identity);
    git(repo, [...mesh, "commit", "-q", "--allow-empty", "-m", "mesh"]);
    expect(head()).toBe("Mesh Bot <mesh-bot@example.invalid>|Mesh Bot <mesh-bot@example.invalid>");

    // A person's own commit in the same repository still uses their configuration.
    git(repo, ["checkout", "-q", "-b", "side"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "human"]);
    const human = "Human Author <human-author@example.invalid>";
    expect(head()).toBe(`${human}|Human Committer <human-committer@example.invalid>`);

    // A replay keeps that author and records the mesh as committer.
    git(repo, ["checkout", "-q", "-"]);
    git(repo, [...mesh, "cherry-pick", "--allow-empty", "side"]);
    expect(head()).toBe(`${human}|Mesh Bot <mesh-bot@example.invalid>`);

    expect(readFileSync(globalConfig).equals(globalBefore)).toBe(true);
    expect(readFileSync(localConfig).equals(localBefore)).toBe(true);
  });
});
