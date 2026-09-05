import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderConfig } from "../config/types.js";
import {
  formatExecutingNotice,
  formatLiveError,
  formatToolError,
  truncateForLive,
} from "./live-output.js";
import {
  buildActorBwrapArgs,
  buildActorBwrapCommand,
  kimiSessionStoreDir,
  teardownFlutterOverlay,
} from "./sandbox.js";
import { runSubprocess } from "./subprocess-execution.js";
import {
  attributedTokenUsage,
  extractKimiTokenUsageFromStore,
  unattributedTokenUsage,
} from "./token-accounting.js";
import type { CodingProvider, McpServerSpec, RunOptions, RunResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Kimi coding CLI provider — targets kimi-code 0.22.1 interface.
 *
 * Target invocation:
 *   Fresh run: kimi -p "<prompt>" --output-format stream-json --add-dir <worktree>
 *   Resume:    kimi -p "<prompt>" --output-format stream-json --add-dir <worktree> -r <id>
 *
 * Key interface facts (verified against live kimi-code 0.22.1 by root):
 *   - Prompt is an ARG to `-p/--prompt`, NOT piped via stdin.
 *   - `-y/--yolo` is INCOMPATIBLE with `-p` (errors: "Cannot combine --prompt with --yolo").
 *     Do NOT use it. Plain `-p` runs headless without hanging on approvals.
 *   - `--add-dir <dir>` replaces the legacy `-w`.
 *   - `--output-format stream-json` is the default (avoids noisy reasoning bullets + resume
 *     trailers that `text` mode emits).
 *
 * Session mapping (verified against live CLI by root):
 *   - Kimi generates the session id itself; we MUST NOT self-generate one.
 *   - Fresh run: just `-p` with NO session flag. The session id comes from parsing the output.
 *   - Resume: `-r <id>` (verified real continuity; flag is real though hidden from --help).
 *   - Session id is captured from the `{"role":"meta","type":"session.resume_hint","session_id":"..."}
 *     line in stream-json output — structured field access, not regex.
 *
 * Stream-json output format (newline-delimited JSON objects):
 *   {"role":"assistant","content":"<response text>"}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_6c2ad3ad-…","command":"kimi -r …","content":"…"}
 *
 * Parsing:
 *   - response text = final `assistant` role object's `content`
 *   - sessionId = the `session.resume_hint` meta line's `session_id` field
 *   - If no meta line present → sessionId is undefined (graceful)
 */

/** Parsed result from a stream-json output. */
interface ParsedStreamJson {
  responseText: string;
  sessionId: string | undefined;
}

/**
 * Parse kimi stream-json output (newline-delimited JSON objects).
 * Returns the last assistant content and session id from the meta line.
 */
function parseStreamJson(raw: string): ParsedStreamJson {
  let responseText = "";
  let sessionId: string | undefined;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      // Non-JSON line (e.g. stderr noise mixed in) — skip
      continue;
    }
    if (typeof obj !== "object" || obj === null) continue;
    const record = obj as Record<string, unknown>;
    if (record.role === "assistant" && typeof record.content === "string") {
      responseText = record.content as string;
    } else if (
      record.role === "meta" &&
      record.type === "session.resume_hint" &&
      typeof record.session_id === "string"
    ) {
      sessionId = record.session_id as string;
    }
  }

  return { responseText, sessionId };
}

/** Build the Kimi mcp.json shape for HTTP MCP servers. */
export function buildKimiMcpConfig(servers: McpServerSpec[]): string {
  const mcpServers: Record<string, { url: string }> = {};
  for (const s of servers) {
    mcpServers[s.name] = { url: s.url };
  }
  return JSON.stringify({ mcpServers });
}

/** Kimi's normal unsandboxed MCP discovery path. */
export function kimiMcpConfigPath(): string {
  const kimiCodeHome = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
  return join(kimiCodeHome, "mcp.json");
}

/**
 * Merge Rusa's MCP servers into Kimi's normal discovery config while
 * retaining any user-configured servers and unrelated top-level settings.
 */
export function mergeKimiMcpConfig(path: string, servers: McpServerSpec[]): void {
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    const raw = readFileSync(path, "utf-8");
    if (raw.trim()) config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
  } catch {
    /* missing / empty / invalid → start fresh */
  }
  const mcpServers: Record<string, unknown> = { ...(config.mcpServers ?? {}) };
  for (const server of servers) mcpServers[server.name] = { url: server.url };
  config.mcpServers = mcpServers;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

export class KimiProvider implements CodingProvider {
  public readonly providerName = "kimi";

  constructor(
    public readonly name: string,
    private readonly config: ProviderConfig,
    public readonly model?: string
  ) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const runStartedAt = new Date().toISOString();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const command = this.config.cliCommand ?? "kimi";
    const worktreeOrCwd = opts.sandbox ? opts.sandbox.worktreePath : opts.cwd;

    // Session flags:
    //   Fresh run (no session or no id) → no session flag; id captured from output.
    //   Resume (session.id present)     → -r <id>
    const sessionFlags: string[] = [];
    if (opts.session?.id) {
      sessionFlags.push("-r", opts.session.id);
    }
    // NOTE: We do NOT self-generate a session id. The id is captured from stream-json output.

    const args: string[] = [
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--add-dir",
      worktreeOrCwd,
      ...sessionFlags,
    ];

    if (this.model) {
      args.push("-m", this.model);
    }

    let spawnCommand = command;
    let spawnArgs = args;
    const spawnCwd = opts.sandbox ? "/" : opts.cwd;
    const tempPaths: string[] = [];

    let mcpConfigSource: string | undefined;

    const cleanupMcpConfig = () => {
      if (!mcpConfigSource) return;
      try {
        unlinkSync(mcpConfigSource);
      } catch {
        /* best effort */
      }
    };

    try {
      if (!opts.sandbox && opts.mcpServers && opts.mcpServers.length > 0) {
        mergeKimiMcpConfig(kimiMcpConfigPath(), opts.mcpServers);
      }

      if (opts.sandbox) {
        // Attach MCP servers through Kimi's per-user mcp.json discovery path. For
        // sandboxed workers, buildActorBwrapArgs ro-binds this host-/tmp source to
        // KIMI_CODE_HOME=/tmp/kimi-home as /tmp/kimi-home/mcp.json. The write is
        // scoped to the sandboxed path: an unsandboxed run has no consumer for this
        // file and skips creating it entirely.
        if (opts.mcpServers && opts.mcpServers.length > 0) {
          mcpConfigSource = join(tmpdir(), `rusa-mcp-kimi-${randomUUID()}.json`);
          writeFileSync(mcpConfigSource, buildKimiMcpConfig(opts.mcpServers), { mode: 0o600 });
        }

        const resolvedCommand = command.startsWith("/")
          ? command
          : execFileSync("which", [command], { encoding: "utf8" }).trim();
        const bwrapResult = buildActorBwrapArgs(
          opts.sandbox.worktreePath,
          "kimi",
          mcpConfigSource,
          opts.sandbox.isE2eRoot,
          opts.sandbox.understandingMount,
          opts.sandbox.e2eWritableRemoteDir
        );
        tempPaths.push(...bwrapResult.tempPaths);
        if (opts.sandbox.understandingMount) {
          tempPaths.push(opts.sandbox.understandingMount);
        }
        spawnArgs = buildActorBwrapCommand(bwrapResult, resolvedCommand, args);
        spawnCommand = "bwrap";
      }

      const cleanupTempPaths = () => {
        for (const p of tempPaths) {
          try {
            // recursive: a kimi temp path may be a dir (the writable credentials copy, ISSUE_NUM)
            // as well as a file (the oauth token copy).
            rmSync(p, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
        }
        tempPaths.length = 0;
      };
      const withTokenUsage = (result: RunResult): RunResult => {
        const sessionId = result.sessionId ?? opts.session?.id;
        const totals =
          opts.sandbox && sessionId
            ? extractKimiTokenUsageFromStore(
                kimiSessionStoreDir(opts.sandbox.worktreePath),
                sessionId,
                runStartedAt
              )
            : null;
        return {
          ...result,
          tokenUsage: totals
            ? attributedTokenUsage("kimi", this.model ?? null, totals)
            : unattributedTokenUsage("kimi", this.model ?? null),
        };
      };

      // Live-output normalization (issue #210). Stream shapes verified against
      // kimi-code's PromptJsonWriter: assistant text/tool_calls flush together
      // at step boundaries, tool results arrive as role:"tool" lines, retries
      // as role:"meta" turn.step.retrying lines, and a goal.summary object
      // closes the stream.
      let buffer = "";
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let json: Record<string, unknown>;
        try {
          json = JSON.parse(line) as Record<string, unknown>;
        } catch {
          // Not JSON (e.g. stderr noise mixed into stdout) — keep the
          // pre-normalization behavior of forwarding it raw.
          opts.onChunk?.(line);
          return;
        }
        if (json.role === "assistant") {
          if (typeof json.content === "string" && json.content) {
            opts.onChunk?.(json.content);
          }
          if (Array.isArray(json.tool_calls)) {
            for (const call of json.tool_calls) {
              const name =
                call && typeof call === "object"
                  ? String((call as { function?: { name?: unknown } }).function?.name ?? "tool")
                  : "tool";
              opts.onChunk?.(formatExecutingNotice(name));
            }
          }
          return;
        }
        if (json.role === "tool") {
          // Result arrival is liveness even though the body is suppressed.
          opts.onChunk?.("");
          const content = typeof json.content === "string" ? json.content : "";
          if (content.startsWith("Error:") || content.startsWith("Failed:")) {
            opts.onChunk?.(formatToolError(content));
          }
          return;
        }
        if (json.role === "meta") {
          if (json.type === "turn.step.retrying") {
            const name = String(json.error_name ?? "error");
            const message = truncateForLive(String(json.error_message ?? ""), 160);
            const attempt = json.next_attempt;
            const max = json.max_attempts;
            const attemptSuffix =
              typeof attempt === "number" && typeof max === "number"
                ? ` (attempt ${attempt}/${max})`
                : "";
            opts.onChunk?.(`\n[Retrying${attemptSuffix}: ${name}: ${message}]\n`);
            return;
          }
          // session.resume_hint and other meta lines need no live rendering;
          // the final parse captures the session id from the raw record.
          opts.onChunk?.("");
          return;
        }
        if (json.type === "error") {
          opts.onChunk?.(formatLiveError(String(json.message ?? "unknown error")));
          return;
        }
        // goal.summary and any future envelope types: tick liveness only.
        opts.onChunk?.("");
      };

      return runSubprocess({
        command: spawnCommand,
        args: spawnArgs,
        cwd: spawnCwd,
        timeoutMs,
        signal: opts.signal,
        onStdout: opts.onStdout,
        onStderr: opts.onStderr,
        // Issue #210: kimi's stream-json lines are normalized for live output.
        // The raw stdout/stderr still accumulates in `chunks` so the final
        // parse (assistant text + session id) is unchanged; only reasoning/
        // text, concise tool notices, and bounded errors reach onChunk, with
        // an empty-string liveness tick on every suppressed result.
        handleStdoutData: (data, chunks) => {
          const text = data.toString();
          opts.onStdout?.(text);
          chunks.push(text);
          buffer += text;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            processLine(line);
          }
        },
        handleStderrData: (data, chunks) => {
          const text = data.toString();
          opts.onStderr?.(text);
          // The rendered stderr stream stays in the durable record but never
          // reaches the live-output callback.
          chunks.push(text);
        },
        onStdoutEnd: () => {
          if (buffer) {
            processLine(buffer);
            buffer = "";
          }
        },
        cleanup: () => {
          cleanupMcpConfig();
          cleanupTempPaths();
          if (opts.sandbox) {
            teardownFlutterOverlay(opts.sandbox.worktreePath);
          }
        },
        buildKilledResult: ({
          output,
          exitCode,
          cancelled,
          interrupted,
          interruptSource,
          graceKilled,
        }) =>
          withTokenUsage({
            success: false,
            output,
            exitCode,
            cancelled,
            interrupted,
            interruptSource,
            graceKilled,
          }),
        buildSignalResult: ({
          output,
          exitCode,
          cancelled,
          interrupted,
          interruptSource,
          graceKilled,
        }) =>
          withTokenUsage({
            success: false,
            output,
            exitCode,
            cancelled,
            interrupted,
            interruptSource,
            graceKilled,
            sessionId: parseStreamJson(output).sessionId,
          }),
        buildExitResult: (rawOutput, exitCode) => {
          const { responseText, sessionId } = parseStreamJson(rawOutput);
          return withTokenUsage({
            success: exitCode === 0,
            // Use parsed response text when available (structured output),
            // fall back to raw output (e.g. non-zero exit with error messages on stderr)
            output: responseText || rawOutput,
            exitCode,
            sessionId,
          });
        },
        buildSpawnErrorResult: (err) =>
          withTokenUsage({
            success: false,
            output: `Failed to spawn kimi: ${err.message}`,
            exitCode: 1,
          }),
      });
    } catch (err) {
      cleanupMcpConfig();
      throw err;
    }
  }
}
