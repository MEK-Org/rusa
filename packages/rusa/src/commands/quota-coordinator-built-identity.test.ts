import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

function request(socketPath: string, path: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(JSON.parse(body).service.loadedRevision);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error("identity request timed out")));
    req.on("error", reject);
    req.end();
  });
}

function ready(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => finish(new Error(`coordinator startup timed out: ${output}`)),
      10000
    );
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Quota coordinator ready and listening for requests")) finish();
    };
    const exited = (code: number | null) =>
      finish(new Error(`coordinator exited ${code}: ${output}`));
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", capture);
      child.stderr?.off("data", capture);
      child.off("exit", exited);
      child.off("error", finish);
      if (error) reject(error);
      else resolve();
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.once("exit", exited);
    child.once("error", finish);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`coordinator shutdown: ${code}/${signal}`));
    });
  });
  child.kill("SIGTERM");
  await exit;
}

it("reports the shipped build from the default path and keeps startup identity immutable", async () => {
  const packageRoot = process.cwd();
  // Build beneath the package for dependency resolution; sockets need a short path.
  const root = mkdtempSync(join(packageRoot, ".coordinator-identity-"));
  const home = mkdtempSync(join(tmpdir(), "rusa-identity-"));
  const dist = join(root, "dist");
  const socket = join(home, "coordinator.sock");
  const sha = "2".repeat(40);
  const replacement = "3".repeat(40);
  let child: ChildProcess | undefined;
  // Fixture homes isolate catalog/auth reads. No inherited credentials or provider probes.
  const env = { PATH: process.env.PATH, HOME: home, RUSA_HOME: home, RUSA_DIST_DIR: dist };
  try {
    writeFileSync(
      join(home, "config.yaml"),
      [
        "github:",
        "  account: synthetic-coordinator",
        "rootActor:",
        "  provider: claude",
        "  model: synthetic-model",
        "providers:",
        "  claude:",
        "    cliCommand: synthetic-cli",
        "quota:",
        "  coordinator:",
        `    databasePath: ${join(home, "quota.db")}`,
        `    socketPath: ${socket}`,
        `    backupDir: ${join(home, "backups")}`,
        "",
      ].join("\n")
    );
    execFileSync(
      process.execPath,
      [join(packageRoot, "node_modules/tsup/dist/cli-default.js"), "--silent"],
      { cwd: packageRoot, env, timeout: 20000 }
    );
    // A decoy outside dist must never supply the loaded identity.
    writeFileSync(join(root, ".build-ok"), `${replacement}\n`);
    for (const sentinel of [sha, null, "malformed"]) {
      if (sentinel === null) rmSync(join(dist, ".build-ok"), { force: true });
      else writeFileSync(join(dist, ".build-ok"), `${sentinel}\n`);
      child = spawn(process.execPath, [join(dist, "cli.js"), "quota-coordinator", "--probe-off"], {
        cwd: home,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await ready(child);
      const expected = sentinel === sha ? sha : null;
      for (const endpoint of ["/v1/healthz", "/v1/readyz"]) {
        expect(await request(socket, endpoint)).toBe(expected);
      }
      writeFileSync(join(dist, ".build-ok"), `${replacement}\n`);
      for (const endpoint of ["/v1/healthz", "/v1/readyz"]) {
        expect(await request(socket, endpoint)).toBe(expected);
      }
      await stop(child);
      child = undefined;
    }
  } finally {
    if (child) await stop(child);
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 60000);
