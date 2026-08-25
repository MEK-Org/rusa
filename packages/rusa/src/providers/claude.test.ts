import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import EventEmitter from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../config/types.js";
import { ClaudeProvider } from "./claude.js";
import { SANDBOX_MCP_CONFIG_PATH } from "./sandbox.js";

const { spawnFn, execSyncFn, execFileSyncFn } = vi.hoisted(() => {
  const spawnFn = vi.fn();
  const execSyncFn = vi.fn((command: string) => {
    if (command === "pnpm store path") return "/tmp/pnpm-store/path";
    if (command === "which git") return "/usr/bin/git";
    if (command === "which node") return "/usr/local/fnm/node";
    if (command === "which corepack") return "/usr/local/fnm/corepack";
    if (command === "which pnpm") return "/usr/local/fnm/pnpm";
    throw new Error(`Unexpected command: ${command}`);
  });
  const execFileSyncFn = vi.fn((command: string, args: string[]) => {
    if (command === "bwrap" && args[0] === "--version") return "bwrap version";
    if (command === "which" && args[0] === "claude") return "/usr/local/bin/claude";
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

describe("ClaudeProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ISSUE_NUM: worker fallback machinery is removed outright — the ClaudeProvider
  // no longer accepts a fallback model, and its built argv must never carry
  // --fallback-model.
  it("never emits --fallback-model on the spawned claude argv ", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config, "claude-opus-4-8");

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const runPromise = provider.run({ prompt: "hi", cwd: "/tmp" });
    mockChild.emit("close", 0);
    await runPromise;

    const argv = vi.mocked(spawn).mock.calls[0]?.[1] as string[];
    expect(argv).not.toContain("--fallback-model");
  });

  it("parses stream-json and calls onChunk with extracted text", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config, "claude-3-5-sonnet");

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const onChunk = vi.fn();
    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      onChunk,
    });

    // Simulate JSON data events
    const event1 = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
      },
    });
    const event2 = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: " world" },
      },
    });

    mockChild.stdout.emit("data", Buffer.from(`${event1}\n${event2}\n`));

    // Simulate successful completion
    mockChild.emit("close", 0);

    const result = await runPromise;

    expect(onChunk).toHaveBeenCalledTimes(2);
    expect(onChunk).toHaveBeenNthCalledWith(1, "Hello");
    expect(onChunk).toHaveBeenNthCalledWith(2, " world");
    expect(result.output).toBe("Hello world");
  });

  it("handles thinking_delta in stream-json", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config);

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const onChunk = vi.fn();
    const runPromise = provider.run({
      prompt: "test",
      cwd: "/tmp",
      onChunk,
    });

    const event = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Thinking..." },
      },
    });

    mockChild.stdout.emit("data", Buffer.from(`${event}\n`));
    mockChild.emit("close", 0);

    await runPromise;
    expect(onChunk).toHaveBeenCalledWith("Thinking...");
  });

  it("handles tool_use in stream-json", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config);

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const onChunk = vi.fn();
    const runPromise = provider.run({
      prompt: "test",
      cwd: "/tmp",
      onChunk,
    });

    const event = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "Bash" },
      },
    });

    mockChild.stdout.emit("data", Buffer.from(`${event}\n`));
    mockChild.emit("close", 0);

    await runPromise;
    expect(onChunk).toHaveBeenCalledWith("\n[Executing Bash...]\n");
  });

  it("handles tool results in stream-json", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config);

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const onChunk = vi.fn();
    const runPromise = provider.run({
      prompt: "test",
      cwd: "/tmp",
      onChunk,
    });

    const event = JSON.stringify({
      type: "user",
      tool_use_result: { stdout: "output line 1\noutput line 2" },
    });

    mockChild.stdout.emit("data", Buffer.from(`${event}\n`));
    mockChild.emit("close", 0);

    await runPromise;
    expect(onChunk).toHaveBeenCalledWith("\n[Tool Result]:\noutput line 1\noutput line 2\n");
  });

  // ISSUE_NUM — arbiter: an empty tool_result must still reset the stall timer.
  // The fix is that opts.onChunk is called unconditionally when tool_use_result
  // arrives, BEFORE the text-content guard.  This test drives the real adapter
  // with a stream containing a tool_use_result whose stdout AND stderr are both
  // absent/empty, and asserts onChunk was still called.
  //
  // Arbiter check: revert the `opts.onChunk?.("")` line in claude.ts and this
  // test goes RED — onChunk is never called and the assertion fails.
  it("empty tool_use_result still calls onChunk for stall-timer liveness ", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config);

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const onChunk = vi.fn();
    const runPromise = provider.run({
      prompt: "test",
      cwd: "/tmp",
      onChunk,
    });

    // A tool_use_result with no stdout and no stderr — exactly the shape produced
    // by a backgrounded command at the 120s harness timeout, or by any quiet
    // mutation (sed -i, mv, mkdir, grep -q, ...).
    const event = JSON.stringify({
      type: "user",
      tool_use_result: { stdout: "", stderr: "" },
    });

    mockChild.stdout.emit("data", Buffer.from(`${event}\n`));
    mockChild.emit("close", 0);

    await runPromise;

    // onChunk MUST have been called at least once — the empty-string liveness
    // ping — even though there is no text content to log.  Without the fix,
    // onChunk is never called for this event shape, and the stall timer never
    // resets.
    expect(onChunk).toHaveBeenCalled();
    // The liveness ping is an empty string (not logged, just a reset signal).
    expect(onChunk).toHaveBeenCalledWith("");
    // Nothing should have been pushed to chunks for an empty result.
    expect(onChunk).not.toHaveBeenCalledWith(expect.stringContaining("[Tool Result]"));
  });

  it("handles partial JSON lines correctly", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config);

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const onChunk = vi.fn();
    const runPromise = provider.run({
      prompt: "test",
      cwd: "/tmp",
      onChunk,
    });

    const event = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Partial" },
      },
    });

    const mid = Math.floor(event.length / 2);
    const chunk1 = event.substring(0, mid);
    const chunk2 = `${event.substring(mid)}\n`;

    mockChild.stdout.emit("data", Buffer.from(chunk1));
    expect(onChunk).not.toHaveBeenCalled();

    mockChild.stdout.emit("data", Buffer.from(chunk2));
    expect(onChunk).toHaveBeenCalledWith("Partial");

    mockChild.emit("close", 0);
    await runPromise;
  });

  it("handles input_json_delta in stream-json", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config);

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const onChunk = vi.fn();
    const runPromise = provider.run({
      prompt: "test",
      cwd: "/tmp",
      onChunk,
    });

    const event = JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"arg": "val"}' },
      },
    });

    mockChild.stdout.emit("data", Buffer.from(`${event}\n`));
    mockChild.emit("close", 0);

    await runPromise;
    expect(onChunk).toHaveBeenCalledWith('{"arg": "val"}');
  });

  it("handles result with fallback in stream-json", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config);

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const onChunk = vi.fn();
    const runPromise = provider.run({
      prompt: "test",
      cwd: "/tmp",
      onChunk,
    });

    const event = JSON.stringify({
      type: "result",
      result: "Final output",
    });

    mockChild.stdout.emit("data", Buffer.from(`${event}\n`));
    mockChild.emit("close", 0);

    const result = await runPromise;
    expect(onChunk).toHaveBeenCalledWith("Final output");
    expect(result.output).toBe("Final output");
  });

  it("handles result with error in stream-json", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config);

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const onChunk = vi.fn();
    const runPromise = provider.run({
      prompt: "test",
      cwd: "/tmp",
      onChunk,
    });

    const event = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Something went wrong",
    });

    mockChild.stdout.emit("data", Buffer.from(`${event}\n`));
    mockChild.emit("close", 0);

    const result = await runPromise;
    expect(onChunk).toHaveBeenCalledWith("\n[Error]: Something went wrong\n");
    expect(result.output).toBe("\n[Error]: Something went wrong\n");
  });

  it("runs claude inside bwrap sandbox when sandbox options are provided", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config, "claude-sonnet-4-6");

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      sandbox: {
        worktreePath: "/tmp/test-worktree",
      },
    });

    setTimeout(() => {
      mockChild.emit("close", 0);
    }, 10);

    await runPromise;

    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      "bwrap",
      expect.arrayContaining(["--", "/usr/local/bin/claude", "-p", "test prompt"]),
      expect.objectContaining({ cwd: "/" })
    );
  });

  // ISSUE_NUM worker→worker isolation invariant: a sandboxed worker's --mcp-config
  // carries its endpoint token = its identity, so no SIBLING actor may read it.
  // The SOURCE must sit on host /tmp (shadowed from every sibling by their own
  // `--tmpfs /tmp`) and be ro-bound into the owning sandbox at the fixed
  // SANDBOX_MCP_CONFIG_PATH. This test locks the invariant: a regression to the
  // worktree (which is NOT under /tmp and so IS sibling-readable) fails CI.
  it("sandboxed: mcp-config source on host /tmp, ro-bound to the fixed path (NOT the worktree)", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config, "claude-sonnet-4-6");
    const worktree = mkdtempSync(join(tmpdir(), "claude-sandbox-wt-"));

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();

    // Inspect the spawned argv at spawn time (source file is cleaned up post-run).
    let mcpArg: string | undefined;
    let bindSource: string | undefined;
    let bindPresent = false;
    let sourceContent: string | undefined;
    vi.mocked(spawn).mockImplementation((_cmd, argv) => {
      const args = argv as string[];
      const i = args.indexOf("--mcp-config");
      mcpArg = i > -1 ? args[i + 1] : undefined;
      for (let j = 0; j < args.length - 2; j++) {
        if (args[j] === "--ro-bind" && args[j + 2] === SANDBOX_MCP_CONFIG_PATH) {
          bindPresent = true;
          bindSource = args[j + 1];
        }
      }
      if (bindSource) sourceContent = readFileSync(bindSource, "utf-8");
      return mockChild as unknown as ChildProcessWithoutNullStreams;
    });

    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: worktree,
      sandbox: { worktreePath: worktree },
      mcpServers: [{ name: "understanding", url: "http://127.0.0.1:5555/mcp/secret-token" }],
    });
    setTimeout(() => mockChild.emit("close", 0), 10);
    await runPromise;

    // --mcp-config points at the FIXED in-sandbox path, not the host source.
    expect(mcpArg).toBe(SANDBOX_MCP_CONFIG_PATH);
    // The bwrap args ro-bind the host source onto that fixed path…
    expect(bindPresent).toBe(true);
    // …and the source sits on host /tmp (sibling-shadowed), NOT in the worktree.
    expect(bindSource).toBeDefined();
    expect(dirname(bindSource as string)).toBe(tmpdir());
    expect((bindSource as string).startsWith(worktree)).toBe(false);
    // The token-bearing URL really was in the file delivered to claude.
    expect(JSON.parse(sourceContent as string).mcpServers.understanding.url).toContain(
      "/mcp/secret-token"
    );

    rmSync(worktree, { recursive: true, force: true });
  });

  it("writes --mcp-config under tmpdir when NOT sandboxed (root)", async () => {
    const config: ProviderConfig = { cliCommand: "claude" };
    const provider = new ClaudeProvider("claude", config, "claude-sonnet-4-6");

    const mockChild = new EventEmitter() as unknown as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();

    let configPath: string | undefined;
    vi.mocked(spawn).mockImplementation((_cmd, argv) => {
      const args = argv as string[];
      const i = args.indexOf("--mcp-config");
      if (i > -1) configPath = args[i + 1];
      return mockChild as unknown as ChildProcessWithoutNullStreams;
    });

    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      mcpServers: [{ name: "tracker", url: "http://127.0.0.1:5555/mcp/root-token" }],
    });
    setTimeout(() => mockChild.emit("close", 0), 10);
    await runPromise;

    expect(configPath).toBeDefined();
    expect(dirname(configPath as string)).toBe(tmpdir());
  });
});
