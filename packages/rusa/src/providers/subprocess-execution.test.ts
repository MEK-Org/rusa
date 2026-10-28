import type { ChildProcessWithoutNullStreams } from "node:child_process";
import EventEmitter from "node:events";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSubprocess, type SubprocessDuplex } from "./subprocess-execution.js";
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
  stdin = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    destroyed: false,
    write: vi.fn((_record: string, callback: (error?: Error) => void) => callback()),
  });
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

  it("closes duplex stdin on cancellation and detaches the abort listener", async () => {
    const mockChild = new MockChild();
    spawnFn.mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const onDuplex = vi.fn();
    const run = runSubprocess({ ...baseConfig, signal: controller.signal, onDuplex });
    mockChild.emit("spawn");
    const transport = onDuplex.mock.calls[0][0];
    await transport.write("request\n");
    expect(mockChild.stdin.write).toHaveBeenCalledWith("request\n", expect.any(Function));
    controller.abort(RUN_CEILING_ABORT_REASON);
    expect((await run).abortReason).toBe(RUN_CEILING_ABORT_REASON);
    expect(mockChild.stdin.destroy).toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    let closed = false;
    const closing = transport.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    mockChild.emit("close", null, "SIGKILL");
    await closing;
    expect(closed).toBe(true);
    killSpy.mockClear();
    await transport.close();
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
  });

  it("waits for write callbacks and preserves exit diagnostics after EPIPE", async () => {
    const mockChild = new MockChild();
    spawnFn.mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);
    let writeCallback: ((error?: Error) => void) | undefined;
    mockChild.stdin.write.mockImplementation((_record, callback) => {
      writeCallback = callback;
    });
    let transport!: SubprocessDuplex;
    const run = runSubprocess({
      ...baseConfig,
      onDuplex: (value) => {
        transport = value;
      },
    });
    let settled = false;
    void run.then(() => {
      settled = true;
    });
    mockChild.emit("spawn");
    let written = false;
    const writing = transport.write("request\n").then(() => {
      written = true;
    });
    await Promise.resolve();
    expect(written).toBe(false);
    expect(writeCallback).toBeTypeOf("function");
    writeCallback?.();
    await writing;
    expect(written).toBe(true);

    const rejected = expect(transport.write("next\n")).rejects.toThrow(/^Subprocess stdin failed$/);
    const pipeError = Object.assign(new Error("private request contents"), { code: "EPIPE" });
    writeCallback?.(pipeError);
    mockChild.stderr.emit("data", Buffer.from("peer diagnostic"));
    mockChild.stdin.emit("error", pipeError);
    await rejected;
    expect(settled).toBe(false);
    expect(killSpy).not.toHaveBeenCalled();
    mockChild.emit("close", 2, null);
    expect(await run).toMatchObject({ success: false, exitCode: 2, output: "peer diagnostic" });
  });

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
    expect(result.abortReason).toBe("unknown");
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
    expect(result.abortReason).toBe(RUN_CEILING_ABORT_REASON);
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
    expect(result.abortReason).toBe(STALL_WATCHDOG_ABORT_REASON);
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

  it("flushes onStdoutEnd before formatting termination on abort", async () => {
    const mockChild = new MockChild();
    spawnFn.mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const controller = new AbortController();
    let buffered = "trailing unterminated text";

    const runPromise = runSubprocess({
      ...baseConfig,
      signal: controller.signal,
      onStdoutEnd: (chunks) => {
        if (buffered) {
          chunks.push(buffered);
          buffered = "";
        }
      },
    });

    controller.abort(STALL_WATCHDOG_ABORT_REASON);

    const result = await runPromise;
    expect(result.output).toContain("trailing unterminated text");
    expect(result.output).toContain("stall watchdog");
  });

  it("flushes onStdoutEnd before formatting termination on SIGTERM close", async () => {
    const mockChild = new MockChild();
    spawnFn.mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    let buffered = "trailing error diagnostic";

    const runPromise = runSubprocess({
      ...baseConfig,
      onStdoutEnd: (chunks) => {
        if (buffered) {
          chunks.push(buffered);
          buffered = "";
        }
      },
    });

    mockChild.emit("close", null, "SIGTERM");

    const result = await runPromise;
    expect(result.output).toContain("trailing error diagnostic");
    expect(result.output).toContain("unattributed");
    expect(result.abortReason).toBe("unknown");
  });

  it("flushes onStdoutEnd before formatting termination on timeout", async () => {
    vi.useFakeTimers();
    const mockChild = new MockChild();
    spawnFn.mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    let buffered = "buffered output before timeout";

    const runPromise = runSubprocess({
      ...baseConfig,
      timeoutMs: 50,
      onStdoutEnd: (chunks) => {
        if (buffered) {
          chunks.push(buffered);
          buffered = "";
        }
      },
    });

    vi.advanceTimersByTime(50);

    const result = await runPromise;
    expect(result.output).toContain("buffered output before timeout");
    expect(result.output).toContain("unattributed");
    expect(result.abortReason).toBe("unknown");
  });

  it("automatically merges abortReason from sigtermResult into settled RunResult even if builder omits it", async () => {
    const mockChild = new MockChild();
    spawnFn.mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const controller = new AbortController();
    controller.abort(STALL_WATCHDOG_ABORT_REASON);

    const result = await runSubprocess({
      ...baseConfig,
      signal: controller.signal,
      buildKilledResult: (sigtermResult) => ({
        success: false,
        output: sigtermResult.output,
        exitCode: sigtermResult.exitCode,
        // Intentionally omit abortReason
      }),
    });

    expect(result.abortReason).toBe(STALL_WATCHDOG_ABORT_REASON);
  });
});

