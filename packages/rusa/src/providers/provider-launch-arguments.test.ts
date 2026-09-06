/**
 * provider-launch-arguments.test.ts — the launch boundary, with a real spawn.
 *
 * This file does NOT mock `node:child_process`. Every case below drives a
 * provider adapter (or `runSubprocess` itself) against a real fake CLI, so
 * Node's own synchronous argv validation is the thing being satisfied — the
 * validation that used to abort a run before the provider process existed.
 *
 * The sandboxed cases COMPOSE the production pieces a sandboxed launch is made
 * of — the adapter's own argument builder, then `buildActorBwrapCommand`, then
 * `runSubprocess` — instead of stubbing the sandbox module. Only the operand
 * *construction* is left out, because building real operands mounts host
 * directories and copies credentials; everything that decides what is an
 * operand and what is provider argv stays the production code. A fake `bwrap`
 * records the vector bubblewrap would have received and execs whatever follows
 * `--`, so both halves are inspected as spawned.
 *
 * THE ARBITER:
 *   Drop `sanitizeArgvText(prompt)` from an adapter and that adapter's "reaches
 *   the CLI" case goes RED: `spawn` throws `ERR_INVALID_ARG_VALUE`, the run
 *   settles as a spawn failure, and no argv dump is ever written.
 *   Sanitize the whole argv vector inside `runSubprocess` instead and the "does
 *   not rewrite" cases go RED: under `bwrap` the provider executable and the
 *   wrapper's path operands live in that vector, so a NUL in one is rewritten to
 *   U+FFFD and *launched* — a different path — instead of being reported.
 *   Hand `buildSpawnErrorResult` the raw throw and the classification cases go
 *   RED. The one that carries the DISCLOSURE half is the last case: Node quotes
 *   the offending argv element, so only a case whose sensitive text shares an
 *   element with the NUL can catch the leak — a rejected command is quoted
 *   alone, and argv never appears beside it.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkerPrompt } from "../actor/worker-prompt.js";
import type { ProviderConfig } from "../config/types.js";
import { AntigravityProvider } from "./antigravity.js";
import { buildClaudeArgs, ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { CopilotProvider } from "./copilot.js";
import { KimiProvider } from "./kimi.js";
import { buildActorBwrapCommand } from "./sandbox.js";
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
 * Separates the recorded arguments below: ASCII RS, which no prompt carries,
 * unlike the newlines an assembled charter is full of.
 */
const ARGV_RECORD_SEPARATOR = "\u001e";

/** The argv a recorder was handed, or `undefined` when it never ran at all. */
function readArgvDump(dumpPath: string): string[] | undefined {
  if (!existsSync(dumpPath)) return undefined;
  // Every record is terminated rather than separated, so the split leaves one
  // trailing empty entry to drop.
  return readFileSync(dumpPath, "utf8").split(ARGV_RECORD_SEPARATOR).slice(0, -1);
}

/** Write an executable `/bin/sh` recorder that dumps its argv, then runs `rest`. */
function writeArgvRecorder(script: string, dumpPath: string, rest: string[]): void {
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      // Octal in the format string, since only the format is escape-processed —
      // an argument is written through %s exactly as it arrived.
      `for a in "$@"; do printf '%s\\036' "$a"; done > ${JSON.stringify(dumpPath)}`,
      ...rest,
      "",
    ].join("\n")
  );
  chmodSync(script, 0o755);
}

/**
 * A fake provider CLI that records the argv it was handed and exits 0. Plain
 * `/bin/sh`, no interpreter to boot: several of these run per suite pass, and
 * the only thing they have to do is echo their arguments back byte for byte.
 */
function fakeCliRecordingArgv(): {
  command: string;
  readArgv: () => string[] | undefined;
  cwd: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "rusa-launch-argv-"));
  temps.push(dir);
  const dumpPath = join(dir, "argv.txt");
  const command = join(dir, "fake-cli.sh");
  writeArgvRecorder(command, dumpPath, []);
  return { command, cwd: dir, readArgv: () => readArgvDump(dumpPath) };
}

/**
 * A fake `bwrap`: it records the whole wrapped vector and then execs the command
 * after `--`, so a sandboxed launch reaches the provider CLI for real without
 * bubblewrap (or its privileges) having to be available. Spawned by absolute
 * path, so nothing about the test process's PATH changes.
 */
