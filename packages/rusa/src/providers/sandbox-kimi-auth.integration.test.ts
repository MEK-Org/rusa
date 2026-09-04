import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildActorBwrapArgs, kimiSessionStoreDir, teardownFlutterOverlay } from "./sandbox.js";

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

describe.skipIf(!BWRAP_CAPABLE)("Kimi shared credential bind (real bwrap)", () => {
  const originalHome = process.env.HOME;
  let actorDir: string;
  let fixtureHome: string;
  let hostCredsDir: string;
  let hostOauthDir: string;

  beforeEach(() => {
    fixtureHome = mkdtempSync(join(tmpdir(), "kimi-auth-home-"));
    process.env.HOME = fixtureHome;
    hostCredsDir = join(fixtureHome, ".kimi-code", "credentials");
    hostOauthDir = join(fixtureHome, ".kimi-code", "oauth");
    mkdirSync(hostCredsDir, { recursive: true });
    mkdirSync(hostOauthDir, { recursive: true });
    // Synthetic fixtures only — structurally like kimi's real files, no real secrets.
    writeFileSync(join(hostCredsDir, "kimi-code.json"), '{"accessToken":"synthetic-before"}', {
      mode: 0o600,
    });
    writeFileSync(join(hostOauthDir, "kimi-code"), "", { mode: 0o600 });
    actorDir = mkdtempSync(join(tmpdir(), "kimi-auth-actor-"));
  });

  afterEach(() => {
    rmSync(kimiSessionStoreDir(actorDir), { recursive: true, force: true });
    teardownFlutterOverlay(actorDir);
    rmSync(actorDir, { recursive: true, force: true });
    rmSync(fixtureHome, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("persists a sandbox rename-over write of credentials/kimi-code.json to the host file", () => {
    const hostCredsFile = join(hostCredsDir, "kimi-code.json");

    const { args } = buildActorBwrapArgs(actorDir, "kimi");
    // Mirror kimi's own write path: tmp file in the same dir, then rename over the target —
    // this is exactly what a single-file bind cannot survive (rename replaces the bind target's
    // directory entry), which is why credentials/ must be a directory bind.
    execFileSync(
      "bwrap",
      [
        ...args,
        "--",
        "/bin/sh",
        "-c",
        'printf %s \'{"accessToken":"synthetic-after"}\' > /tmp/kimi-home/credentials/kimi-code.json.tmp && mv /tmp/kimi-home/credentials/kimi-code.json.tmp /tmp/kimi-home/credentials/kimi-code.json',
      ],
      { stdio: "pipe" }
    );

    const hostContent = readFileSync(hostCredsFile, "utf8");
    expect(JSON.parse(hostContent)).toEqual({ accessToken: "synthetic-after" });
  });

  it("leaves the host with one structurally valid credentials file after two concurrent rename-over writes", async () => {
    const hostCredsFile = join(hostCredsDir, "kimi-code.json");

    const argsA = buildActorBwrapArgs(actorDir, "kimi").args;
    const actorDirB = mkdtempSync(join(tmpdir(), "kimi-auth-actor-b-"));
    try {
      const argsB = buildActorBwrapArgs(actorDirB, "kimi").args;

      // Each bwrap invocation gets its own PID namespace, so "$$" is the same value (e.g. 2)
      // in both sandboxes even though they run concurrently — over the shared host-bound
      // credentials dir that collides both writers onto one temp filename. Use a label unique
      // per writer (plus the loop index) instead, so the two writers never touch the same temp
      // path while still racing real, simultaneous rename-over writes to the same target file.
      const runRenameOver = (args: string[], payload: string, label: string) =>
        execFileAsync("bwrap", [
          ...args,
          "--",
          "/bin/sh",
          "-c",
          `for i in $(seq 1 50); do printf %s '${payload}' > /tmp/kimi-home/credentials/kimi-code.json.tmp.${label}.$i && mv /tmp/kimi-home/credentials/kimi-code.json.tmp.${label}.$i /tmp/kimi-home/credentials/kimi-code.json; done`,
        ]);

      await Promise.all([
        runRenameOver(argsA, '{"accessToken":"synthetic-writer-a"}', "a"),
        runRenameOver(argsB, '{"accessToken":"synthetic-writer-b"}', "b"),
      ]);

      const hostContent = readFileSync(hostCredsFile, "utf8");
      const parsed = JSON.parse(hostContent); // throws if the concurrent renames tore/corrupted the file
      expect(["synthetic-writer-a", "synthetic-writer-b"]).toContain(parsed.accessToken);
    } finally {
      rmSync(kimiSessionStoreDir(actorDirB), { recursive: true, force: true });
      teardownFlutterOverlay(actorDirB);
      rmSync(actorDirB, { recursive: true, force: true });
    }
  });

  it("binds oauth/ as a real writable directory so kimi's own mkdir-based refresh lock can be created and released across concurrent actors", async () => {
    const argsA = buildActorBwrapArgs(actorDir, "kimi").args;
    const actorDirB = mkdtempSync(join(tmpdir(), "kimi-auth-actor-b-"));
    try {
      const argsB = buildActorBwrapArgs(actorDirB, "kimi").args;
      const lockPath = "/tmp/kimi-home/oauth/kimi-code.lock";

      // Mirrors the mutual-exclusion primitive kimi's bundled OAuthManager relies on
      // (proper-lockfile: mkdir is atomic, so exactly one concurrent mkdir wins) — this does
      // not add a lock of rusa's own, it proves the directory bind lets the CLI's own lock work
      // the same way across two sandboxed actors as it would across two host processes.
      const contend = (args: string[]) =>
        execFileAsync("bwrap", [
          ...args,
          "--",
          "/bin/sh",
          "-c",
          `for i in $(seq 1 200); do
             if mkdir ${lockPath} 2>/dev/null; then
               echo held >> /tmp/kimi-home/oauth/winners
               rmdir ${lockPath}
               exit 0
             fi
             sleep 0.01
           done
           exit 1`,
        ]);

      await expect(Promise.all([contend(argsA), contend(argsB)])).resolves.toBeDefined();

      const winners = readFileSync(join(hostOauthDir, "winners"), "utf8").trim().split("\n");
      // Both actors eventually acquired-and-released the same real lock path; if the bind
      // exposed two separate directories instead of one shared host dir, both would race to
      // "win" simultaneously with no contention at all, which this can't distinguish from a
      // false pass — the load-bearing assertion is that the winners file (itself only writable
      // once a real mkdir into the shared host dir succeeded) exists at all.
      expect(winners.length).toBe(2);
      expect(existsSync(join(hostOauthDir, "kimi-code.lock"))).toBe(false);
    } finally {
      rmSync(kimiSessionStoreDir(actorDirB), { recursive: true, force: true });
      teardownFlutterOverlay(actorDirB);
      rmSync(actorDirB, { recursive: true, force: true });
    }
  });
});
