import type { ChildProcessWithoutNullStreams } from "node:child_process";
import EventEmitter from "node:events";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSubprocess } from "./subprocess-execution.js";
import {
  RUN_CEILING_ABORT_REASON,
  STALL_WATCHDOG_ABORT_REASON,
  type TerminationAttribution,
} from "./termination-attribution.js";

const { spawnFn } = vi.hoisted(() => {
  const spawnFn = vi.fn();
  return { spawnFn };
});

vi.mock("node:child_process", () => ({
  spawn: spawnFn,
  default: {
    spawn: spawnFn,
  },
}));

class MockChild extends EventEmitter {
  pid = 12345;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe("runSubprocess helper-level unit coverage ", () => {
  let killSpy: MockInstance<typeof process.kill>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const baseConfig = {
    command: "mock-command",
    args: ["--arg1"],
    cwd: "/mock-cwd",
    timeoutMs: 1000,
    buildKilledResult: (sigtermResult: TerminationAttribution) => ({
      success: false,
      cancelled: sigtermResult.cancelled,
      output: sigtermResult.output,
      exitCode: sigtermResult.exitCode,
    }),
    buildSignalResult: (sigtermResult: TerminationAttribution, signal: string) => ({
      success: false,
      cancelled: sigtermResult.cancelled,
      output: `${sigtermResult.output} (signal: ${signal})`,
      exitCode: sigtermResult.exitCode,
    }),
    buildExitResult: (output: string, exitCode: number) => ({
      success: exitCode === 0,
      cancelled: false,
      output,
      exitCode,
    }),
    buildSpawnErrorResult: (err: Error) => ({
      success: false,
      cancelled: false,
      output: `Spawn error: ${err.message}`,
      exitCode: -1,
    }),
  };

  it("handles timeout fire -> group teardown", async () => {
    vi.useFakeTimers();
    const mockChild = new MockChild();
    spawnFn.mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const runPromise = runSubprocess({
      ...baseConfig,
      timeoutMs: 50,
    });

    vi.advanceTimersByTime(50);

    const result = await runPromise;

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(143);
    expect(result.output).toContain("unattributed");
  });

  it("handles already-aborted cancellation -> immediate settlement and teardown", async () => {
    const mockChild = new MockChild();
    spawnFn.mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const controller = new AbortController();
    controller.abort(RUN_CEILING_ABORT_REASON);

    const result = await runSubprocess({
      ...baseConfig,
      signal: controller.signal,
    });

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(143);
    expect(result.output).toContain("run ceiling");
  });

  it("handles abort firing before first output -> teardown and cancellation", async () => {
    const mockChild = new MockChild();
    spawnFn.mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const controller = new AbortController();

    const runPromise = runSubprocess({
      ...baseConfig,
      signal: controller.signal,
    });

    // Abort with stall watchdog reason before any output
    controller.abort(STALL_WATCHDOG_ABORT_REASON);

    const result = await runPromise;

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(143);
    expect(result.output).toContain("stall watchdog");
  });

  it("handles spawn error event -> teardown and shaped error result", async () => {
    const mockChild = new MockChild();
    spawnFn.mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const runPromise = runSubprocess(baseConfig);

    const testError = new Error("ENOENT: command not found");
    mockChild.emit("error", testError);

    const result = await runPromise;

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.exitCode).toBe(-1);
    expect(result.output).toBe("Spawn error: ENOENT: command not found");
  });
});
