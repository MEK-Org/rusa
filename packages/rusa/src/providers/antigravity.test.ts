import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import EventEmitter from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../config/types.js";
import { AntigravityProvider, formatAgyToolInvocation } from "./antigravity.js";
import { clearProviderModelCatalog, setProviderModelCatalog } from "./model-catalog.js";
import {
  RUN_CEILING_ABORT_REASON,
  STALL_WATCHDOG_ABORT_REASON,
} from "./termination-attribution.js";

const { spawnFn, execSyncFn, execFileSyncFn } = vi.hoisted(() => {
  const spawnFn = vi.fn();
  const execSyncFn = vi.fn((command: string) => {
    if (command === "pnpm store path") return "/tmp/pnpm-store/path";
    if (command === "which git") return "/usr/bin/git";
    if (command === "which gh") return "/usr/bin/gh";
    if (command === "which node") return "/usr/local/fnm/node";
    if (command === "which corepack") return "/usr/local/fnm/corepack";
    if (command === "which pnpm") return "/usr/local/fnm/pnpm";
    throw new Error(`Unexpected command: ${command}`);
  });
  const execFileSyncFn = vi.fn((command: string, args: string[]) => {
    if (command === "bwrap" && args[0] === "--version") return "bwrap version";
    throw new Error(`Unexpected execFileSync: ${command} ${args.join(" ")}`);
  });
  return { spawnFn, execSyncFn, execFileSyncFn };
});

vi.mock("node:child_process", () => ({
  spawn: spawnFn,
  execSync: execSyncFn,
  execFileSync: execFileSyncFn,
  default: {
    spawn: spawnFn,
    execSync: execSyncFn,
    execFileSync: execFileSyncFn,
  },
}));

function mockChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("AntigravityProvider", () => {
  beforeEach(() => {
    setProviderModelCatalog("agy", [
      { identifier: "gemini-3.1-pro-high", displayLabel: "Gemini 3.1 Pro (High)", passable: true },
      { identifier: "gemini-3.1-pro-low", displayLabel: "Gemini 3.1 Pro (Low)", passable: true },
      {
        identifier: "gemini-3.5-flash-high",
        displayLabel: "Gemini 3.5 Flash (High)",
        passable: true,
      },
      {
        identifier: "gemini-3.5-flash-low",
        displayLabel: "Gemini 3.5 Flash (Low)",
        passable: true,
      },
    ]);
  });
  afterEach(() => {
    clearProviderModelCatalog("agy");
    vi.clearAllMocks();
  });

  it("runs agy with -p, the model, and --dangerously-skip-permissions", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const provider = new AntigravityProvider("antigravity", config, "Gemini 3.1 Pro (High)");

    const child = mockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

    const runPromise = provider.run({ prompt: "test prompt", cwd: "/tmp" });
    setTimeout(() => child.emit("close", 0), 10);
    const result = await runPromise;

    expect(result.success).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "agy",
      expect.arrayContaining([
        "-p",
        "test prompt",
        "--dangerously-skip-permissions",
        "--model",
        "gemini-3.1-pro",
        "--effort",
        "high",
      ]),
      expect.objectContaining({ cwd: "/tmp" })
    );
  });

  it("rejects a required-effort model before launching agy when effort is missing", async () => {
    setProviderModelCatalog("agy", [
      {
        identifier: "gemini-3.5-flash-high",
        displayLabel: "Gemini 3.5 Flash (High)",
        passable: true,
      },
    ]);
    const provider = new AntigravityProvider(
      "antigravity",
      { cliCommand: "agy" },
      "Gemini 3.5 Flash"
    );

    await expect(provider.run({ prompt: "test prompt", cwd: "/tmp" })).rejects.toThrowError(
      'invalid model selection: model "Gemini 3.5 Flash" requires an effort but none was provided'
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    "Gemini 3.5 Flash (High)",
    "gemini-3.5-flash-high",
  ])("canonicalizes matching tiered selector %s and mixed-case effort before launching agy", async (model) => {
    const provider = new AntigravityProvider(
      "antigravity",
      { cliCommand: "agy" },
      model,
      undefined,
      "HIGH"
    );
    const child = mockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

    const runPromise = provider.run({ prompt: "test prompt", cwd: "/tmp" });
    setTimeout(() => child.emit("close", 0), 10);
    await runPromise;

    const args = vi.mocked(spawn).mock.calls[0][1];
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "gemini-3.5-flash",
    ]);
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "high",
    ]);
  });

  it("rejects mismatched tiered display and explicit effort before launching agy", async () => {
    const provider = new AntigravityProvider(
      "antigravity",
      { cliCommand: "agy" },
      "Gemini 3.5 Flash (High)",
      undefined,
      "low"
    );

    await expect(provider.run({ prompt: "test prompt", cwd: "/tmp" })).rejects.toThrowError(
      'conflicting reasoning efforts for provider "agy": model pin carries "high" but effort is "low"'
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("prefers a catalog-exact suffix-like base display label before legacy parsing", async () => {
    setProviderModelCatalog("agy", [
      {
        identifier: "future-model-v1",
        displayLabel: "Future Model-high",
        passable: true,
      },
    ]);
    const provider = new AntigravityProvider(
      "antigravity",
      { cliCommand: "agy" },
      "Future Model-high"
    );
    const child = mockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

    const runPromise = provider.run({ prompt: "test prompt", cwd: "/tmp" });
    setTimeout(() => child.emit("close", 0), 10);
    await runPromise;

    const args = vi.mocked(spawn).mock.calls[0][1];
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual([
      "--model",
      "future-model-v1",
    ]);
    expect(args).not.toContain("--effort");
  });

  it("rejects a pinned model with an empty catalog before launching agy", async () => {
    clearProviderModelCatalog("agy");
    const provider = new AntigravityProvider(
      "antigravity",
      { cliCommand: "agy" },
      "Gemini 3.5 Flash"
    );

    await expect(provider.run({ prompt: "test prompt", cwd: "/tmp" })).rejects.toThrowError(
      'invalid model selection: model "Gemini 3.5 Flash" provided but agy catalog is empty or missing'
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("launches without a pinned model and normalizes an explicit effort alias", async () => {
    clearProviderModelCatalog("agy");
    const provider = new AntigravityProvider(
      "antigravity",
      { cliCommand: "agy" },
      undefined,
      undefined,
      "Extra-High"
    );
    const child = mockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

    const runPromise = provider.run({ prompt: "test prompt", cwd: "/tmp" });
    setTimeout(() => child.emit("close", 0), 10);
    await runPromise;

    const args = vi.mocked(spawn).mock.calls[0][1];
    expect(args).not.toContain("--model");
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual([
      "--effort",
      "xhigh",
    ]);
  });

  it("runs agy inside bwrap when sandbox options are provided", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const provider = new AntigravityProvider("antigravity", config, "Gemini 3.5 Flash (Low)");

    const child = mockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      sandbox: { worktreePath: "/tmp/test-worktree" },
    });
    setTimeout(() => child.emit("close", 0), 10);
    await runPromise;

    expect(spawn).toHaveBeenCalledWith(
      "bwrap",
      expect.arrayContaining(["--", "agy", "-p", "test prompt", "--dangerously-skip-permissions"]),
      expect.objectContaining({ cwd: "/" })
    );
  });

  it("terminates subprocess and returns cancelled status when signal is aborted", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const provider = new AntigravityProvider("antigravity", config, "Gemini 3.1 Pro (High)");

    const child = mockChildProcess() as unknown as ChildProcessWithoutNullStreams;
    // Assign a fake pid so killGroup can call process.kill(-pid, "SIGKILL")
    (child as unknown as { pid: number }).pid = 99999;
    // Spy on process.kill to verify group-kill is called
    const processKillSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.mocked(spawn).mockReturnValue(child);

    const controller = new AbortController();
    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      signal: controller.signal,
    });

    // Abort the run
    controller.abort();

    // The new kill path: process.kill(-pid, "SIGKILL") on the whole group
    expect(processKillSpy).toHaveBeenCalledWith(-99999, "SIGKILL");

    // Close the process — with group SIGKILL the child arrives with SIGKILL
    child.emit("close", null, "SIGKILL");

    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(143);

    processKillSpy.mockRestore();
  });

  it("reports stall-watchdog attribution when aborted with the stall reason", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const provider = new AntigravityProvider("antigravity", config, "Gemini 3.1 Pro (High)");

    const child = mockChildProcess() as unknown as ChildProcessWithoutNullStreams;
    child.kill = vi.fn() as unknown as typeof child.kill;
    vi.mocked(spawn).mockReturnValue(child);

    const controller = new AbortController();
    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      signal: controller.signal,
    });

    controller.abort(STALL_WATCHDOG_ABORT_REASON);
    child.emit("close", null, "SIGTERM");

    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(143);
    expect(result.output).toContain("[Task killed by stall watchdog (no output for 15 minutes)]");
  });

  it("reports run-ceiling attribution when aborted with the ceiling reason", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const provider = new AntigravityProvider("antigravity", config, "Gemini 3.1 Pro (High)");

    const child = mockChildProcess() as unknown as ChildProcessWithoutNullStreams;
    child.kill = vi.fn() as unknown as typeof child.kill;
    vi.mocked(spawn).mockReturnValue(child);

    const controller = new AbortController();
    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      signal: controller.signal,
    });

    controller.abort(RUN_CEILING_ABORT_REASON);
    child.emit("close", null, "SIGTERM");

    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(143);
    expect(result.output).toContain("[Task killed by run ceiling timeout]");
  });

  it("reports an unattributed SIGTERM for a generic abort", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const provider = new AntigravityProvider("antigravity", config, "Gemini 3.1 Pro (High)");

    const child = mockChildProcess() as unknown as ChildProcessWithoutNullStreams;
    child.kill = vi.fn() as unknown as typeof child.kill;
    vi.mocked(spawn).mockReturnValue(child);

    const controller = new AbortController();
    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      signal: controller.signal,
    });

    controller.abort();
    child.emit("close", null, "SIGTERM");

    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(143);
    expect(result.output).toContain("[Task terminated by SIGTERM (source unattributed)]");
  });

  it("reports an unattributed SIGTERM when SIGTERM arrives without an abort signal", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const provider = new AntigravityProvider("antigravity", config, "Gemini 3.1 Pro (High)");

    const child = mockChildProcess() as unknown as ChildProcessWithoutNullStreams;
    vi.mocked(spawn).mockReturnValue(child);

    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
    });

    child.emit("close", null, "SIGTERM");

    const result = await runPromise;
    expect(result.success).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(143);
    expect(result.output).toContain("[Task terminated by SIGTERM (source unattributed)]");
  });

  it("classifies exit-0 empty-output QUOTA_EXHAUSTED conversation tails as failure", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const conversationId = "11111111-2222-4333-8444-555555555555";
    const cwd = mkdtempSync(join(tmpdir(), "mc-agy-quota-"));
    const conversationsDir = mkdtempSync(join(tmpdir(), "mc-agy-conversations-"));
    const provider = new AntigravityProvider(
      "antigravity",
      config,
      "Gemini 3.1 Pro (High)",
      conversationsDir
    );
    mkdirSync(conversationsDir, { recursive: true });
    writeFileSync(
      join(conversationsDir, `${conversationId}.db-wal`),
      JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "QUOTA_EXHAUSTED",
              metadata: { quotaResetTimeStamp: "2026-07-10T18:31:45Z" },
            },
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "15966.244303936s",
            },
          ],
        },
      })
    );

    try {
      const child = mockChildProcess();
      vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

      const runPromise = provider.run({ prompt: "test prompt", cwd, session: {} });
      const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
      const logFile = args[args.indexOf("--log-file") + 1];
      writeFileSync(logFile, `Print mode: conversation=${conversationId}, sending message`);
      child.emit("close", 0);
      const result = await runPromise;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("reason=QUOTA_EXHAUSTED");
      expect(result.output).toContain("quotaResetTimeStamp=2026-07-10T18:31:45Z");
      expect(result.output).toContain("retryDelay=15966.244303936s");
      expect(result.sessionId).toBe(conversationId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(conversationsDir, { recursive: true, force: true });
    }
  });

  it("classifies exit-0 non-empty-output QUOTA_EXHAUSTED conversation tails as failure", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const conversationId = "22222222-3333-4444-8555-666666666666";
    const cwd = mkdtempSync(join(tmpdir(), "mc-agy-quota-"));
    const conversationsDir = mkdtempSync(join(tmpdir(), "mc-agy-conversations-"));
    const provider = new AntigravityProvider(
      "antigravity",
      config,
      "Gemini 3.1 Pro (High)",
      conversationsDir
    );
    const conversationPath = join(conversationsDir, `${conversationId}.db-wal`);
    writeFileSync(conversationPath, "prior conversation data\n");
    const quotaRecord = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{ reason: "QUOTA_EXHAUSTED" }],
      },
    });

    try {
      const child = mockChildProcess();
      vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

      const runPromise = provider.run({
        prompt: "test prompt",
        cwd,
        session: { id: conversationId },
      });
      const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
      const logFile = args[args.indexOf("--log-file") + 1];
      writeFileSync(logFile, `Print mode: conversation=${conversationId}, sending message`);
      child.stdout.emit("data", "partial output before refusal");
      appendFileSync(conversationPath, quotaRecord);
      child.emit("close", 0);
      const result = await runPromise;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.output).toBe(
        "Antigravity run refused by provider quota: reason=QUOTA_EXHAUSTED"
      );
      expect(result.sessionId).toBe(conversationId);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(conversationsDir, { recursive: true, force: true });
    }
  });

  it("keeps exit-0 non-empty output successful when the conversation has no quota marker", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const conversationId = "33333333-4444-4555-8666-777777777777";
    const cwd = mkdtempSync(join(tmpdir(), "mc-agy-success-"));
    const conversationsDir = mkdtempSync(join(tmpdir(), "mc-agy-conversations-"));
    const provider = new AntigravityProvider(
      "antigravity",
      config,
      "Gemini 3.1 Pro (High)",
      conversationsDir
    );
    writeFileSync(join(conversationsDir, `${conversationId}.db-wal`), "completed normally");

    try {
      const child = mockChildProcess();
      vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

      const runPromise = provider.run({ prompt: "test prompt", cwd, session: {} });
      const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
      const logFile = args[args.indexOf("--log-file") + 1];
      writeFileSync(logFile, `Print mode: conversation=${conversationId}, sending message`);
      child.stdout.emit("data", "completed output");
      child.emit("close", 0);
      const result = await runPromise;

      expect(result).toMatchObject({
        success: true,
        output: "completed output",
        exitCode: 0,
        sessionId: conversationId,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(conversationsDir, { recursive: true, force: true });
    }
  });

  it("ignores a historical quota marker when a resumed run succeeds with output", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const conversationId = "44444444-5555-4666-8777-888888888888";
    const cwd = mkdtempSync(join(tmpdir(), "mc-agy-resume-success-"));
    const conversationsDir = mkdtempSync(join(tmpdir(), "mc-agy-conversations-"));
    const provider = new AntigravityProvider(
      "antigravity",
      config,
      "Gemini 3.1 Pro (High)",
      conversationsDir
    );
    writeFileSync(
      join(conversationsDir, `${conversationId}.db-wal`),
      JSON.stringify({ error: { code: 429, reason: "QUOTA_EXHAUSTED" } })
    );

    try {
      const child = mockChildProcess();
      vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

      const runPromise = provider.run({
        prompt: "test prompt",
        cwd,
        session: { id: conversationId },
      });
      child.stdout.emit("data", "successful resumed output");
      child.emit("close", 0);
      const result = await runPromise;

      expect(result).toMatchObject({
        success: true,
        output: "successful resumed output",
        exitCode: 0,
        sessionId: conversationId,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(conversationsDir, { recursive: true, force: true });
    }
  });

  it("classifies a current quota marker after a resumed conversation record rotates", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const conversationId = "55555555-6666-4777-8888-999999999999";
    const cwd = mkdtempSync(join(tmpdir(), "mc-agy-rotated-quota-"));
    const conversationsDir = mkdtempSync(join(tmpdir(), "mc-agy-conversations-"));
    const conversationPath = join(conversationsDir, `${conversationId}.db-wal`);
    const provider = new AntigravityProvider(
      "antigravity",
      config,
      "Gemini 3.1 Pro (High)",
      conversationsDir
    );
    writeFileSync(conversationPath, "record from an earlier successful run");

    try {
      const child = mockChildProcess();
      vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

      const runPromise = provider.run({
        prompt: "test prompt",
        cwd,
        session: { id: conversationId },
      });
      unlinkSync(conversationPath);
      writeFileSync(
        conversationPath,
        JSON.stringify({ error: { code: 429, reason: "QUOTA_EXHAUSTED" } })
      );
      child.stdout.emit("data", "partial output before refusal");
      child.emit("close", 0);
      const result = await runPromise;

      expect(result).toMatchObject({
        success: false,
        output: "Antigravity run refused by provider quota: reason=QUOTA_EXHAUSTED",
        exitCode: 1,
        sessionId: conversationId,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(conversationsDir, { recursive: true, force: true });
    }
  });

  it("parses stream-json lines and emits incremental tool and text chunks", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const conversationId = "66666666-7777-4888-8999-000000000000";
    const provider = new AntigravityProvider("antigravity", config, "Gemini 3.1 Pro (High)");

    const child = mockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

    const chunks: string[] = [];
    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      onChunk: (c) => chunks.push(c),
    });

    // Simulate agy emitting stream-json events
    child.stdout.emit(
      "data",
      `${JSON.stringify({ event: "init", conversation_id: conversationId })}\n`
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "ACTIVE",
          tool_name: "run_command",
          tool_info: { name: "run_command", parameters: { CommandLine: "ls" } },
        },
      })}\n`
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          state: "DONE",
          tool_name: "run_command",
          tool_info: { output: "file1.txt\nfile2.txt" },
        },
      })}\n`
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "agent_response",
          state: "DONE",
          text_delta: "Found 2 files.",
        },
      })}\n`
    );
    child.stdout.emit(
      "data",
      `${JSON.stringify({
        event: "result",
        result: {
          conversation_id: conversationId,
          status: "SUCCESS",
          response: "Found 2 files.",
        },
      })}\n`
    );

    child.emit("close", 0);
    const result = await runPromise;

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe(conversationId);
    expect(result.output).toBe("Found 2 files.");
    expect(chunks.some((c) => c.includes("[run_command: ls]"))).toBe(true);
    // Raw output is omitted for concise live logging
    expect(chunks.some((c) => c.includes("file1.txt"))).toBe(false);
    expect(chunks.some((c) => c.includes("Found 2 files."))).toBe(true);
  });

  it("handles error status from stream-json result", async () => {
    const config: ProviderConfig = { cliCommand: "agy" };
    const provider = new AntigravityProvider("antigravity", config, "Gemini 3.1 Pro (High)");

    const child = mockChildProcess();
    vi.mocked(spawn).mockReturnValue(child as ChildProcessWithoutNullStreams);

    const chunks: string[] = [];
    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      onChunk: (c) => chunks.push(c),
    });

    child.stdout.emit(
      "data",
      `${JSON.stringify({
        event: "result",
        result: {
          status: "ERROR",
          error: "Model context window exceeded",
        },
      })}\n`
    );

    child.emit("close", 1);
    const result = await runPromise;

    expect(result.success).toBe(false);
    expect(result.output).toBe("Model context window exceeded");
    expect(chunks.some((c) => c.includes("Model context window exceeded"))).toBe(true);
  });
});

describe("formatAgyToolInvocation", () => {
  it("formats MCP tool calls with server, tool, and key arguments", () => {
    const formatted = formatAgyToolInvocation({
      tool_name: "call_mcp_tool",
      tool_info: {
        parameters: {
          ServerName: "mesh",
          ToolName: "send_message",
          Arguments: { recipient: "root", body: "hello" },
        },
      },
    });
    expect(formatted).toBe("\n[MCP mesh:send_message (recipient: root)]\n");
  });

  it("formats MCP tool calls with issue numbers", () => {
    const formatted = formatAgyToolInvocation({
      tool_name: "call_mcp_tool",
      tool_info: {
        parameters: {
          ServerName: "tracker",
          ToolName: "get_issue",
          Arguments: { issue_number: 1552 },
        },
      },
    });
    expect(formatted).toBe("\n[MCP tracker:get_issue (#1552)]\n");
  });

  it("formats run_command with CommandLine", () => {
    const formatted = formatAgyToolInvocation({
      tool_name: "run_command",
      tool_info: {
        parameters: {
          CommandLine: "git status --porcelain",
        },
      },
    });
    expect(formatted).toBe("\n[run_command: git status --porcelain]\n");
  });

  it("formats view_file with AbsolutePath", () => {
    const formatted = formatAgyToolInvocation({
      tool_name: "view_file",
      tool_info: {
        parameters: {
          AbsolutePath: "/path/to/src/index.ts",
        },
      },
    });
    expect(formatted).toBe("\n[view_file: /path/to/src/index.ts]\n");
  });

  it("formats file edit tools with TargetFile and Description", () => {
    const formatted = formatAgyToolInvocation({
      tool_name: "replace_file_content",
      tool_info: {
        parameters: {
          TargetFile: "/path/to/file.ts",
          Description: "Fix circular buffer replay",
        },
      },
    });
    expect(formatted).toBe('\n[edit: /path/to/file.ts — "Fix circular buffer replay"]\n');
  });

  it("formats grep_search with query and search path", () => {
    const formatted = formatAgyToolInvocation({
      tool_name: "grep_search",
      tool_info: {
        parameters: {
          Query: "LiveOutputBuffer",
          SearchPath: "/packages/rusa",
        },
      },
    });
    expect(formatted).toBe('\n[grep_search: "LiveOutputBuffer" in /packages/rusa]\n');
  });
});