describe("runSubprocess termination evidence (#1119)", () => {
  beforeEach(() => {
    vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const config = {
    command: "mock-command",
    args: [],
    cwd: "/mock-cwd",
    timeoutMs: 1000,
    buildKilledResult: (attribution: TerminationAttribution) => ({
      success: false,
      output: attribution.output,
      exitCode: attribution.exitCode,
    }),
    buildSignalResult: (attribution: TerminationAttribution) => ({
      success: false,
      output: attribution.output,
      exitCode: attribution.exitCode,
    }),
    buildExitResult: (output: string, exitCode: number) => ({
      success: exitCode === 0,
      output,
      exitCode,
    }),
    buildSpawnErrorResult: (err: Error) => ({ success: false, output: err.message, exitCode: -1 }),
  };
  const spawned = () => {
    const child = new MockChild();
    spawnFn.mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
    return child;
  };

  it("is observed only when the direct child's close settles the run", async () => {
    const exited = spawned();
    const exit = runSubprocess(config);
    exited.emit("close", 3, null);
    expect(await exit).toMatchObject({ exitCode: 3, termination: "observed" });

    const signalled = spawned();
    const signal = runSubprocess(config);
    signalled.emit("close", null, "SIGSEGV");
    expect((await signal).termination).toBe("observed");
  });

  it("is unproven on timeout, even when close follows the settled run", async () => {
    vi.useFakeTimers();
    const child = spawned();
    const run = runSubprocess({ ...config, timeoutMs: 50 });
    vi.advanceTimersByTime(50);
    child.emit("close", null, "SIGKILL");
    expect((await run).termination).toBe("unproven");
  });

  it("is unproven on abort", async () => {
    const child = spawned();
    const controller = new AbortController();
    const run = runSubprocess({ ...config, signal: controller.signal });
    controller.abort(RUN_CEILING_ABORT_REASON);
    child.emit("close", null, "SIGKILL");
    expect((await run).termination).toBe("unproven");
  });

  it("is unproven on a child error event and on a spawn that throws", async () => {
    const child = spawned();
    const errored = runSubprocess(config);
    child.emit("error", new Error("ENOENT"));
    expect((await errored).termination).toBe("unproven");

    spawnFn.mockImplementationOnce(() => {
      throw new Error("spawn EAGAIN");
    });
    expect((await runSubprocess(config)).termination).toBe("unproven");
  });
});
