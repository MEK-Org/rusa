import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../config/types.js";
import { formatExecutingNotice, formatToolError } from "./live-output.js";
import {
  buildActorBwrapArgs,
  buildActorBwrapCommand,
  SANDBOX_MCP_CONFIG_PATH,
  teardownFlutterOverlay,
} from "./sandbox.js";
import { runSubprocess } from "./subprocess-execution.js";
import {
  attributedTokenUsage,
  extractClaudeTokenUsage,
  unattributedTokenUsage,
} from "./token-accounting.js";
import type { CodingProvider, McpServerSpec, RunOptions, RunResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export interface ClaudeArgsOptions {
  prompt: string;
  model?: string;
  /** First-class Claude Code effort level. Omit to preserve the CLI default. */
  effort?: string;
  /** Session to attach: `resume` an existing id (`--resume`), or create with a chosen id (`--session-id`). */
  session?: { id: string; resume: boolean };
  /** When set, adds `--mcp-config <path> --strict-mcp-config`. */
  mcpConfigPath?: string;
  /** Extra directories to grant via repeatable `--add-dir`. */
  addDirs?: string[];
}

/** Build the `claude` CLI args (pure; prompt is passed via `-p`). */
export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  const args = [
    "-p",
    o.prompt,
    "--dangerously-skip-permissions",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  if (o.session) {
    args.push(o.session.resume ? "--resume" : "--session-id", o.session.id);
  }
  if (o.mcpConfigPath) {
    // --strict-mcp-config: use only these servers, ignore any global config.
    args.push("--mcp-config", o.mcpConfigPath, "--strict-mcp-config");
  }
  for (const dir of o.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (o.model) {
    // Claude CLI uses dashes instead of periods in model names.
    args.push("--model", o.model.replace(/\./g, "-"));
  }
  if (o.effort) args.push("--effort", o.effort);
  return args;
}

/** Build the `--mcp-config` JSON claude loads, for HTTP MCP servers. */
export function buildClaudeMcpConfig(servers: McpServerSpec[]): string {
  const mcpServers: Record<string, { type: "http"; url: string }> = {};
  for (const s of servers) {
    mcpServers[s.name] = { type: "http", url: s.url };
  }
  return JSON.stringify({ mcpServers });
}

/**
 * Claude Code CLI provider.
 * Spawns `claude -p "<prompt>"` in non-interactive mode.
 */
export class ClaudeProvider implements CodingProvider {
  public readonly providerName = "claude";

  constructor(
    public readonly name: string,
    private readonly config: ProviderConfig,
    public readonly model?: string,
    public readonly effort?: string
  ) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const command = this.config.cliCommand ?? "claude";

    // Attach MCP servers by writing a --mcp-config file for this run.
    //
    // Security under the sandbox : the config carries this actor's
    // /mcp/<token> endpoint URL = its identity, so no *other* actor may read it.
    // Mirror the agy layout exactly: the SOURCE always goes to host /tmp (tmpdir)
    // — every sibling sandbox has its OWN `--tmpfs /tmp`, so the source is
    // invisible to siblings (no cross-actor token harvest) — and for a sandboxed
    // run it is `--ro-bind`-ed (see buildMeshActorBwrapArgs) to a fixed in-sandbox
    // path the owner reads. The owner's own tmpfs /tmp would otherwise shadow the
    // host source, which is exactly why the explicit bind is required. Unsandboxed
    // runs (the root) read the tmpdir source directly.
    let mcpConfigSource: string | undefined;
    let mcpConfigArg: string | undefined;
    if (opts.mcpServers && opts.mcpServers.length > 0) {
      mcpConfigSource = join(tmpdir(), `rusa-mcp-claude-${randomUUID()}.json`);
      writeFileSync(mcpConfigSource, buildClaudeMcpConfig(opts.mcpServers));
      // Sandboxed: claude reads the ro-bind target; unsandboxed: the source itself.
      mcpConfigArg = opts.sandbox ? SANDBOX_MCP_CONFIG_PATH : mcpConfigSource;
    }
    const cleanupMcpConfig = () => {
      if (!mcpConfigSource) return;
      try {
        unlinkSync(mcpConfigSource);
      } catch {
        /* best effort */
      }
    };
    const tempPaths: string[] = [];
    const cleanupTempPaths = () => {
      for (const p of tempPaths) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      tempPaths.length = 0;
    };

    // Resolve the session: resume the given id, or create with a generated id so
    // we always know it (claude accepts a chosen id at creation).
    let sessionId: string | undefined;
    let sessionArg: { id: string; resume: boolean } | undefined;
    if (opts.session) {
      sessionId = opts.session.id ?? randomUUID();
      sessionArg = { id: sessionId, resume: Boolean(opts.session.id) };
    }

    const args = buildClaudeArgs({
      prompt: opts.prompt,
      model: this.model,
      effort: this.effort,
      session: sessionArg,
      mcpConfigPath: mcpConfigArg,
      addDirs: opts.addDirs,
    });

    let spawnCommand = command;
    let spawnArgs = args;
    const spawnCwd = opts.sandbox ? "/" : opts.cwd;

    if (opts.sandbox) {
      const resolvedCommand = command.startsWith("/")
        ? command
        : execFileSync("which", [command], { encoding: "utf8" }).trim();
      const bwrapResult = buildActorBwrapArgs(
        opts.sandbox.worktreePath,
        "claude",
        mcpConfigSource,
        opts.sandbox.isE2eRoot,
        opts.sandbox.understandingMount
      );
      tempPaths.push(...bwrapResult.tempPaths);
      if (opts.sandbox.understandingMount) {
        tempPaths.push(opts.sandbox.understandingMount);
      }
      spawnArgs = buildActorBwrapCommand(bwrapResult, resolvedCommand, args);
      spawnCommand = "bwrap";
    }

    let buffer = "";
    const tokenLines: string[] = [];
    // Extract the display text of a tool_result content field, which can be a
    // plain string or an array of typed content items.
    const toolResultText = (content: unknown): string => {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((item) =>
            item && typeof item === "object" && "text" in item
              ? String((item as { text?: unknown }).text ?? "")
              : ""
          )
          .filter(Boolean)
          .join("\n");
      }
      return "";
    };
    // Issue #210: a tool result *arriving* is proof of liveness, but the body
    // belongs in the durable record only — live output keeps a liveness tick
    // plus a bounded error when the result is a failure.
    const handleToolResult = (text: string, isError: boolean, chunks: string[]) => {
      opts.onChunk?.("");
      if (!text) return;
      // The durable run record keeps the full result, as before.
      chunks.push(`\n[Tool Result]:\n${text}\n`);
      if (isError) {
        const msg = formatToolError(text);
        opts.onChunk?.(msg);
      }
    };
    const processLine = (line: string, chunks: string[]) => {
      if (!line.trim()) return;
      try {
        const json = JSON.parse(line);
        if (json.type === "assistant" && json.message?.usage) tokenLines.push(line);
        if (json.type === "stream_event") {
          const event = json.event;
          if (event.type === "content_block_delta") {
            const delta = event.delta;
            if (delta.type === "text_delta") {
              opts.onChunk?.(delta.text);
              chunks.push(delta.text);
            } else if (delta.type === "thinking_delta") {
              opts.onChunk?.(delta.thinking);
              chunks.push(delta.thinking);
            }
            // input_json_delta (streaming tool arguments) is deliberately not
            // forwarded: the invocation notice at content_block_start already
            // carries the concise signal, and raw argument fragments are noise.
          } else if (
            event.type === "content_block_start" &&
            event.content_block.type === "tool_use"
          ) {
            const tool = event.content_block.name;
            const msg = formatExecutingNotice(tool);
            opts.onChunk?.(msg);
            chunks.push(msg);
          }
        } else if (json.type === "user" && json.tool_use_result) {
          // Convenience shape some claude builds attach to user events.
          const result = json.tool_use_result;
          const text = result.stdout || result.stderr || "";
          handleToolResult(text, Boolean(result.is_error), chunks);
        } else if (json.type === "user" && Array.isArray(json.message?.content)) {
          // Canonical shape: tool results arrive as user-message content items.
          for (const item of json.message.content) {
            if (item?.type === "tool_result") {
              handleToolResult(toolResultText(item.content), Boolean(item.is_error), chunks);
            }
          }
        } else if (json.type === "assistant" && json.message?.content) {
          // Summary of the turn, can be used if we missed some deltas
          // But usually we prefer deltas for streaming.
          // If we already have chunks, we might be double-counting.
          // Let's only use this if we have no chunks yet.
          if (chunks.length === 0) {
            for (const item of json.message.content) {
              if (item.type === "text") {
                opts.onChunk?.(item.text);
                chunks.push(item.text);
              }
            }
          }
        } else if (json.type === "result") {
          if (json.is_error && json.result) {
            const msg = `\n[Error]: ${json.result}\n`;
            opts.onChunk?.(msg);
            chunks.push(msg);
          } else if (chunks.length === 0 && json.result) {
            // Fallback if we missed everything else
            opts.onChunk?.(json.result);
            chunks.push(json.result);
          }
        }
      } catch (_e) {
        // Not JSON, emit as raw text
        opts.onChunk?.(`${line}\n`);
        chunks.push(`${line}\n`);
      }
    };
    const captureTokenUsage = () => {
      const extracted = extractClaudeTokenUsage(tokenLines);
      return extracted
        ? attributedTokenUsage("claude", extracted.model ?? this.model ?? null, extracted.totals)
        : unattributedTokenUsage("claude", this.model ?? null);
    };

    return runSubprocess({
      command: spawnCommand,
      args: spawnArgs,
      cwd: spawnCwd,
      timeoutMs,
      signal: opts.signal,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
      handleStdoutData: (data, chunks) => {
        const text = data.toString();
        opts.onStdout?.(text);
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          processLine(line, chunks);
        }
      },
      onStdoutEnd: (chunks) => {
        if (buffer) {
          processLine(buffer, chunks);
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
      }) => ({
        success: false,
        output,
        exitCode,
        cancelled,
        interrupted,
        interruptSource,
        graceKilled,
        sessionId,
        tokenUsage: captureTokenUsage(),
      }),
      buildSignalResult: ({
        output,
        exitCode,
        cancelled,
        interrupted,
        interruptSource,
        graceKilled,
      }) => ({
        success: false,
        output,
        exitCode,
        cancelled,
        interrupted,
        interruptSource,
        graceKilled,
        sessionId,
        tokenUsage: captureTokenUsage(),
      }),
      buildExitResult: (output, exitCode) => ({
        success: exitCode === 0,
        output,
        exitCode,
        sessionId,
        tokenUsage: captureTokenUsage(),
      }),
      buildSpawnErrorResult: (err) => ({
        success: false,
        output: `Failed to spawn claude: ${err.message}`,
        exitCode: 1,
        sessionId,
        tokenUsage: captureTokenUsage(),
      }),
    });
  }
}
