import type { ChildProcessWithoutNullStreams } from "node:child_process";
import EventEmitter from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexProvider } from "./codex.js";
import { classifyRunExhaustion, deterministicExhaustionFallback } from "./exhaustion-classifier.js";
import type { SubprocessRunConfig } from "./subprocess-execution.js";
import type { RunOptions } from "./types.js";

const harness = vi.hoisted(() => ({
  spawn: vi.fn(),
  capturedBytes: [] as number[],
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, spawn: harness.spawn, default: { ...actual, spawn: harness.spawn } };
});
vi.mock("./sandbox.js", async (original) => ({
  ...(await original<typeof import("./sandbox.js")>()),
  codexRolloutStoreDir: (path: string) => join(path, "fixture-sessions"),
  buildActorBwrapArgs: () => ({ args: [], commandPrefix: [], tempPaths: [] }),
  buildActorBwrapCommand: (_wrapper: unknown, _command: string, args: string[]) => args,
  teardownFlutterOverlay: () => {},
}));
// Observe the actual adapter's capture array after each event, while retaining
// the real subprocess timeout/abort/close lifecycle.
vi.mock("./subprocess-execution.js", async (original) => {
  const actual = await original<typeof import("./subprocess-execution.js")>();
  return {
    ...actual,
    runSubprocess(config: SubprocessRunConfig) {
      const observe =
        (handle: NonNullable<SubprocessRunConfig["handleStdoutData"]>) =>
        (data: Buffer, chunks: string[]) => {
          handle(data, chunks);
          harness.capturedBytes.push(Buffer.byteLength(chunks.join("")));
        };
      return actual.runSubprocess({
        ...config,
        handleStdoutData: config.handleStdoutData && observe(config.handleStdoutData),
        handleStderrData: config.handleStderrData && observe(config.handleStderrData),
      });
    },
  };
});

const BUDGET = 64 * 1024;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const assistant = (text: string) =>
  line({
    type: "item.completed",
    item: { type: "agent_message", text },
  });
const telemetry = line({
  type: "item.completed",
  item: { type: "local_shell_call_output", output: "x".repeat(4 * BUDGET), exit_code: 0 },
});

function start(options: Pick<RunOptions, "sandbox" | "session" | "timeoutMs"> = {}) {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  harness.spawn.mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  const controller = new AbortController();
  const raw: string[] = [];
  const prompt = "exact synthetic prompt 🦊\nsecond line";
  const result = new CodexProvider("codex", { cliCommand: "codex" }).run({
    ...options,
    prompt,
    cwd: "/tmp",
    signal: controller.signal,
    onStdout: (text) => raw.push(text),
  });
  return { child, controller, result, raw, prompt };
}

function assertTail(output: string, input: string) {
  const marker = output.match(/\[Codex raw diagnostics: (\d+) UTF-8 bytes omitted; tail\]\n/);
  expect(marker).not.toBeNull();
  const omitted = Number(marker?.[1]);
  const expected = Buffer.from(input).subarray(omitted).toString("utf8");
  expect(output).toContain(`${marker?.[0]}${expected}`);
  expect(Buffer.byteLength(expected)).toBeLessThanOrEqual(BUDGET);
  expect(Buffer.byteLength(expected) + omitted).toBe(Buffer.byteLength(input));
  expect(expected).not.toContain("�");
  expect(Math.max(...harness.capturedBytes)).toBeLessThanOrEqual(BUDGET);
}

