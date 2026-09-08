import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildActorBwrapArgs } from "../providers/sandbox.js";
import { type E2EGitRemoteServer, startE2EGitRemoteServer } from "./git-remote-server.js";

const execFileAsync = promisify(execFile);

function probeBwrapCapable(): boolean {
  try {
    execFileSync("bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const BWRAP_CAPABLE = probeBwrapCapable();

/** Mirrors provision.ts's own bare-remote shape: `init --bare` + one pushed commit on main. */
function initBareRemoteWithInitialCommit(remoteDir: string): void {
  mkdirSync(dirname(remoteDir), { recursive: true });
  execFileSync("git", ["init", "--bare", "-b", "main", remoteDir]);
  const seedClone = mkdtempSync(join(tmpdir(), "git-remote-seed-"));
  try {
    execFileSync("git", ["clone", remoteDir, seedClone]);
    writeFileSync(join(seedClone, "README.md"), "seed\n", "utf8");
    execFileSync("git", ["-C", seedClone, "add", "README.md"]);
    execFileSync("git", [
      "-C",
      seedClone,
      "-c",
      "user.name=seed",
      "-c",
      "user.email=seed@example.com",
      "commit",
      "-m",
      "seed",
    ]);
    execFileSync("git", ["-C", seedClone, "push", "origin", "main"]);
  } finally {
    rmSync(seedClone, { recursive: true, force: true });
  }
}

describe("startE2EGitRemoteServer", () => {
  let remoteRoot: string;
  let remoteDir: string;
  let server: E2EGitRemoteServer | undefined;

  beforeEach(() => {
    remoteRoot = mkdtempSync(join(tmpdir(), "e2e-git-remote-"));
    remoteDir = join(remoteRoot, "remote", "repo.git");
    initBareRemoteWithInitialCommit(remoteDir);
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    rmSync(remoteRoot, { recursive: true, force: true });
  });

  it("serves clone + push over loopback HTTP, and the pushed ref is visible directly in the bare repo afterward", async () => {
    server = await startE2EGitRemoteServer({ repoDir: remoteDir, port: 0 });
    const remote = server;
    expect(remote.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/repo\.git$/);

    const clonePath = mkdtempSync(join(tmpdir(), "e2e-git-remote-clone-"));
    try {
      // The HTTP server runs in this test process, so network Git commands must
      // yield to its event loop rather than synchronously blocking it.
      await execFileAsync("git", ["clone", remote.url, clonePath]);
      await execFileAsync("git", ["-C", clonePath, "checkout", "-b", "feature"]);
      writeFileSync(join(clonePath, "file.txt"), "hello\n", "utf8");
      await execFileAsync("git", ["-C", clonePath, "add", "file.txt"]);
      await execFileAsync("git", [
        "-C",
        clonePath,
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "add file",
      ]);
      await execFileAsync("git", ["-C", clonePath, "push", "origin", "feature"]);

      // Post-push visibility: read the bare repo directly, not through the pushing clone.
      const revParse = execFileSync("git", ["-C", remoteDir, "rev-parse", "refs/heads/feature"], {
        encoding: "utf8",
      }).trim();
      expect(revParse).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(clonePath, { recursive: true, force: true });
    }
  });

  it("only ever advertises a loopback host in the returned URL", async () => {
    server = await startE2EGitRemoteServer({ repoDir: remoteDir, port: 0 });
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
  });

  it("returns 404 for any path outside the served repo, even with GIT_HTTP_EXPORT_ALL set", async () => {
    server = await startE2EGitRemoteServer({ repoDir: remoteDir, port: 0 });
    const res = await fetch(`http://127.0.0.1:${server.port}/../../etc/passwd/info/refs`);
    expect(res.status).toBe(404);
  });

  it("close() fully releases the port so a fresh server can rebind to it", async () => {
    server = await startE2EGitRemoteServer({ repoDir: remoteDir, port: 0 });
    const { port } = server;
    await server.close();
    server = undefined;

    server = await startE2EGitRemoteServer({ repoDir: remoteDir, port });
    expect(server.port).toBe(port);
  });

  it("leaves no dangling listener on startup failure — a later bind to the same port still succeeds", async () => {
    const blocker = await startE2EGitRemoteServer({ repoDir: remoteDir, port: 0 });
    const { port } = blocker;
    try {
      await expect(startE2EGitRemoteServer({ repoDir: remoteDir, port })).rejects.toThrow();
    } finally {
      await blocker.close();
    }

    // If the failed attempt above had leaked a listener bound to `port`, this would fail too.
    server = await startE2EGitRemoteServer({ repoDir: remoteDir, port });
    expect(server.port).toBe(port);
  });
});

describe.skipIf(!BWRAP_CAPABLE)(
  "sandboxed native clone/push over the loopback e2e remote (real bwrap)",
  () => {
    // Rooted under the workspace (which is below $HOME), not tmpdir(): the sandbox shadows /tmp with an empty
    // tmpfs (see e2e-actor-mesh.ts), so a path under /tmp wouldn't even exist
    // inside bwrap — which would make "no writable bind" indistinguishable from
    // "no bind at all". Under $HOME the path is real (ro-bound) but not writable,
    // which is the actual property this test is asserting.
    let instanceRoot: string;
    let remoteDir: string;
    let server: E2EGitRemoteServer | undefined;
    let actorDir = "";

    beforeEach(async () => {
      instanceRoot = mkdtempSync(join(process.cwd(), ".e2e-git-remote-"));
      remoteDir = join(instanceRoot, "remote", "repo.git");
      initBareRemoteWithInitialCommit(remoteDir);
      server = await startE2EGitRemoteServer({ repoDir: remoteDir, port: 0 });
      actorDir = join(instanceRoot, "actor");
      mkdirSync(actorDir, { recursive: true });
    });

    afterEach(async () => {
      await server?.close();
      server = undefined;
      rmSync(instanceRoot, { recursive: true, force: true });
    });

    it("rewrites the synthetic GitHub URL and pushes from sandboxed root and worker actors, visible on the host afterward", async () => {
      const remote = server;
      if (!remote) throw new Error("e2e git remote server did not start");
      const gitConfig = join(instanceRoot, "gitconfig");
      const syntheticUrl = "https://github.com/rusa-e2e/scratch.git";
      writeFileSync(
        gitConfig,
        [
          `[url "${remote.url}"]`,
          "\tinsteadOf = https://github.com/rusa-e2e/scratch",
          "\tinsteadOf = https://github.com/rusa-e2e/scratch.git",
          "",
        ].join("\n"),
        "utf8"
      );

      for (const [actorKind, isE2eRoot] of [
        ["root", true],
        ["worker", false],
      ] as const) {
        const actorPath = join(instanceRoot, actorKind);
        mkdirSync(actorPath, { recursive: true });
        const { args } = buildActorBwrapArgs(actorPath, undefined, undefined, isE2eRoot);
        const branch = `${actorKind}-feature`;

        await execFileAsync(
          "bwrap",
          [
            ...args,
            "--",
            "/bin/sh",
            "-c",
            `set -e
             cd '${actorPath}'
             git clone '${syntheticUrl}' clone
             cd clone
             git checkout -b '${branch}'
             echo '${actorKind}' > file.txt
             git add file.txt
             git -c user.name=sandbox -c user.email=sandbox@example.com commit -m "${actorKind} push"
             git push origin '${branch}'`,
          ],
          { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig } }
        );

        // Post-push visibility, read straight from the bare repo on the host.
        const revParse = execFileSync(
          "git",
          ["-C", remoteDir, "rev-parse", `refs/heads/${branch}`],
          { encoding: "utf8" }
        ).trim();
        expect(revParse).toMatch(/^[0-9a-f]{40}$/);
      }
    });

    it("cannot write directly to the remote's bare repo path from inside the sandbox (no writable host-remote bind)", async () => {
      const { args } = buildActorBwrapArgs(actorDir);
      const plantedFile = join(remoteDir, "SANDBOX_WROTE_THIS");

      await expect(
        execFileAsync("bwrap", [...args, "--", "/bin/sh", "-c", `touch '${plantedFile}'`], {
          encoding: "utf8",
        })
      ).rejects.toThrow();

      expect(existsSync(plantedFile)).toBe(false);
    });
  }
);
