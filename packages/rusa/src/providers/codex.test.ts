import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import EventEmitter from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderConfig } from "../config/types.js";
import {
  buildCodexArgs,
  buildCodexConfigOverrides,
  CodexProvider,
  codexRolloutExists,
  codexRolloutResumable,
  extractCodexBoundModel,
  extractNewestCodexSessionId,
  overrideTomlModel,
  parseCodexModel,
  stripMcpServersFromToml,
} from "./codex.js";

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

describe("CodexProvider", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs codex with --yolo", async () => {
    const config: ProviderConfig = { cliCommand: "codex" };
    const provider = new CodexProvider("codex", config, "gpt-5-codex");

    const mockChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();

    vi.mocked(spawn).mockReturnValue(mockChild as ChildProcessWithoutNullStreams);

    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
    });

    setTimeout(() => {
      mockChild.emit("close", 0);
    }, 10);

    await runPromise;

    expect(spawn).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining([
        "exec",
        "--yolo",
        "--cd",
        "/tmp",
        "--model",
        "gpt-5-codex",
        "test prompt",
      ]),
      expect.objectContaining({ cwd: "/tmp" })
    );
  });

  it("runs codex inside bwrap sandbox when sandbox options are provided", async () => {
    const config: ProviderConfig = { cliCommand: "codex" };
    const provider = new CodexProvider("codex", config, "gpt-5-codex");

    const mockChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();

    vi.mocked(spawn).mockReturnValue(mockChild as ChildProcessWithoutNullStreams);

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

    expect(spawn).toHaveBeenCalledWith(
      "bwrap",
      expect.arrayContaining(["--", "codex", "exec", "--yolo", "--cd", "/tmp/test-worktree"]),
      expect.objectContaining({
        cwd: "/",
      })
    );
  });

  describe("parseCodexModel", () => {
    it("parses plain model slugs without reasoning effort", () => {
      expect(parseCodexModel("gpt-5.6-sol")).toEqual({
        model: "gpt-5.6-sol",
        reasoningEffort: undefined,
      });
      expect(parseCodexModel("gpt-5.4-mini")).toEqual({
        model: "gpt-5.4-mini",
        reasoningEffort: undefined,
      });
      expect(parseCodexModel("gpt-5.6-sol-high")).toEqual({
        model: "gpt-5.6-sol-high",
        reasoningEffort: undefined,
      });
      expect(parseCodexModel("o4-mini-high")).toEqual({
        model: "o4-mini-high",
        reasoningEffort: undefined,
      });
    });

    it("parses model slug with whitespace-separated reasoning effort", () => {
      expect(parseCodexModel("gpt-5.6-sol medium")).toEqual({
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      });
      expect(parseCodexModel("gpt-5.5 high")).toEqual({
        model: "gpt-5.5",
        reasoningEffort: "high",
      });
    });

    it("parses model slug with parenthesized reasoning effort", () => {
      expect(parseCodexModel("gpt-5.6-sol (medium)")).toEqual({
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      });
      expect(parseCodexModel("gpt-5.6-sol (reasoning medium, summaries auto)")).toEqual({
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
      });
    });

    it("returns empty object for empty or undefined input", () => {
      expect(parseCodexModel(undefined)).toEqual({});
      expect(parseCodexModel("")).toEqual({});
      expect(parseCodexModel("   ")).toEqual({});
    });
  });

  describe("buildCodexArgs", () => {
    it("builds a fresh exec with --yolo --cd and the model", () => {
      expect(buildCodexArgs({ prompt: "do it", model: "gpt-5-codex", cwd: "/wt" })).toEqual([
        "exec",
        "--yolo",
        "--cd",
        "/wt",
        "--model",
        "gpt-5-codex",
        "do it",
      ]);
    });

    it("strips reasoning effort from --model and passes it via --config override", () => {
      expect(buildCodexArgs({ prompt: "do it", model: "gpt-5.6-sol medium", cwd: "/wt" })).toEqual([
        "exec",
        "--yolo",
        "--cd",
        "/wt",
        "--model",
        "gpt-5.6-sol",
        "--config",
        'model_reasoning_effort="medium"',
        "do it",
      ]);
    });

    it("omits --model when none is set", () => {
      expect(buildCodexArgs({ prompt: "p", cwd: "/wt" })).toEqual([
        "exec",
        "--yolo",
        "--cd",
        "/wt",
        "p",
      ]);
    });

    it("builds a resume run with the long bypass flag and no --cd/--yolo", () => {
      const id = "019f09ab-7905-71b2-9dfd-73e8ae1269d6";
      expect(
        buildCodexArgs({ prompt: "next", model: "gpt-5-codex", cwd: "/wt", resumeSessionId: id })
      ).toEqual([
        "exec",
        "resume",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        "gpt-5-codex",
        id,
        "next",
      ]);
      // resume must NOT carry --cd or --yolo (codex 0.137 rejects them on the subcommand)
      const args = buildCodexArgs({ prompt: "next", cwd: "/wt", resumeSessionId: id });
      expect(args).not.toContain("--cd");
      expect(args).not.toContain("--yolo");
    });

    it("passes invocation-scoped config overrides to fresh and resumed runs", () => {
      const configOverrides = [
        'model="gpt-5.6-sol"',
        'mcp_servers.inbox.url="http://127.0.0.1:5555/mcp/token"',
      ];
      const fresh = buildCodexArgs({
        prompt: "fresh",
        cwd: "/wt",
        configOverrides,
      });
      const resumed = buildCodexArgs({
        prompt: "resume",
        cwd: "/wt",
        resumeSessionId: "019f09ab-7905-71b2-9dfd-73e8ae1269d6",
        configOverrides,
      });

      expect(fresh).toEqual(
        expect.arrayContaining(["--config", configOverrides[0], "--config", configOverrides[1]])
      );
      expect(resumed).toEqual(
        expect.arrayContaining(["--config", configOverrides[0], "--config", configOverrides[1]])
      );
    });

    it("hard-errors on an empty requested model instead of falling back to the config default ", () => {
      expect(() => buildCodexArgs({ prompt: "p", model: "", cwd: "/wt" })).toThrow(
        /model slug is empty/
      );
      expect(() => buildCodexArgs({ prompt: "p", model: "   ", cwd: "/wt" })).toThrow(
        /model slug is empty/
      );
      expect(() =>
        buildCodexArgs({
          prompt: "p",
          model: " ",
          cwd: "/wt",
          resumeSessionId: "019f09ab-7905-71b2-9dfd-73e8ae1269d6",
        })
      ).toThrow(/model slug is empty/);
    });
  });

  describe("buildCodexConfigOverrides", () => {
    it("pins the model and exposes every root MCP server", () => {
      expect(
        buildCodexConfigOverrides(
          [
            { name: "tracker", url: "http://127.0.0.1:5555/mcp/tracker-token" },
            { name: "inbox", url: "http://127.0.0.1:5555/mcp/inbox-token" },
          ],
          "gpt-5.6-sol"
        )
      ).toEqual([
        'model="gpt-5.6-sol"',
        'mcp_servers.tracker.url="http://127.0.0.1:5555/mcp/tracker-token"',
        'mcp_servers.inbox.url="http://127.0.0.1:5555/mcp/inbox-token"',
      ]);
    });

    it("separates model and reasoning effort into distinct overrides", () => {
      expect(
        buildCodexConfigOverrides(
          [{ name: "tracker", url: "http://127.0.0.1:5555/mcp/tracker-token" }],
          "gpt-5.6-sol medium"
        )
      ).toEqual([
        'model="gpt-5.6-sol"',
        'model_reasoning_effort="medium"',
        'mcp_servers.tracker.url="http://127.0.0.1:5555/mcp/tracker-token"',
      ]);
    });
  });

  describe("overrideTomlModel ", () => {
    const base = `
model = "gpt-5.5"
model_reasoning_effort = "medium"

[projects."/home/user/repo"]
trust_level = "trusted"
`;

    it("overwrites the config-default model with the requested one, preserving other keys", () => {
      const out = overrideTomlModel(base, "gpt-5.6-sol");
      expect(out).toContain('model = "gpt-5.6-sol"');
      expect(out).not.toContain('"gpt-5.5"');
      expect(out).toContain('model_reasoning_effort = "medium"');
      expect(out).toContain("trust_level");
    });

    it("overwrites reasoning effort if supplied in requested model string", () => {
      const out = overrideTomlModel(base, "gpt-5.6-sol high");
      expect(out).toContain('model = "gpt-5.6-sol"');
      expect(out).not.toContain('"gpt-5.5"');
      expect(out).toContain('model_reasoning_effort = "high"');
      expect(out).toContain("trust_level");
    });

    it("leaves the config untouched when no model was requested", () => {
      expect(overrideTomlModel(base, undefined)).toBe(base);
    });

    it("still pins the requested model when the base config is unparseable", () => {
      const out = overrideTomlModel("not [ valid toml ===", "gpt-5.6-sol");
      expect(out).toContain('model = "gpt-5.6-sol"');
    });
  });

  describe("codex rollout helpers", () => {
    const ID = "019f09ab-7905-71b2-9dfd-73e8ae1269d6";
    const OLDER = "019f0000-0000-7000-8000-000000000000";
    const ACTOR_ID = "8b3d6dd2-2faf-431f-b68d-fa6f6d09ef65";

    function makeRollout(sessionsDir: string, id: string, day: string): string {
      const dir = join(sessionsDir, "2026", "06", day);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `rollout-2026-06-${day}T15-21-00-${id}.jsonl`);
      writeFileSync(
        file,
        `${JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id, cwd: "/wt" } })}\n`
      );
      return file;
    }

    it("extracts the newest rollout's session id from the filename", () => {
      const root = mkdtempSync(join(tmpdir(), "codex-sessions-"));
      try {
        const older = makeRollout(root, OLDER, "26");
        // ensure deterministic mtime ordering
        const newer = makeRollout(root, ID, "27");
        const past = new Date(Date.now() - 60_000);
        utimesSync(older, past, past);
        void newer;
        expect(extractNewestCodexSessionId(root)).toBe(ID);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("does not mistake the actor id in the rollout store path for the session id", () => {
      const root = mkdtempSync(join(tmpdir(), `rusa-codex-sessions-${ACTOR_ID}-`));
      try {
        makeRollout(root, ID, "27");
        expect(extractNewestCodexSessionId(root)).toBe(ID);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("returns undefined when there is no rollout", () => {
      const root = mkdtempSync(join(tmpdir(), "codex-sessions-empty-"));
      try {
        expect(extractNewestCodexSessionId(root)).toBeUndefined();
        expect(codexRolloutExists(root, ID)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("detects whether a rollout for a given id exists", () => {
      const root = mkdtempSync(join(tmpdir(), "codex-sessions-exists-"));
      try {
        makeRollout(root, ID, "27");
        expect(codexRolloutExists(root, ID)).toBe(true);
        expect(codexRolloutExists(root, OLDER)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("extracts the provider-bound model from the rollout turn_context", () => {
      const root = mkdtempSync(join(tmpdir(), "codex-sessions-model-"));
      try {
        const file = makeRollout(root, ID, "27");
        writeFileSync(
          file,
          `${JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: ID, cwd: "/wt" } })}\n` +
            `${JSON.stringify({ timestamp: "t", type: "turn_context", payload: { model: "gpt-5.5" } })}\n`
        );
        expect(extractCodexBoundModel(root, ID)).toBe("gpt-5.5");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("treats a missing/corrupt/headerless rollout as NOT resumable", () => {
      const root = mkdtempSync(join(tmpdir(), "codex-sessions-resumable-"));
      try {
        // valid → resumable
        makeRollout(root, ID, "27");
        expect(codexRolloutResumable(root, ID)).toBe(true);

        // missing → not resumable (e.g. post-reboot, host /tmp wiped)
        expect(codexRolloutResumable(root, OLDER)).toBe(false);

        // exists but first line is truncated/garbage → not resumable
        const corrupt = "019f1111-1111-7111-8111-111111111111";
        const cdir = join(root, "2026", "06", "28");
        mkdirSync(cdir, { recursive: true });
        writeFileSync(
          join(cdir, `rollout-2026-06-28T15-21-00-${corrupt}.jsonl`),
          '{ "type": "session_meta", "payload": { "id": "019f1111-1111-'
        );
        expect(codexRolloutResumable(root, corrupt)).toBe(false);

        // exists, parses, but no session_meta payload.id → not resumable
        const headerless = "019f2222-2222-7222-8222-222222222222";
        const hdir = join(root, "2026", "06", "29");
        mkdirSync(hdir, { recursive: true });
        writeFileSync(
          join(hdir, `rollout-2026-06-29T15-21-00-${headerless}.jsonl`),
          `${JSON.stringify({ type: "event_msg", payload: { type: "task_started" } })}\n`
        );
        expect(codexRolloutResumable(root, headerless)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("sandboxed resume dispatch ", () => {
    const ID = "019f09ab-7905-71b2-9dfd-73e8ae1269d6";
    const WORKTREE = "/tmp/test-worktree";
    // Mirrors codexRolloutStoreDir(WORKTREE) — kept literal to catch path drift.
    const STORE = "/tmp/rusa-codex-sessions-test-worktree";

    function seedRollout(id: string): void {
      const dir = join(STORE, "2026", "06", "27");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `rollout-2026-06-27T15-21-00-${id}.jsonl`),
        `${JSON.stringify({ type: "session_meta", payload: { id, cwd: WORKTREE } })}\n`
      );
    }

    function seedCorruptRollout(id: string): void {
      const dir = join(STORE, "2026", "06", "27");
      mkdirSync(dir, { recursive: true });
      // First JSONL line truncated mid-write (crash/partial flush) — unparseable.
      writeFileSync(
        join(dir, `rollout-2026-06-27T15-21-00-${id}.jsonl`),
        '{ "type": "session_meta", "payload": { "id": "019f0'
      );
    }

    // Drive provider.run with one mock child per spawn, each closing with the
    // configured exit code (default 0). Returns every spawn's argv + the result.
    async function runWithSpawns(
      session: { id?: string } | undefined,
      closeCodes: number[]
    ): Promise<{ argvs: string[][]; result: Awaited<ReturnType<CodexProvider["run"]>> }> {
      const provider = new CodexProvider("codex", { cliCommand: "codex" }, "gpt-5-codex");
      const argvs: string[][] = [];
      let call = 0;
      vi.mocked(spawn).mockImplementation((_cmd, argv) => {
        const idx = call++;
        argvs.push(argv as string[]);
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setTimeout(() => child.emit("close", closeCodes[idx] ?? 0), 5);
        return child as unknown as ChildProcessWithoutNullStreams;
      });
      const result = await provider.run({
        prompt: "wake prompt",
        cwd: WORKTREE,
        sandbox: { worktreePath: WORKTREE },
        session,
      });
      return { argvs, result };
    }

    function codexArgsOf(argv: string[]): string[] {
      return argv.slice(argv.indexOf("--") + 1); // ["codex", "exec", ...]
    }

    function runAndCaptureArgv(session?: { id?: string }): Promise<string[]> {
      const provider = new CodexProvider("codex", { cliCommand: "codex" }, "gpt-5-codex");
      const mockChild = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      let captured: string[] = [];
      vi.mocked(spawn).mockImplementation((_cmd, argv) => {
        captured = argv as string[];
        return mockChild as unknown as ChildProcessWithoutNullStreams;
      });
      const runPromise = provider.run({
        prompt: "wake prompt",
        cwd: WORKTREE,
        sandbox: { worktreePath: WORKTREE },
        session,
      });
      setTimeout(() => mockChild.emit("close", 0), 10);
      return runPromise.then(() => captured);
    }

    afterEach(() => {
      rmSync(STORE, { recursive: true, force: true });
    });

    it("dispatches `exec resume <id>` when the stored session's rollout is present", async () => {
      seedRollout(ID);
      const argv = await runAndCaptureArgv({ id: ID });
      const sep = argv.indexOf("--");
      const codexArgs = argv.slice(sep + 1); // ["codex", "exec", "resume", ...]
      expect(codexArgs.slice(0, 4)).toEqual([
        "codex",
        "exec",
        "resume",
        "--dangerously-bypass-approvals-and-sandbox",
      ]);
      expect(codexArgs).toContain(ID);
      expect(codexArgs[codexArgs.length - 1]).toBe("wake prompt");
      // resume never carries --cd/--yolo (codex 0.137 rejects them on the subcommand)
      expect(codexArgs).not.toContain("--cd");
      expect(codexArgs).not.toContain("--yolo");
    });

    it("falls back to a fresh `exec` when the stored id has no rollout (e.g. post-reboot)", async () => {
      // No seedRollout → store is empty/absent.
      const argv = await runAndCaptureArgv({ id: ID });
      const sep = argv.indexOf("--");
      const codexArgs = argv.slice(sep + 1);
      expect(codexArgs.slice(0, 5)).toEqual(["codex", "exec", "--yolo", "--cd", WORKTREE]);
      expect(codexArgs).not.toContain("resume");
    });

    it("pre-check: a CORRUPT rollout never attempts resume — one fresh `exec`", async () => {
      seedCorruptRollout(ID);
      const { argvs } = await runWithSpawns({ id: ID }, [0]);
      // Only one spawn, and it's fresh (the corrupt rollout failed the pre-check).
      expect(argvs).toHaveLength(1);
      expect(codexArgsOf(argvs[0]).slice(0, 5)).toEqual([
        "codex",
        "exec",
        "--yolo",
        "--cd",
        WORKTREE,
      ]);
      expect(codexArgsOf(argvs[0])).not.toContain("resume");
    });

    it("backstop: a VALID rollout whose resume FAILS falls back to a fresh `exec`", async () => {
      // Pre-check passes (valid header), so resume is attempted; the resume process
      // then exits non-zero (deeper corruption / version mismatch the first line
      // can't reveal) → fall back to fresh. closeCodes: resume→1, fresh→0.
      seedRollout(ID);
      const { argvs, result } = await runWithSpawns({ id: ID }, [1, 0]);
      expect(argvs).toHaveLength(2);
      // First spawn: resume.
      expect(codexArgsOf(argvs[0]).slice(0, 3)).toEqual(["codex", "exec", "resume"]);
      // Second spawn: fresh.
      expect(codexArgsOf(argvs[1]).slice(0, 5)).toEqual([
        "codex",
        "exec",
        "--yolo",
        "--cd",
        WORKTREE,
      ]);
      expect(codexArgsOf(argvs[1])).not.toContain("resume");
      // The fresh retry succeeded → overall success.
      expect(result.success).toBe(true);
    });

    it("backstop: does NOT retry fresh when a resume succeeds", async () => {
      seedRollout(ID);
      const { argvs, result } = await runWithSpawns({ id: ID }, [0]);
      expect(argvs).toHaveLength(1);
      expect(codexArgsOf(argvs[0]).slice(0, 3)).toEqual(["codex", "exec", "resume"]);
      expect(result.success).toBe(true);
    });
  });

  it("strips mcp_servers section from TOML cleanly", () => {
    const toml = `
model = "gpt-5.5"

[mcp_servers.tracker]
url = "http://127.0.0.1:5555/mcp"

[projects."/projects/document-toolkit"]
trust_level = "trusted"
`;
    const stripped = stripMcpServersFromToml(toml);
    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).toContain('[projects."/projects/document-toolkit"]');
    expect(stripped).not.toContain("mcp_servers.tracker");
  });

  it("unsandboxed root: passes every MCP server as an invocation-scoped config override", async () => {
    const provider = new CodexProvider("codex", { cliCommand: "codex" }, "gpt-5.6-sol");
    const mockChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    vi.mocked(spawn).mockReturnValue(mockChild as unknown as ChildProcessWithoutNullStreams);

    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      mcpServers: [
        { name: "tracker", url: "http://127.0.0.1:5555/mcp/tracker-token" },
        { name: "inbox", url: "http://127.0.0.1:5555/mcp/inbox-token" },
      ],
    });
    setTimeout(() => mockChild.emit("close", 0), 10);
    await runPromise;

    const [spawnCommand, spawnArgs] = vi.mocked(spawn).mock.calls[0];
    expect(spawnCommand).toBe("codex");
    expect(spawnArgs).toEqual(
      expect.arrayContaining([
        "--config",
        'model="gpt-5.6-sol"',
        "--config",
        'mcp_servers.tracker.url="http://127.0.0.1:5555/mcp/tracker-token"',
        "--config",
        'mcp_servers.inbox.url="http://127.0.0.1:5555/mcp/inbox-token"',
      ])
    );
  });

  it("sandboxed: mcp-config source on host /tmp, bound to /tmp/config.toml", async () => {
    const config: ProviderConfig = { cliCommand: "codex" };
    const provider = new CodexProvider("codex", config, "gpt-5-codex");

    const mockChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();

    let bindSource: string | undefined;
    let bindPresent = false;
    let sourceContent: string | undefined;

    vi.mocked(spawn).mockImplementation((_cmd, argv) => {
      const args = argv as string[];
      for (let j = 0; j < args.length - 2; j++) {
        if (args[j] === "--bind" && args[j + 2] === "/tmp/config.toml") {
          bindPresent = true;
          bindSource = args[j + 1];
        }
      }
      if (bindSource) {
        try {
          sourceContent = readFileSync(bindSource, "utf-8");
        } catch {
          // might be cleaned up or doesn't exist yet
        }
      }
      return mockChild as unknown as ChildProcessWithoutNullStreams;
    });

    const runPromise = provider.run({
      prompt: "test prompt",
      cwd: "/tmp",
      sandbox: { worktreePath: "/tmp/test-worktree" },
      mcpServers: [{ name: "tracker", url: "http://127.0.0.1:5555/mcp/secret-token" }],
    });
    setTimeout(() => mockChild.emit("close", 0), 10);
    await runPromise;

    expect(bindPresent).toBe(true);
    expect(bindSource).toBeDefined();
    expect(dirname(bindSource as string)).toBe(tmpdir());
    expect(sourceContent).toContain("[mcp_servers.tracker]");
    expect(sourceContent).toContain("http://127.0.0.1:5555/mcp/secret-token");
  });

  it("sandboxed: requested model wins over the host config default in the merged config ", async () => {
    // A host ~/.codex/config.toml carrying a different default model — the
    // config codex would silently fall back to if slug resolution fails.
    const fakeHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n'
    );
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const config: ProviderConfig = { cliCommand: "codex" };
      const provider = new CodexProvider("codex", config, "gpt-5.6-sol");

      const mockChild = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();

      let sourceContent: string | undefined;
      let codexArgv: string[] = [];
      vi.mocked(spawn).mockImplementation((_cmd, argv) => {
        const args = argv as string[];
        codexArgv = args;
        for (let j = 0; j < args.length - 2; j++) {
          if (args[j] === "--bind" && args[j + 2] === "/tmp/config.toml") {
            try {
              sourceContent = readFileSync(args[j + 1], "utf-8");
            } catch {
              // might be cleaned up or doesn't exist yet
            }
          }
        }
        return mockChild as unknown as ChildProcessWithoutNullStreams;
      });

      const runPromise = provider.run({
        prompt: "test prompt",
        cwd: "/tmp",
        sandbox: { worktreePath: "/tmp/test-worktree" },
        mcpServers: [{ name: "tracker", url: "http://127.0.0.1:5555/mcp" }],
      });
      setTimeout(() => mockChild.emit("close", 0), 10);
      await runPromise;

      // The merged config's model is the REQUESTED slug — the inherited host
      // default can no longer shadow the --model flag.
      expect(sourceContent).toContain('model = "gpt-5.6-sol"');
      expect(sourceContent).not.toContain('"gpt-5.5"');
      // Unrelated host config keys survive the merge, as does the MCP section.
      expect(sourceContent).toContain('model_reasoning_effort = "medium"');
      expect(sourceContent).toContain("[mcp_servers.tracker]");
      // And the flag itself still carries the same slug: flag and config agree.
      const modelFlagIdx = codexArgv.indexOf("--model");
      expect(codexArgv[modelFlagIdx + 1]).toBe("gpt-5.6-sol");
    } finally {
      process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("sandboxed: requested model wins over the host config default in the merged config even without MCP servers ", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n'
    );
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const config: ProviderConfig = { cliCommand: "codex" };
      const provider = new CodexProvider("codex", config, "gpt-5.6-sol");

      const mockChild = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();

      let sourceContent: string | undefined;
      let codexArgv: string[] = [];
      vi.mocked(spawn).mockImplementation((_cmd, argv) => {
        const args = argv as string[];
        codexArgv = args;
        for (let j = 0; j < args.length - 2; j++) {
          if (args[j] === "--bind" && args[j + 2] === "/tmp/config.toml") {
            try {
              sourceContent = readFileSync(args[j + 1], "utf-8");
            } catch {
              // might be cleaned up or doesn't exist yet
            }
          }
        }
        return mockChild as unknown as ChildProcessWithoutNullStreams;
      });

      const runPromise = provider.run({
        prompt: "test prompt",
        cwd: "/tmp",
        sandbox: { worktreePath: "/tmp/test-worktree" },
      });
      setTimeout(() => mockChild.emit("close", 0), 10);
      await runPromise;

      // The merged config's model is overwritten even without MCP servers.
      expect(sourceContent).toBeDefined();
      expect(sourceContent).toContain('model = "gpt-5.6-sol"');
      expect(sourceContent).not.toContain('"gpt-5.5"');
      expect(sourceContent).toContain('model_reasoning_effort = "medium"');
      expect(sourceContent).not.toContain("mcp_servers");
      const modelFlagIdx = codexArgv.indexOf("--model");
      expect(codexArgv[modelFlagIdx + 1]).toBe("gpt-5.6-sol");
    } finally {
      process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("sandboxed: leaves config untouched and does not fabricate a model when no model is requested and no MCP servers are present ", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".codex", "config.toml"),
      'model = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n'
    );
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      const config: ProviderConfig = { cliCommand: "codex" };
      // No model requested (undefined)
      const provider = new CodexProvider("codex", config, undefined);

      const mockChild = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();

      let sourceContent: string | undefined;
      vi.mocked(spawn).mockImplementation((_cmd, argv) => {
        const args = argv as string[];
        for (let j = 0; j < args.length - 2; j++) {
          if (args[j] === "--bind" && args[j + 2] === "/tmp/config.toml") {
            try {
              sourceContent = readFileSync(args[j + 1], "utf-8");
            } catch {
              // might be cleaned up or doesn't exist yet
            }
          }
        }
        return mockChild as unknown as ChildProcessWithoutNullStreams;
      });

      const runPromise = provider.run({
        prompt: "test prompt",
        cwd: "/tmp",
        sandbox: { worktreePath: "/tmp/test-worktree" },
      });
      setTimeout(() => mockChild.emit("close", 0), 10);
      await runPromise;

      // Existing behavior remains unchanged: no custom config config is bound,
      // letting the host config-default fall through.
      expect(sourceContent).toBeUndefined();
    } finally {
      process.env.HOME = prevHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