describe("Codex bounded raw diagnostics (#883)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    harness.capturedBytes.length = 0;
  });

  it("bounds one giant chunk during capture and keeps parsed text on interrupted completion", async () => {
    const run = start();
    // Last complete JSON object deliberately has no newline: termination must
    // flush the parser before choosing semantic output.
    const input = telemetry + assistant("exact final 🦊").trimEnd();
    run.child.stdout.emit("data", Buffer.from(input));
    run.controller.abort("interrupt:fixture-operator");
    const result = await run.result;
    expect(result.output.startsWith("exact final 🦊\n")).toBe(true);
    assertTail(result.output, input);
    expect(result).toMatchObject({
      success: false,
      exitCode: 143,
      cancelled: true,
      interrupted: true,
      interruptSource: "fixture-operator",
      abortReason: "interrupt:fixture-operator",
    });
    expect(result.output).toContain("[Task interrupted by fixture-operator]");
    expect(run.raw.join("")).toBe(input);
  });

  it.each([
    "quota",
    "transient-network",
  ] as const)("retains evicted %s facts on interrupted raw fallback and exact omitted bytes", async (classification) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = start();
      const marker =
        classification === "quota" ? "quota exhausted" : "quota exhausted\nconnection timed out";
      const input = `${marker}\n${"z".repeat(3 * BUDGET)}\nfixture quota refusal\n`;
      expect(deterministicExhaustionFallback(input)).toBe(classification);
      run.child.stderr.emit("data", Buffer.from(input));
      run.controller.abort("stall-watchdog");
      const result = await run.result;
      assertTail(result.output, input);
      expect(result.output).toContain("fixture quota refusal");
      expect(deterministicExhaustionFallback(result.output)).toBe(classification);
      expect(await classifyRunExhaustion(result)).toEqual({
        exhausted: classification === "quota",
      });
      expect(result).toMatchObject({
        abortReason: "stall-watchdog",
        cancelled: true,
        exitCode: 143,
      });
      expect(result.output).toContain("[Task killed by stall watchdog");
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    { path: "exit", omitted: 196429, tail: "" },
    { path: "interrupt", omitted: 150000, tail: "\nretry after an hour if the limit holds\n" },
  ])("keeps the omitted-byte count out of deterministic classification ($path)", async ({
    path,
    omitted,
    tail,
  }) => {
    // Neither stream contains "429" or "5"; only the count would add them.
    const run = start();
    const input = "y".repeat(omitted + BUDGET - tail.length) + tail;
    expect(deterministicExhaustionFallback(input)).toBe("unknown");
    run.child.stderr.emit("data", Buffer.from(input));
    if (path === "exit") run.child.emit("close", 1);
    else run.controller.abort("interrupt:fixture-operator");
    const result = await run.result;
    expect(result.output).toContain(
      `[Codex raw diagnostics: ${omitted} UTF-8 bytes omitted; tail]`
    );
    assertTail(result.output, input);
    expect(deterministicExhaustionFallback(result.output)).toBe("unknown");
    expect(await classifyRunExhaustion(result)).toEqual({ exhausted: false });
  });

  it("preserves normal semantic output larger than the diagnostic budget and exact prompt", async () => {
    const run = start();
    const text = "semantic 🦊\n".repeat(BUDGET / 4);
    const input = telemetry + assistant(text);
    run.child.stdout.emit("data", Buffer.from(input));
    run.child.emit("close", 0);
    expect(await run.result).toMatchObject({ success: true, exitCode: 0, output: text });
    expect(harness.spawn.mock.calls[0]?.[1]).toContain(run.prompt);
    expect(run.raw.join("")).toBe(input);
    expect(Math.max(...harness.capturedBytes)).toBeLessThanOrEqual(BUDGET);
  });

  it("handles split UTF-8 parser input and evicts complete characters across many chunks", async () => {
    const run = start();
    const input = `${telemetry + assistant("complete 🦊 text") + "🙂".repeat(BUDGET)}!`;
    const bytes = Buffer.from(input);
    // Split inside the assistant's four-byte code point, then use uneven tails.
    const split = bytes.indexOf(Buffer.from("🦊")) + 2;
    run.child.stdout.emit("data", bytes.subarray(0, split));
    for (let offset = split; offset < bytes.length; offset += 7001) {
      run.child.stdout.emit("data", bytes.subarray(offset, offset + 7001));
    }
    run.controller.abort("run-ceiling");
    const result = await run.result;
    expect(result.output.startsWith("complete 🦊 text\n")).toBe(true);
    assertTail(result.output, input);
    expect(result.abortReason).toBe("run-ceiling");
    expect(result.output).toContain("[Task killed by run ceiling timeout]");
    // The extra ASCII byte puts the eviction boundary inside a four-byte
    // character: three more bytes must be omitted, never replaced by U+FFFD.
    expect(result.output).toContain(`${"🙂".repeat((BUDGET - 4) / 4)}!`);
  });

  it("preserves sandbox session/model capture on interrupted resume without a retry", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "rusa-codex-diagnostic-fixture-"));
    const id = "00000000-1111-2222-3333-444444444444";
    try {
      mkdirSync(join(scratch, "fixture-sessions"));
      writeFileSync(
        join(scratch, "fixture-sessions", `rollout-${id}.jsonl`),
        line({ type: "session_meta", payload: { id } }) +
          line({ type: "turn_context", payload: { model: "fixture-model" } })
      );
      const run = start({ sandbox: { worktreePath: scratch }, session: { id } });
      run.child.stdout.emit("data", Buffer.from(telemetry + assistant("saved partial")));
      run.controller.abort("interrupt:fixture-operator");
      expect(await run.result).toMatchObject({
        sessionId: id,
        model: "fixture-model",
        cancelled: true,
        exitCode: 143,
        abortReason: "interrupt:fixture-operator",
      });
      expect(harness.spawn).toHaveBeenCalledTimes(1);
      expect(harness.spawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["resume", id]));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("keeps the subprocess timer's existing unattributed termination semantics", async () => {
    vi.useFakeTimers();
    const run = start({ timeoutMs: 25 });
    const input = telemetry + assistant("before deadline");
    run.child.stdout.emit("data", Buffer.from(input));
    await vi.advanceTimersByTimeAsync(25);
    const result = await run.result;
    expect(result.output.startsWith("before deadline\n")).toBe(true);
    assertTail(result.output, input);
    // A bare subprocess timeout has no controller reason; preserve that fact.
    expect(result).toMatchObject({ cancelled: true, exitCode: 143, abortReason: "unknown" });
    expect(result.output).toContain("[Task terminated by SIGTERM (source unattributed)]");
  });

  it("keeps external signal attribution and labels even untruncated interrupted diagnostics", async () => {
    const run = start();
    const input = assistant("partial answer");
    run.child.stdout.emit("data", Buffer.from(input));
    run.child.emit("close", null, "SIGTERM");
    const result = await run.result;
    expect(result.output.startsWith("partial answer\n")).toBe(true);
    assertTail(result.output, input);
    expect(result).toMatchObject({
      success: false,
      cancelled: true,
      exitCode: 143,
      abortReason: "unknown",
    });
    expect(result.output).toContain("[Task terminated by SIGTERM (source unattributed)]");
  });

  it("leaves small normal failure output unchanged and bounds large fallback output", async () => {
    const small = start();
    small.child.stderr.emit("data", Buffer.from("fixture auth failure"));
    small.child.emit("close", 1);
    expect((await small.result).output).toBe("fixture auth failure");
    const large = start();
    const input = `${telemetry}fixture final failure\n`;
    large.child.stdout.emit("data", Buffer.from(input));
    large.child.emit("close", 1);
    const result = await large.result;
    assertTail(result.output, input);
    expect(result.success).toBe(false);
  });
});