function fakeBwrap(): { command: string; readArgv: () => string[] | undefined } {
  const dir = mkdtempSync(join(tmpdir(), "rusa-launch-bwrap-"));
  temps.push(dir);
  const dumpPath = join(dir, "bwrap-argv.txt");
  const command = join(dir, "bwrap");
  writeArgvRecorder(command, dumpPath, [
    "while [ $# -gt 0 ]; do",
    '  arg="$1"; shift',
    '  if [ "$arg" = "--" ]; then exec "$@"; fi',
    "done",
    // Handed no `--` at all: nothing to run, and the dump above still records
    // what arrived, which is what the assertions read.
    "exit 64",
  ]);
  return { command, readArgv: () => readArgvDump(dumpPath) };
}

/** Path-bearing bwrap operands of the shape a real sandboxed launch carries. */
function bwrapOperandsFor(dir: string): string[] {
  return ["--unshare-all", "--ro-bind", "/", "/", "--bind", dir, dir, "--chdir", dir];
}

/**
 * Launch a wrapped vector the way a sandboxed provider run does: `bwrap` as the
 * command, a cwd of `/`, and the whole wrapper + provider vector as argv.
 */
function runWrapped(bwrapCommand: string, args: string[]): Promise<RunResult> {
  return runSubprocess({
    command: bwrapCommand,
    args,
    cwd: "/",
    timeoutMs: 30_000,
    buildKilledResult: () => ({ success: false, output: "killed", exitCode: 143 }),
    buildSignalResult: () => ({ success: false, output: "signal", exitCode: 143 }),
    buildExitResult: (output, exitCode) => ({ success: exitCode === 0, output, exitCode }),
    buildSpawnErrorResult: (err) => ({
      success: false,
      output: `Failed to spawn: ${err.message}`,
      exitCode: 1,
    }),
  });
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

      // The launch happened at all — the pre-fix behavior was a spawn failure,
      // with no process and no argv dump.
      expect(result.exitCode).toBe(0);

      const joined = (cli.readArgv() ?? []).join("\n");
      expect(joined).not.toContain(NUL);
      // Replacement, not truncation: the surrounding charter arrives intact.
      expect(joined).toContain(`stray byte here: [${ARGV_NUL_REPLACEMENT}]`);
      expect(joined).toContain("leave the rest of the file alone");
    });
  }

  it("reaches a sandboxed CLI as U+FFFD, through untouched bwrap operands", async () => {
    const cli = fakeCliRecordingArgv();
    const bwrap = fakeBwrap();
    const operands = bwrapOperandsFor(cli.cwd);
    // Exactly what a sandboxed run spawns: the adapter's arguments, wrapped by
    // the production wrapper builder. Sanitizing where the prompt enters argv is
    // what makes this vector identical to the unsandboxed one above.
    const wrappedArgs = buildActorBwrapCommand(
      { args: operands, commandPrefix: [], tempPaths: [] },
      cli.command,
      buildClaudeArgs({ prompt: assembledActorContext() })
    );

    const result = await runWrapped(bwrap.command, wrappedArgs);
    expect(result.exitCode).toBe(0);

    // Sandboxing moves the provider executable and a set of host paths INTO
    // argv. They are operands, not text: bubblewrap must receive them byte for
    // byte, or it binds and chdirs somewhere else and execs another file.
    const wrapped = bwrap.readArgv() ?? [];
    const separator = wrapped.indexOf("--");
    expect(wrapped.slice(0, separator)).toEqual(operands);
    expect(wrapped[separator + 1]).toBe(cli.command);

    // The provider's own arguments — the assembled text — are the sanitized half.
    const joined = (cli.readArgv() ?? []).join("\n");
    expect(joined).not.toContain(NUL);
    expect(joined).toContain(`stray byte here: [${ARGV_NUL_REPLACEMENT}]`);
    expect(joined).toContain("leave the rest of the file alone");
  });
});

