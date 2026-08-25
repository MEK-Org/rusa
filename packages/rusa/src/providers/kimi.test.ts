import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import EventEmitter from "node:events";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../config/types.js";
import { buildKimiMcpConfig, KimiProvider, kimiMcpConfigPath, mergeKimiMcpConfig } from "./kimi.js";
import { SANDBOX_KIMI_MCP_CONFIG_PATH } from "./sandbox.js";

const { spawnFn, execSyncFn, execFileSyncFn } = vi.hoisted(() => {
  const spawnFn = vi.fn();
  const execSyncFn = vi.fn((command: string) => {
    if (command === "which git") return "/usr/bin/git";
    if (command === "pnpm store path") return "/tmp/pnpm-store/path";
    if (command === "which node") return "/usr/local/fnm/node";
    if (command === "which corepack") return "/usr/local/fnm/corepack";
    if (command === "which pnpm") return "/usr/local/fnm/pnpm";
    throw new Error(`Unexpected command: ${command}`);
  });
  const execFileSyncFn = vi.fn((command: string, args: string[]) => {
    if (command === "bwrap" && args[0] === "--version") return "bwrap version";
    if (command === "which" && args[0] === "kimi") return "/usr/local/bin/kimi";
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

/** Helper: build a mock child process that optionally emits data then closes. */
function makeMockChild(opts?: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
}): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();

  const delayMs = opts?.delayMs ?? 10;
  const exitCode = opts?.exitCode ?? 0;
  setTimeout(() => {
    if (opts?.stdout) child.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts?.stderr) child.stderr.emit("data", Buffer.from(opts.stderr));
    child.emit("close", exitCode, null);
  }, delayMs);

  return child;
}

/** Sample stream-json output with both an assistant and a meta line. */
const STREAM_JSON_WITH_META = [
  '{"role":"assistant","content":"KIMI_SJ_OK"}\n',
  '{"role":"meta","type":"session.resume_hint","session_id":"session_6c2ad3ad-abcd-1234-ef56-000000000001","command":"kimi -r session_6c2ad3ad-abcd-1234-ef56-000000000001","content":"To resume this session: kimi -r session_6c2ad3ad-abcd-1234-ef56-000000000001"}\n',
].join("");

/** Sample stream-json output with only an assistant line (no meta / no session hint). */
const STREAM_JSON_NO_META = '{"role":"assistant","content":"Hello from kimi"}\n';

describe("KimiProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─── 1. Exact arg construction ──────────────────────────────────────────────

  describe("MCP config", () => {
    it("emits Kimi's HTTP mcpServers map keyed by name", () => {
      const json = buildKimiMcpConfig([
        { name: "tracker", url: "http://127.0.0.1:9099/mcp/tracker" },
        { name: "mesh", url: "http://127.0.0.1:9099/mcp/mesh" },
      ]);

      expect(JSON.parse(json)).toEqual({
        mcpServers: {
          tracker: { url: "http://127.0.0.1:9099/mcp/tracker" },
          mesh: { url: "http://127.0.0.1:9099/mcp/mesh" },
        },
      });
    });

    it("merges unsandboxed root servers into Kimi's discovery config", async () => {
      const kimiCodeHome = mkdtempSync(join(tmpdir(), "kimi-root-mcp-"));
      const configPath = join(kimiCodeHome, "mcp.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: { user: { url: "http://keep" } },
          other: true,
        })
      );
      const previousKimiCodeHome = process.env.KIMI_CODE_HOME;
      process.env.KIMI_CODE_HOME = kimiCodeHome;

      let configDuringSpawn: Record<string, unknown> | undefined;
      vi.mocked(spawn).mockImplementation(() => {
        configDuringSpawn = JSON.parse(readFileSync(kimiMcpConfigPath(), "utf-8")) as Record<
          string,
          unknown
        >;
        return makeMockChild({
          stdout: STREAM_JSON_NO_META,
        }) as unknown as ChildProcessWithoutNullStreams;
      });

      try {
        const provider = new KimiProvider("kimi", { cliCommand: "kimi" });
        await provider.run({
          prompt: "test",
          cwd: "/tmp",
          mcpServers: [{ name: "inbox", url: "http://127.0.0.1:5555/mcp/root-token" }],
        });

        expect(configDuringSpawn).toEqual({
          mcpServers: {
            user: { url: "http://keep" },
            inbox: { url: "http://127.0.0.1:5555/mcp/root-token" },
          },
          other: true,
        });
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
      } finally {
        if (previousKimiCodeHome === undefined) {
          delete process.env.KIMI_CODE_HOME;
        } else {
          process.env.KIMI_CODE_HOME = previousKimiCodeHome;
        }
        rmSync(kimiCodeHome, { recursive: true, force: true });
      }
    });

    it("creates a missing unsandboxed discovery config", () => {
      const root = mkdtempSync(join(tmpdir(), "kimi-mcp-merge-"));
      const configPath = join(root, "nested", "mcp.json");
      try {
        mergeKimiMcpConfig(configPath, [
          { name: "tracker", url: "http://127.0.0.1:5555/mcp/tracker" },
        ]);
        expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
          mcpServers: {
            tracker: { url: "http://127.0.0.1:5555/mcp/tracker" },
          },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("writes sandboxed mcp.json under host tmpdir, binds it into KIMI_CODE_HOME, and cleans it up", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      let bindSource: string | undefined;
      let sourceContent: string | undefined;
      vi.mocked(spawn).mockImplementation((_cmd, argv) => {
        const args = argv as string[];
        for (let j = 0; j < args.length - 2; j++) {
          if (args[j] === "--ro-bind" && args[j + 2] === SANDBOX_KIMI_MCP_CONFIG_PATH) {
            bindSource = args[j + 1];
            sourceContent = readFileSync(bindSource, "utf-8");
          }
        }
        return makeMockChild({
          stdout: STREAM_JSON_NO_META,
        }) as unknown as ChildProcessWithoutNullStreams;
      });

      await provider.run({
        prompt: "test",
        cwd: "/tmp",
        sandbox: { worktreePath: "/tmp/test-worktree" },
        mcpServers: [{ name: "tracker", url: "http://127.0.0.1:5555/mcp/secret-token" }],
      });

      expect(bindSource).toBeDefined();
      expect(dirname(bindSource as string)).toBe(tmpdir());
      expect((bindSource as string).startsWith("/tmp/test-worktree")).toBe(false);
      expect(JSON.parse(sourceContent as string)).toEqual({
        mcpServers: {
          tracker: { url: "http://127.0.0.1:5555/mcp/secret-token" },
        },
      });
      expect(existsSync(bindSource as string)).toBe(false);
    });

    it("cleans up the MCP temp config if synchronous sandbox setup throws", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      // Steer Kimi's temp-file write into a directory we control so we can assert
      // absence by path without touching the file contents.
      const tempDir = mkdtempSync(join(tmpdir(), "kimi-throw-"));
      const prevTmpdir = process.env.TMPDIR;
      process.env.TMPDIR = tempDir;

      const originalImpl = execFileSyncFn.getMockImplementation();
      execFileSyncFn.mockImplementation((command: string, args: string[]) => {
        if (command === "bwrap" && args[0] === "--version") return "bwrap version";
        if (command === "which" && args[0] === "kimi") {
          throw new Error("kimi not found");
        }
        throw new Error(`Unexpected execFileSync: ${command} ${args.join(" ")}`);
      });

      try {
        await expect(
          provider.run({
            prompt: "test",
            cwd: "/tmp",
            sandbox: { worktreePath: "/tmp/test-worktree" },
            mcpServers: [{ name: "tracker", url: "http://127.0.0.1:5555/mcp/secret-token" }],
          })
        ).rejects.toThrow("kimi not found");

        const remaining = readdirSync(tempDir).filter((name) => name.startsWith("rusa-mcp-kimi-"));
        expect(remaining).toHaveLength(0);
      } finally {
        if (prevTmpdir === undefined) {
          delete process.env.TMPDIR;
        } else {
          process.env.TMPDIR = prevTmpdir;
        }
        rmSync(tempDir, { recursive: true, force: true });
        if (originalImpl) {
          execFileSyncFn.mockImplementation(originalImpl);
        } else {
          execFileSyncFn.mockRestore();
        }
      }
    });
  });

  describe("arg construction", () => {
    it("emits exact target invocation: -p <prompt> --output-format stream-json --add-dir <cwd>", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: STREAM_JSON_NO_META }) as unknown as ChildProcessWithoutNullStreams
      );

      await provider.run({ prompt: "do the thing", cwd: "/my/worktree" });

      expect(spawn).toHaveBeenCalledWith(
        "kimi",
        ["-p", "do the thing", "--output-format", "stream-json", "--add-dir", "/my/worktree"],
        expect.objectContaining({ cwd: "/my/worktree" })
      );
    });

    it("does NOT emit -y, -S, -c, --yolo, --session, --continue, --quiet, -w flags", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: STREAM_JSON_NO_META }) as unknown as ChildProcessWithoutNullStreams
      );

      await provider.run({ prompt: "test", cwd: "/tmp" });

      const callArgs = vi.mocked(spawn).mock.calls[0][1];
      // Legacy flags must be absent
      expect(callArgs).not.toContain("-y");
      expect(callArgs).not.toContain("--yolo");
      expect(callArgs).not.toContain("-S");
      expect(callArgs).not.toContain("--session");
      expect(callArgs).not.toContain("-c");
      expect(callArgs).not.toContain("--continue");
      expect(callArgs).not.toContain("--quiet");
      expect(callArgs).not.toContain("-w");
    });

    it("includes --output-format stream-json in the args", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: STREAM_JSON_NO_META }) as unknown as ChildProcessWithoutNullStreams
      );

      await provider.run({ prompt: "test", cwd: "/tmp" });

      const callArgs = vi.mocked(spawn).mock.calls[0][1];
      expect(callArgs).toContain("--output-format");
      expect(callArgs).toContain("stream-json");
    });

    it("includes -m <model> when model is set", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config, "kimi-k2-5p");

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: STREAM_JSON_NO_META }) as unknown as ChildProcessWithoutNullStreams
      );

      await provider.run({ prompt: "test", cwd: "/tmp" });

      const callArgs = vi.mocked(spawn).mock.calls[0][1];
      expect(callArgs).toContain("-m");
      expect(callArgs).toContain("kimi-k2-5p");
    });
  });

  // ─── 2. Exit codes and basic I/O ────────────────────────────────────────────

  describe("exit codes and basic I/O", () => {
    it("returns success=true and exitCode=0 on clean exit", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({
          stdout: STREAM_JSON_NO_META,
        }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({ prompt: "test", cwd: "/tmp" });

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("extracts assistant content as output from stream-json", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({
          stdout: STREAM_JSON_WITH_META,
        }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({ prompt: "test", cwd: "/tmp" });

      expect(result.output).toBe("KIMI_SJ_OK");
    });

    it("collects stderr into chunks (forwarded to onStderr and onChunk)", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({
          stdout: STREAM_JSON_NO_META,
          stderr: "some stderr noise",
        }) as unknown as ChildProcessWithoutNullStreams
      );

      const stderrChunks: string[] = [];
      const allChunks: string[] = [];
      const result = await provider.run({
        prompt: "test",
        cwd: "/tmp",
        onStderr: (c) => stderrChunks.push(c),
        onChunk: (c) => allChunks.push(c),
      });

      expect(stderrChunks.join("")).toContain("some stderr noise");
      expect(allChunks.join("")).toContain("some stderr noise");
      // output comes from parsed assistant content (not raw)
      expect(result.output).toBe("Hello from kimi");
    });

    it("returns success=false and non-zero exitCode on CLI failure", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ exitCode: 1 }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({ prompt: "test", cwd: "/tmp" });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it("forwards stdout chunks to onStdout callback", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: STREAM_JSON_NO_META }) as unknown as ChildProcessWithoutNullStreams
      );

      const received: string[] = [];
      await provider.run({
        prompt: "test",
        cwd: "/tmp",
        onStdout: (c) => received.push(c),
      });

      expect(received.join("")).toBe(STREAM_JSON_NO_META);
    });
  });

  // ─── 3. Output parsing — stream-json ────────────────────────────────────────

  describe("output parsing — stream-json", () => {
    it("extracts session_id from the resume_hint meta line (structured field access)", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({
          stdout: STREAM_JSON_WITH_META,
        }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({ prompt: "test", cwd: "/tmp" });

      expect(result.sessionId).toBe("session_6c2ad3ad-abcd-1234-ef56-000000000001");
    });

    it("returns sessionId=undefined when no meta line is present", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: STREAM_JSON_NO_META }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({ prompt: "test", cwd: "/tmp" });

      expect(result.sessionId).toBeUndefined();
    });

    it("uses last assistant content when multiple assistant lines are present", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      const multiAssistant = [
        '{"role":"assistant","content":"First chunk"}\n',
        '{"role":"assistant","content":"Final answer"}\n',
      ].join("");

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: multiAssistant }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({ prompt: "test", cwd: "/tmp" });

      expect(result.output).toBe("Final answer");
    });

    it("gracefully handles non-JSON lines mixed in (e.g. stderr interleave)", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      const mixedOutput = [
        "some non-json line\n",
        '{"role":"assistant","content":"Clean output"}\n',
        "another non-json line\n",
      ].join("");

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: mixedOutput }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({ prompt: "test", cwd: "/tmp" });

      expect(result.output).toBe("Clean output");
      expect(result.success).toBe(true);
    });
  });

  // ─── 4. Session / resume mapping ────────────────────────────────────────────

  describe("session/resume mapping", () => {
    it("passes no session flags when opts.session is absent (fresh run)", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: STREAM_JSON_NO_META }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({ prompt: "test", cwd: "/tmp" });

      const callArgs = vi.mocked(spawn).mock.calls[0][1];
      // No session flags at all for a fresh run
      expect(callArgs).not.toContain("-r");
      expect(callArgs).not.toContain("-S");
      expect(callArgs).not.toContain("-c");
      expect(callArgs).not.toContain("--session");
      expect(callArgs).not.toContain("--continue");
      // sessionId comes from output; no meta line → undefined
      expect(result.sessionId).toBeUndefined();
    });

    it("passes no session flags when opts.session has no id (fresh run); sessionId captured from output", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({
          stdout: STREAM_JSON_WITH_META,
        }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({
        prompt: "test",
        cwd: "/tmp",
        session: {}, // no id → fresh run, let kimi assign
      });

      const callArgs = vi.mocked(spawn).mock.calls[0][1];
      // No self-generated session flags
      expect(callArgs).not.toContain("-S");
      expect(callArgs).not.toContain("-c");
      expect(callArgs).not.toContain("-r");

      // sessionId comes from the meta line in the output
      expect(result.sessionId).toBe("session_6c2ad3ad-abcd-1234-ef56-000000000001");
    });

    it("resumes an existing session with -r <id> when session.id is provided", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({
          stdout: STREAM_JSON_WITH_META,
        }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({
        prompt: "test",
        cwd: "/tmp",
        session: { id: "session_existing-abc-123" },
      });

      const callArgs = vi.mocked(spawn).mock.calls[0][1];
      expect(callArgs).toContain("-r");
      expect(callArgs).toContain("session_existing-abc-123");
      // Must NOT use legacy session flags
      expect(callArgs).not.toContain("-S");
      expect(callArgs).not.toContain("-c");

      // sessionId from the output (the meta line from resumed session)
      expect(result.sessionId).toBe("session_6c2ad3ad-abcd-1234-ef56-000000000001");
    });

    it("does NOT self-generate a session id — sessionId always captured from output", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      // Output with no meta line → sessionId must be undefined, not a self-generated value
      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: STREAM_JSON_NO_META }) as unknown as ChildProcessWithoutNullStreams
      );

      const result = await provider.run({
        prompt: "test",
        cwd: "/tmp",
        session: {}, // fresh run — no self-gen
      });

      // No -S flag, no self-generated sessionId
      const callArgs = vi.mocked(spawn).mock.calls[0][1];
      expect(callArgs).not.toContain("-S");
      expect(result.sessionId).toBeUndefined();
    });
  });

  // ─── 5. Bwrap sandbox ───────────────────────────────────────────────────────

  describe("bwrap sandbox wrapping", () => {
    it("wraps command in bwrap with the correct kimi-code args when sandbox is provided", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: STREAM_JSON_NO_META }) as unknown as ChildProcessWithoutNullStreams
      );

      const sandboxOptions = {
        worktreePath: "/tmp/test-worktree",
      };

      await provider.run({
        prompt: "test prompt",
        cwd: "/tmp",
        sandbox: sandboxOptions,
      });

      // Expect bwrap to be the command wrapping kimi with kimi-code flags
      expect(vi.mocked(spawn)).toHaveBeenCalledWith(
        "bwrap",
        expect.arrayContaining([
          "--",
          "/usr/local/bin/kimi",
          "-p",
          "test prompt",
          "--output-format",
          "stream-json",
          "--add-dir",
          "/tmp/test-worktree",
        ]),
        expect.objectContaining({
          cwd: "/", // cwd for bwrap itself is root; chdir handles in-sandbox path
        })
      );

      const callArgs = vi.mocked(spawn).mock.calls[0][1];
      // Legacy flags must not be present
      expect(callArgs).not.toContain("-y");
      expect(callArgs).not.toContain("--yolo");
      expect(callArgs).not.toContain("-S");
      expect(callArgs).not.toContain("-c");
      expect(callArgs).not.toContain("--quiet");
      expect(callArgs).not.toContain("-w");
      // No model arg since none was set
      expect(callArgs).not.toContain("-m");
      expect(callArgs).not.toContain("--model");
    });

    it("uses worktreePath for --add-dir when running inside sandbox", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      vi.mocked(spawn).mockReturnValue(
        makeMockChild({ stdout: STREAM_JSON_NO_META }) as unknown as ChildProcessWithoutNullStreams
      );

      const sandboxOptions = {
        worktreePath: "/sandbox/worktree",
      };

      await provider.run({
        prompt: "test",
        cwd: "/host/cwd",
        sandbox: sandboxOptions,
      });

      const callArgs = vi.mocked(spawn).mock.calls[0][1];
      const addDirIdx = callArgs.indexOf("--add-dir");
      expect(addDirIdx).toBeGreaterThanOrEqual(0);
      // Must use worktreePath, not the host cwd
      expect(callArgs[addDirIdx + 1]).toBe("/sandbox/worktree");
    });
  });

  // ─── 6. Cancellation ────────────────────────────────────────────────────────

  describe("cancellation", () => {
    it("returns cancelled=true and exitCode 143 when aborted via AbortSignal", async () => {
      const config: ProviderConfig = { cliCommand: "kimi" };
      const provider = new KimiProvider("kimi", config);

      const abortController = new AbortController();

      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (sig?: string) => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => {
        // Simulate signal-driven termination
        setTimeout(() => child.emit("close", null, "SIGTERM"), 5);
      });

      vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);

      const runPromise = provider.run({
        prompt: "test",
        cwd: "/tmp",
        signal: abortController.signal,
      });

      setTimeout(() => abortController.abort(), 10);

      const result = await runPromise;
      expect(result.cancelled).toBe(true);
      expect(result.exitCode).toBe(143);
    });
  });
});
