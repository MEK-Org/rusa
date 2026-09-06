/**
 * provider-launch-arguments.test.ts — the launch boundary, with a real spawn.
 *
 * This file does NOT mock `node:child_process`. Every case below drives a
 * provider adapter (or `runSubprocess` itself) against a real fake CLI, so
 * Node's own synchronous argv validation is the thing being satisfied — the
 * validation that used to abort a run before the provider process existed.
 *
 * THE ARBITER:
 *   Delete the `sanitizeArgv(config.args)` call in `subprocess-execution.ts`
 *   and the "reaches the CLI" cases go RED: `spawn` throws
 *   `ERR_INVALID_ARG_VALUE`, `runSubprocess`'s promise rejects, and the run
 *   never produces an argv dump at all.
 *   Replace `toSpawnArgumentError(err)` with the raw `err` and the disclosure
 *   cases go RED: Node's message quotes the rejected value into the run output.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "../actor/worker-prompt.js";
import type { ProviderConfig } from "../config/types.js";
import { AntigravityProvider } from "./antigravity.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { CopilotProvider } from "./copilot.js";
import { KimiProvider } from "./kimi.js";
import { ARGV_NUL_REPLACEMENT } from "./spawn-arguments.js";
import { runSubprocess } from "./subprocess-execution.js";
import type { CodingProvider, RunResult } from "./types.js";

/** Escaped so the byte under test survives an editor, a copy-paste and a diff. */
const NUL = "\u0000";

/**
 * The realistic arrival path from #206: an actor is asked to repair a file that
 * happens to hold a stray NUL, and the byte rides into the next prompt through
 * its charter — i.e. through assembled actor context, not through anything the
 * provider layer authored.
 */
const CHARTER_WITH_NUL = `Repair the header of report.bin, which holds a stray byte here: [${NUL}] — leave the rest of the file alone.`;

/** Recognizable text a run record must never show. Not a real credential. */
const NEVER_DISCLOSE = "fixture-argv-value-must-not-appear";

function assembledActorContext(): string {
  return buildWorkerPrompt(CHARTER_WITH_NUL, {
    threadId: "00000000-0000-4000-8000-00000000dead",
    parentId: "00000000-0000-4000-8000-00000000beef",
    handles: [],
    understandingMountEnabled: false,
  });
}

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  temps.length = 0;
});

/**
 * A fake provider CLI that records the argv it was handed and exits 0. Written
 * as `/bin/sh` exec'ing this run's own node binary, so the shebang stays short
 * and the interpreter is guaranteed to exist wherever the suite runs.
 */
function fakeCliRecordingArgv(): { command: string; readArgv: () => string[]; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), "rusa-launch-argv-"));
  temps.push(dir);
  const dumpPath = join(dir, "argv.json");
  const command = join(dir, "fake-cli.sh");
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      // `--` matters: without it node claims a leading provider flag such as
      // claude's `-p` as one of its own options and exits before running.
      `exec ${JSON.stringify(process.execPath)} -e ${JSON.stringify(
        `require("node:fs").writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(process.argv.slice(1)))`
      )} -- "$@"`,
      "",
    ].join("\n")
  );
  chmodSync(command, 0o755);
  return {
    command,
    cwd: dir,
    readArgv: () => JSON.parse(readFileSync(dumpPath, "utf8")) as string[],
  };
}

const adapters: { name: string; create: (config: ProviderConfig) => CodingProvider }[] = [
  { name: "claude", create: (config) => new ClaudeProvider("claude", config) },
  { name: "codex", create: (config) => new CodexProvider("codex", config) },
  { name: "antigravity", create: (config) => new AntigravityProvider("agy", config) },
  { name: "kimi", create: (config) => new KimiProvider("kimi", config) },
  { name: "copilot", create: (config) => new CopilotProvider("copilot", config) },
];

describe("provider launch boundary — a NUL in assembled actor context", () => {
  it("is a NUL the assembled prompt genuinely carries", () => {
    // Guards the premise of every case below: the byte survives prompt assembly,
    // so the launch boundary is the only thing standing between it and spawn.
    expect(assembledActorContext()).toContain(NUL);
  });

  for (const adapter of adapters) {
    it(`reaches the ${adapter.name} CLI as U+FFFD instead of aborting the launch`, async () => {
      const cli = fakeCliRecordingArgv();
      const provider = adapter.create({ cliCommand: cli.command });

      const result = await provider.run({
        prompt: assembledActorContext(),
        cwd: cli.cwd,
        timeoutMs: 30_000,
      });

      // The launch happened at all — the pre-fix behavior was a rejected
      // promise from `spawn`, with no process and no argv dump.
      expect(result.exitCode).toBe(0);

      const argv = cli.readArgv();
      const joined = argv.join("\n");
      expect(joined).not.toContain(NUL);
      // Replacement, not truncation: the surrounding charter arrives intact.
      expect(joined).toContain(`stray byte here: [${ARGV_NUL_REPLACEMENT}]`);
      expect(joined).toContain("leave the rest of the file alone");
    });
  }
});

describe("provider launch boundary — synchronous spawn rejection", () => {
  /** A command Node's own argv validation refuses, standing in for any such rejection. */
  const unspawnableCommand = `/bin/echo${NUL}`;

  it("settles as a named run error and runs the adapter's cleanup", async () => {
    let cleanedUp = false;
    let spawnError: Error | undefined;

    const result = await runSubprocess({
      command: unspawnableCommand,
      args: ["--prompt", `assembled context ${NEVER_DISCLOSE}`],
      cwd: tmpdir(),
      timeoutMs: 30_000,
      cleanup: () => {
        cleanedUp = true;
      },
      buildKilledResult: () => ({ success: false, output: "killed", exitCode: 143 }),
      buildSignalResult: () => ({ success: false, output: "signal", exitCode: 143 }),
      buildExitResult: (output, exitCode) => ({ success: exitCode === 0, output, exitCode }),
      buildSpawnErrorResult: (err) => {
        spawnError = err;
        return { success: false, output: `Failed to spawn: ${err.message}`, exitCode: 1 };
      },
    });

    // A rejected promise here is what used to reach the actor's terminal-failure
    // path and become a bare exit 1 carrying the raw stack.
    expect(result.success).toBe(false);
    expect(spawnError?.name).toBe("SpawnArgumentError");
    expect(result.output).toContain("TypeError [ERR_INVALID_ARG_VALUE]");
    expect(result.output).not.toContain(NEVER_DISCLOSE);
    // Temp MCP configs and sandbox scratch paths are the adapter's to remove,
    // and nothing else will settle this run.
    expect(cleanedUp).toBe(true);
  });

  it("gives a provider run an actionable, non-disclosing classification", async () => {
    const provider = new ClaudeProvider("claude", { cliCommand: unspawnableCommand });

    const result: RunResult = await provider.run({
      prompt: `${assembledActorContext()}\n${NEVER_DISCLOSE}`,
      cwd: tmpdir(),
      timeoutMs: 30_000,
    });

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Failed to spawn claude");
    expect(result.output).toContain("ERR_INVALID_ARG_VALUE");
    expect(result.output).not.toContain(NEVER_DISCLOSE);
    expect(result.output).not.toContain("Repair the header of report.bin");
  });
});
