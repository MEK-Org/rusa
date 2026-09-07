import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { FollowerHub } from "./follower-hub.js";
import { waitUntil } from "./harness.js";

beforeAll(() => {
  execFileSync("pnpm", ["run", "build:follower"], {
    cwd: process.cwd(),
    stdio: "pipe",
    timeout: 30_000,
  });
}, 35_000);

it("registers a separate follower process that hosts both actors itself", async () => {
  const home = mkdtempSync(join(tmpdir(), "rusa-follower-process-"));
  const token = randomBytes(32).toString("hex");
  const tokenFile = join(home, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const hub = new FollowerHub(token);
  const origin = await hub.listen("127.0.0.1", 0);
  const child = spawn(
    process.execPath,
    [
      resolve("build/follower/follower.js"),
      "--leader",
      origin,
      "--id",
      "test",
      "--home",
      home,
      "--token-file",
      tokenFile,
      "--sandbox",
      "none",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  const exited = once(child, "exit");
  let logs = "";
  child.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  child.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  try {
    await waitUntil(() => hub.list().length === 1);
    expect(hub.list()[0].pid).toBe(child.pid);
    expect(child.pid).not.toBe(process.pid);
    const a = hub.createHost("test", "a");
    const b = hub.createHost("test", "b");
    for (const [id, channel] of [
      ["a", a],
      ["b", b],
    ] as const) {
      const ready = once(channel, "message");
      channel.send(
        {
          type: "init",
          bootstrap: {
            id,
            cwd: "/ignored-leader-path",
            providerOptions: { name: "fake", providers: { fake: { type: "fake" } } },
          },
        },
        (error) => {
          if (error) throw error;
        }
      );
      expect((await ready)[0]).toEqual({ type: "ready", pid: child.pid });
    }
    const retired = once(a, "exit");
    a.send({ type: "stop" }, (error) => {
      if (error) throw error;
    });
    await retired;
    expect(hub.list()[0].actors).toEqual(["b"]);
    expect(b.connected).toBe(true);
    expect(child.exitCode).toBeNull();
    // Instance loss disconnects every remaining actor channel, never another process.
    const bClosed = once(b, "exit");
    child.kill("SIGTERM");
    await exited;
    await bClosed;
    expect(hub.list()).toEqual([]);
  } catch (error) {
    throw new Error(`${String(error)}\nFollower logs: ${logs}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    await hub.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
