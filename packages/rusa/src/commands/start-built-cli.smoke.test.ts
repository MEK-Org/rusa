import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const smokeRoots: string[] = [];
const BUILD_TIMEOUT_MS = 20_000;
const READY_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5_000;
// The worst path is a full build and ready wait, an unresponsive graceful
// shutdown, then forced reaping. Keep five seconds beyond those phase bounds
// so Vitest does not preempt the helper's diagnostic output or cleanup.
const TEST_TIMEOUT_MS = BUILD_TIMEOUT_MS + READY_TIMEOUT_MS + EXIT_TIMEOUT_MS * 2 + 5_000;

function waitForExit(child: ChildProcess, timeoutMs: number) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`built CLI did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  try {
    const { code, signal } = await waitForExit(child, BUILD_TIMEOUT_MS);
    if (code !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed (code=${code}, signal=${signal})\n${output}`
      );
    }
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child, EXIT_TIMEOUT_MS).catch(() => {});
    }
  }
}

function waitForReady(child: ChildProcess, output: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`built CLI did not become ready\n--- built CLI output ---\n${output()}`));
    }, READY_TIMEOUT_MS);
    const onOutput = () => {
      if (output().includes("✓ Root actor live. Waiting for events...")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `built CLI exited before readiness (code=${code}, signal=${signal})\n--- built CLI output ---\n${output()}`
        )
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("built-cli-output", onOutput);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.on("built-cli-output", onOutput);
    child.once("exit", onExit);
    child.once("error", onError);
    onOutput();
  });
}

afterEach(() => {
  for (const root of smokeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// CI must always exercise the shipped artifact; the opt-out only helps a local
// developer whose toolchain cannot currently run this bounded smoke.
const builtCliSmoke =
  process.env.CI || process.env.RUSA_SKIP_BUILT_CLI_SMOKE !== "1" ? it : it.skip;

describe("built CLI startup", () => {
  builtCliSmoke(
    "loads a Codex effort pin and reaches readiness without config_load_failed",
    async () => {
      const packageRoot = process.cwd();
      // Keep the temporary dist below the package so the built ESM can resolve
      // its declared dependencies through this checkout's node_modules.
      const root = mkdtempSync(join(packageRoot, ".built-cli-config-"));
      smokeRoots.push(root);
      const home = join(root, "home");
      const bin = join(root, "bin");
      const dist = join(root, "dist");
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(home, "config.yaml"),
        [
          "github:",
          "  account: built-cli-smoke",
          "providers:",
          "  codex:",
          "    cliCommand: codex",
          "rootActor:",
          "  provider: codex",
          "  model: gpt-5.6-sol",
          "  effort: high",
          "sandbox: container-boundary",
          "webhook:",
          "  port: 0",
          "  secret: fixture-webhook-value",
          "dashboard:",
          "  port: 0",
          "observability:",
          "  logging:",
          "    level: info",
          "",
        ].join("\n"),
        "utf8"
      );
      writeFileSync(
        join(home, "models_cache.json"),
        JSON.stringify({
          fetched_at: new Date().toISOString(),
          client_version: "0.0.0",
          models: [{ slug: "gpt-5.6-sol", visibility: "list" }],
        }),
        "utf8"
      );
      // The real start path schedules a Codex model probe after readiness. Keep
      // this fixture entirely local; the matching cache means it never drives
      // the interactive model picker, and the local shim only attributes it.
      const codex = join(bin, "codex");
      writeFileSync(codex, '#!/bin/sh\n[ "$1" = "--version" ] && echo "codex-cli 0.0.0"\nexit 0\n');
      chmodSync(codex, 0o755);

      // The child receives only fixture paths and PATH; unlike a process.env
      // spread, this cannot expose runner credentials to the built CLI.
      const env: NodeJS.ProcessEnv = {
        CODEX_HOME: home,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUSA_DIST_DIR: dist,
        RUSA_HOME: home,
      };
      await run("pnpm", ["exec", "tsup", "--silent"], packageRoot, env);

      const child = spawn(process.execPath, [join(dist, "cli.js"), "start"], {
        cwd: packageRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const capture = (chunk: Buffer) => {
        output += chunk.toString();
        child.emit("built-cli-output");
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);

      try {
        await waitForReady(child, () => output);
        expect(output).not.toContain("config_load_failed");
        expect(output.split(/\r?\n/).find((line) => line.includes("Root actor live"))).toContain(
          "✓ Root actor live. Waiting for events..."
        );

        child.kill("SIGTERM");
        await expect(waitForExit(child, EXIT_TIMEOUT_MS)).resolves.toEqual({
          code: 0,
          signal: null,
        });
      } finally {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
          await waitForExit(child, EXIT_TIMEOUT_MS).catch(() => {});
        }
      }
    },
    TEST_TIMEOUT_MS
  );
});