describe("provider launch boundary — a NUL in a configured path", () => {
  it("does not rewrite a sandboxed provider executable into a different path", async () => {
    const cli = fakeCliRecordingArgv();
    const bwrap = fakeBwrap();
    // A configured command is not assembled text. Replacing the byte would name
    // a path that is not the configured one, and under bwrap that path sits in
    // argv, so the substitution would be *launched* rather than reported.
    const wrappedArgs = buildActorBwrapCommand(
      { args: bwrapOperandsFor(cli.cwd), commandPrefix: [], tempPaths: [] },
      `${cli.command}${NUL}`,
      buildClaudeArgs({ prompt: `${assembledActorContext()}\n${NEVER_DISCLOSE}` })
    );

    const result = await runWrapped(bwrap.command, wrappedArgs);

    // Nothing ran at all: no wrapper, and so no substituted path either.
    expect(bwrap.readArgv()).toBeUndefined();
    expect(cli.readArgv()).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.output).toContain("ERR_INVALID_ARG_VALUE");
    expect(result.output).not.toContain(NEVER_DISCLOSE);
  });

  it("does not rewrite a sandboxed bwrap path operand", async () => {
    const cli = fakeCliRecordingArgv();
    const bwrap = fakeBwrap();
    // The same fault in a host path the wrapper binds: also configuration, also
    // not something to repair by substituting a character into it.
    const wrappedArgs = buildActorBwrapCommand(
      { args: ["--unshare-all", "--chdir", `${cli.cwd}${NUL}`], commandPrefix: [], tempPaths: [] },
      cli.command,
      buildClaudeArgs({ prompt: `${assembledActorContext()}\n${NEVER_DISCLOSE}` })
    );

    const result = await runWrapped(bwrap.command, wrappedArgs);

    expect(bwrap.readArgv()).toBeUndefined();
    expect(cli.readArgv()).toBeUndefined();
    expect(result.success).toBe(false);
    expect(result.output).toContain("ERR_INVALID_ARG_VALUE");
    expect(result.output).not.toContain(NEVER_DISCLOSE);
  });
});

describe("provider launch boundary — synchronous spawn rejection", () => {
  /** A command Node's own argv validation refuses, standing in for any such rejection. */
  const unspawnableCommand = `/bin/echo${NUL}`;

  it("settles as a classified run error and runs the adapter's cleanup", async () => {
    let cleanedUp = false;

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
      buildSpawnErrorResult: (err) => ({
        success: false,
        output: `Failed to spawn: ${err.message}`,
        exitCode: 1,
      }),
    });

    // A throw from `spawn` here is what used to reach the actor's
    // terminal-failure path and become a bare exit 1 carrying the raw stack.
    expect(result.success).toBe(false);
    expect(result.output).toContain("TypeError [ERR_INVALID_ARG_VALUE]");
    expect(result.output).toContain("before the CLI started");
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
  /**
   * The shape Node actually discloses, and the only one that can hold this
   * assertion up. A rejected *command* is quoted on its own — the argv array
   * never appears in the message — so the guards above would still pass on the
   * raw throw. Node quotes the offending argv ELEMENT, so proving the
   * conversion earns its place means putting the sensitive text and the NUL in
   * one element: exactly the shape an unsanitized prompt arrives in.
   */
  it("withholds the rejected argv element, which Node quotes into its message", async () => {
    const result = await runSubprocess({
      // Spawnable on its own: the rejection has to come from the argv element
      // below, so that element is what Node's message would quote.
      command: "/bin/echo",
      args: ["-p", `${NEVER_DISCLOSE} assembled charter tail${NUL}`],
      cwd: tmpdir(),
      timeoutMs: 30_000,
      buildKilledResult: () => ({ success: false, output: "killed", exitCode: 143 }),
      buildSignalResult: () => ({ success: false, output: "signal", exitCode: 143 }),
      buildExitResult: (output, exitCode) => ({ success: exitCode === 0, output, exitCode }),
      buildSpawnErrorResult: (err) => ({
        success: false,
        output: `Failed to spawn: ${err.message}`,
        exitCode: 1,
      }),
    });

    expect(result.success).toBe(false);
    // Asserted BEFORE the classification, so this is the assertion that fails
    // on the raw throw rather than being masked by one that fails earlier.
    // Node's own message is `... must be a string without null bytes. Received
    // '<the element, up to 128 inspected characters>'`.
    expect(result.output).not.toContain(NEVER_DISCLOSE);
    expect(result.output).toContain("TypeError [ERR_INVALID_ARG_VALUE]");
  });
});
