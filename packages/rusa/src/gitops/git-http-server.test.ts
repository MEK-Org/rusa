import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startGitHttpServer } from "./git-http-server.js";
import { generateRepoKey, getBareClonePath } from "./worktree.js";

async function runGit(cwd: string, args: string[]): Promise<void> {
  const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timeout);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed with code ${code}: ${stderr}`);
  }
}

async function runGitForExit(
  cwd: string,
  args: string[]
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 10_000);
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  clearTimeout(timeout);
  return { code, stderr };
}

function createWriter(mcHome: string, name: string): string {
  const writer = join(mcHome, name);
  mkdirSync(writer);

  execSync("git init", { cwd: writer });
  execSync('git config user.email "rusa-test@example.com"', { cwd: writer });
  execSync('git config user.name "Rusa Test"', { cwd: writer });
  writeFileSync(join(writer, "README.md"), `${name}\n`, "utf8");
  execSync("git add README.md", { cwd: writer });
  execSync('git commit -m "initial"', { cwd: writer });

  return writer;
}

function commitFile(cwd: string, file: string, contents: string, message: string): void {
  writeFileSync(join(cwd, file), contents, "utf8");
  execSync(`git add ${file}`, { cwd });
  execSync(`git commit -m "${message}"`, { cwd });
}

async function postChunked(url: URL, chunks: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    req.on("error", reject);
    for (const chunk of chunks.slice(0, -1)) {
      req.write(chunk);
    }
    req.end(chunks.at(-1) ?? "");
  });
}

describe("Git HTTP Server", () => {
  let mcHome: string;
  let server: Server;
  let port: number;
  const repoId = "dummy-org/dummy-repo";

  beforeAll(async () => {
    // Setup a temporary home directory
    mcHome = mkdtempSync(join(tmpdir(), "rusa-test-server-"));

    // Initialize a dummy bare git repo for our test target
    const repoKey = generateRepoKey(repoId);
    const gitDir = getBareClonePath(mcHome, repoKey);
    mkdirSync(join(mcHome, "workspaces", repoKey), { recursive: true });
    execSync(`git init --bare "${gitDir}"`);

    // Start server on a dynamic loopback port
    server = startGitHttpServer(mcHome, 0);
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    const addr = server.address() as AddressInfo;
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(mcHome, { recursive: true, force: true });
  });

  it("asserts loopback bind ONLY", () => {
    const addr = server.address() as AddressInfo;
    expect(addr.address).toBe("127.0.0.1");
  });

  it("routes git requests with .git suffix", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/dummy-org/dummy-repo.git/info/refs?service=git-upload-pack`
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("service=git-upload-pack");
  });

  it("routes git requests without .git suffix", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/dummy-org/dummy-repo/info/refs?service=git-upload-pack`
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("service=git-upload-pack");
  });

  it("advertises receive-pack for push", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/dummy-org/dummy-repo.git/info/refs?service=git-receive-pack`
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("service=git-receive-pack");
  });

  it("returns 404 for non-existent repositories", async () => {
    const res = await fetch(
      `http://127.0.0.1:${port}/dummy-org/non-existent/info/refs?service=git-upload-pack`
    );
    expect(res.status).toBe(404);
  });

  it("round-trips a branch pushed and fetched over loopback HTTP", async () => {
    const branch = "mc/bridge-roundtrip";
    const writer = createWriter(mcHome, "writer");
    execSync(`git checkout -b ${branch}`, { cwd: writer });

    const url = `http://127.0.0.1:${port}/dummy-org/dummy-repo.git`;
    await runGit(writer, ["push", url, `HEAD:refs/heads/${branch}`]);

    const reader = join(mcHome, "reader");
    mkdirSync(reader);
    execSync("git init", { cwd: reader });
    await runGit(reader, ["fetch", url, `refs/heads/${branch}:refs/remotes/rusa/${branch}`]);

    const pushed = execSync("git rev-parse HEAD", { cwd: writer, encoding: "utf8" }).trim();
    const fetched = execSync(`git rev-parse refs/remotes/rusa/${branch}`, {
      cwd: reader,
      encoding: "utf8",
    }).trim();
    expect(fetched).toBe(pushed);
  });

  it("allows fast-forward pushes to mc branches", async () => {
    const branch = "mc/fast-forward";
    const writer = createWriter(mcHome, "writer-fast-forward");
    const url = `http://127.0.0.1:${port}/dummy-org/dummy-repo.git`;

    await runGit(writer, ["push", url, `HEAD:refs/heads/${branch}`]);
    commitFile(writer, "README.md", "fast forward\n", "fast forward");
    await runGit(writer, ["push", url, `HEAD:refs/heads/${branch}`]);
  }, 15_000);

  it("rejects force pushes that rewrite a ref", async () => {
    const branch = "mc/reject-force";
    const writer = createWriter(mcHome, "writer-reject-force");
    const url = `http://127.0.0.1:${port}/dummy-org/dummy-repo.git`;

    await runGit(writer, ["push", url, `HEAD:refs/heads/${branch}`]);
    commitFile(writer, "README.md", "rewritten\n", "rewritten");
    await runGit(writer, ["push", url, `HEAD:refs/heads/${branch}`]);
    execSync("git reset --hard HEAD~1", { cwd: writer });
    commitFile(writer, "README.md", "alternate history\n", "alternate history");

    const result = await runGitForExit(writer, [
      "push",
      "--force",
      url,
      `HEAD:refs/heads/${branch}`,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("git bridge rejects non-fast-forward update");
  }, 15_000);

  it("rejects ref deletion", async () => {
    const branch = "mc/reject-delete";
    const writer = createWriter(mcHome, "writer-reject-delete");
    const url = `http://127.0.0.1:${port}/dummy-org/dummy-repo.git`;

    await runGit(writer, ["push", url, `HEAD:refs/heads/${branch}`]);

    const result = await runGitForExit(writer, ["push", url, `:refs/heads/${branch}`]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("git bridge rejects ref deletion");
  });

  it.each(["staging", "master"])("rejects pushes to protected trunk branch %s", async (branch) => {
    const writer = createWriter(mcHome, `writer-reject-${branch}`);
    const url = `http://127.0.0.1:${port}/dummy-org/dummy-repo.git`;

    const result = await runGitForExit(writer, ["push", url, `HEAD:refs/heads/${branch}`]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("git bridge rejects writes outside refs/heads/mc/*");
  });

  it("returns 413 when a chunked POST exceeds the body cap", async () => {
    const cappedServer = startGitHttpServer(mcHome, 0, { maxPostBodyBytes: 4 });
    await new Promise<void>((resolve) => {
      cappedServer.once("listening", resolve);
    });
    const addr = cappedServer.address() as AddressInfo;

    try {
      const status = await postChunked(
        new URL(`http://127.0.0.1:${addr.port}/dummy-org/dummy-repo.git/git-receive-pack`),
        ["too ", "large"]
      );
      expect(status).toBe(413);
    } finally {
      await new Promise<void>((resolve) => cappedServer.close(() => resolve()));
    }
  });
});
