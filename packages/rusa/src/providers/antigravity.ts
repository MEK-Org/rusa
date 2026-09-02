import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ProviderConfig } from "../config/types.js";
import { buildActorBwrapArgs, buildActorBwrapCommand, teardownFlutterOverlay } from "./sandbox.js";
import { runSubprocess } from "./subprocess-execution.js";
import {
  agyGenerationCursor,
  attributedTokenUsage,
  extractAgyTokenUsageFromDb,
  unattributedTokenUsage,
} from "./token-accounting.js";
import type { CodingProvider, McpServerSpec, RunOptions, RunResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const CONVERSATION_TAIL_BYTES = 2 * 1024 * 1024;
const CONVERSATION_PREFIX_BYTES = 4096;
const CONVERSATION_FILE_SUFFIXES = [".db-wal", ".db", ".db-shm"] as const;

export interface AntigravityArgsOptions {
  prompt: string;
  model?: string;
  /** First-class agy reasoning level. Omit to preserve the CLI default. */
  effort?: string;
  /** Resumes an existing conversation by id (`--conversation`); omit to start fresh. */
  conversationId?: string;
  /** Extra directories to grant via repeatable `--add-dir`. */
  addDirs?: string[];
  /** Per-invocation `--log-file`; agy logs `conversation=<id>` there at run start. */
  logFile?: string;
  /** Used to set `--print-timeout` so agy returns gracefully within budget. */
  timeoutMs: number;
}

/** Build the `agy` CLI args (pure; prompt is passed via `-p`). */
export function buildAntigravityArgs(o: AntigravityArgsOptions): string[] {
  const args = ["-p", o.prompt, "--dangerously-skip-permissions", "--output-format", "stream-json"];
  if (o.conversationId) args.push("--conversation", o.conversationId);
  if (o.logFile) args.push("--log-file", o.logFile);
  for (const dir of o.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (o.model) args.push("--model", o.model);
  // agy 1.1.10+ resolves --effort against the model selected by --model. The
  // explicit flag therefore owns the effective reasoning level even when an
  // older passable display label still contains a parenthesized level.
  if (o.effort) args.push("--effort", o.effort);
  // agy's --print-timeout is a wall-clock execution ceiling (verified empirically).
  // Set it to match the full invocation budget (o.timeoutMs) so active streaming tasks are not cut short.
  const printTimeoutMin = Math.max(1, Math.ceil(o.timeoutMs / 60_000));
  args.push("--print-timeout", `${printTimeoutMin}m0s`);
  return args;
}

/**
 * Extract agy's conversation id from a run's `--log-file`. agy logs it
 * deterministically at the *start* of every run (e.g.
 * `Print mode: conversation=<uuid>, sending message`), so this is race-free and
 * not model-mediated — unlike capturing it from stdout or diffing the
 * conversations directory.
 */
export function parseConversationId(log: string): string | undefined {
  return log.match(/conversation=([0-9a-f-]{36})/i)?.[1];
}

export interface AntigravityQuotaRefusal {
  reason: "QUOTA_EXHAUSTED";
  retryDelay?: string;
  quotaResetTimeStamp?: string;
}

export function antigravityConversationsDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "conversations");
}

/**
 * Where the CLI keeps its per-worker workspaces, one directory per actor that
 * has ever run under it. rusa does not create these — it addresses them so a
 * retired actor's can be deleted rather than left readable to every worker that
 * comes after (see `actor/workspace-sweep.ts`).
 */
export function antigravityScratchDir(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "scratch");
}

interface ConversationFileWatermark {
  dev: number;
  ino: number;
  size: number;
  prefix: Buffer;
}

type ConversationWatermarks = Partial<
  Record<(typeof CONVERSATION_FILE_SUFFIXES)[number], ConversationFileWatermark>
>;

function conversationWatermarks(
  conversationId: string,
  conversationsDir: string
): ConversationWatermarks {
  const watermarks: ConversationWatermarks = {};
  for (const suffix of CONVERSATION_FILE_SUFFIXES) {
    let fd: number | undefined;
    try {
      const path = join(conversationsDir, `${conversationId}${suffix}`);
      const stat = statSync(path);
      const prefix = Buffer.alloc(Math.min(stat.size, CONVERSATION_PREFIX_BYTES));
      fd = openSync(path, "r");
      readSync(fd, prefix, 0, prefix.length, 0);
      watermarks[suffix] = { dev: stat.dev, ino: stat.ino, size: stat.size, prefix };
    } catch {
      /* file does not exist yet */
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return watermarks;
}

function readFileTailText(path: string, watermark?: ConversationFileWatermark): string {
  let fd: number | undefined;
  try {
    const stat = statSync(path);
    fd = openSync(path, "r");
    const currentPrefix = watermark ? Buffer.alloc(watermark.prefix.length) : undefined;
    if (currentPrefix) readSync(fd, currentPrefix, 0, currentPrefix.length, 0);
    const unchangedFile =
      watermark &&
      watermark.dev === stat.dev &&
      watermark.ino === stat.ino &&
      stat.size >= watermark.size &&
      currentPrefix?.equals(watermark.prefix);
    const attemptStart = unchangedFile ? watermark.size : 0;
    const offset = Math.max(attemptStart, stat.size - CONVERSATION_TAIL_BYTES);
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, offset);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

function extractQuotaRefusal(text: string): AntigravityQuotaRefusal | null {
  const marker = text.lastIndexOf("QUOTA_EXHAUSTED");
  if (marker < 0) return null;
  const window = text.slice(Math.max(0, marker - 2000), marker + 4000);
  if (!/"reason"\s*:\s*"QUOTA_EXHAUSTED"/.test(window)) return null;
  if (!/"status"\s*:\s*"RESOURCE_EXHAUSTED"/.test(window) && !/"code"\s*:\s*429\b/.test(window)) {
    return null;
  }
  const retryDelay = window.match(/"retryDelay"\s*:\s*"([^"]+)"/)?.[1];
  const quotaResetTimeStamp = window.match(/"quotaResetTimeStamp"\s*:\s*"([^"]+)"/)?.[1];
  return { reason: "QUOTA_EXHAUSTED", retryDelay, quotaResetTimeStamp };
}

export function classifyAntigravityQuotaRefusal(
  conversationId: string | undefined,
  conversationsDir = antigravityConversationsDir(),
  watermarks?: ConversationWatermarks
): AntigravityQuotaRefusal | null {
  if (!conversationId || !/^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  for (const suffix of CONVERSATION_FILE_SUFFIXES) {
    const refusal = extractQuotaRefusal(
      readFileTailText(join(conversationsDir, `${conversationId}${suffix}`), watermarks?.[suffix])
    );
    if (refusal) return refusal;
  }
  return null;
}

function formatQuotaRefusalFailure(refusal: AntigravityQuotaRefusal): string {
  const hints = [
    refusal.quotaResetTimeStamp ? `quotaResetTimeStamp=${refusal.quotaResetTimeStamp}` : null,
    refusal.retryDelay ? `retryDelay=${refusal.retryDelay}` : null,
  ].filter(Boolean);
  return `Antigravity run refused by provider quota: reason=${refusal.reason}${
    hints.length ? ` ${hints.join(" ")}` : ""
  }`;
}

/**
 * agy reads MCP servers from a Claude-Desktop-style `mcp_config.json` under its
 * GeminiDir (`~/.gemini`) — not a per-invocation flag (validated live). Both the
 * migrated `config/` dir and the legacy `antigravity/` dir are known locations;
 * we write both so it's picked up regardless of migration state.
 */
export function agyMcpConfigPaths(): string[] {
  const gemini = join(homedir(), ".gemini");
  return [
    join(gemini, "config", "mcp_config.json"),
    join(gemini, "antigravity", "mcp_config.json"),
  ];
}

/**
 * Merge our MCP servers (streamable-HTTP `url` schema) into an agy
 * `mcp_config.json`, preserving any servers the user configured. Idempotent: our
 * named servers are overwritten with fresh urls each call.
 */
export function mergeAgyMcpConfig(path: string, servers: McpServerSpec[]): void {
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    const raw = readFileSync(path, "utf-8");
    if (raw.trim()) config = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
  } catch {
    /* missing / empty / invalid → start fresh */
  }
  const mcpServers: Record<string, unknown> = { ...(config.mcpServers ?? {}) };
  for (const s of servers) mcpServers[s.name] = { url: s.url };
  config.mcpServers = mcpServers;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2));
}

/**
 * Write a per-invocation agy `mcp_config.json` to a temp file, built from ONLY
 * the given servers. It deliberately does NOT seed from the global `~/.gemini`
 * config: the unsandboxed root writes tracker+chat+mesh there, and seeding would
 * leak `chat` (and the root's own mesh endpoint) into a sandboxed worker — which
 * must report to its parent, not talk to humans (topology, B.7). The returned
 * file is bind-mounted over the agy config path inside the worker's sandbox.
 */
export function createTempAgyMcpConfig(servers: McpServerSpec[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    mcpServers[s.name] = { url: s.url };
  }
  const tempPath = join(tmpdir(), `rusa-agy-mcp-${randomUUID()}.json`);
  writeFileSync(tempPath, JSON.stringify({ mcpServers }, null, 2));
  return tempPath;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

export interface AgyToolStep {
  tool_name?: string;
  tool_info?: {
    name?: string;
    parameters?: Record<string, unknown>;
  };
}

/**
 * Format a human-readable live output notice for an agy tool invocation.
 * Produces concise metadata (MCP server/tool, command, paths, descriptions)
 * without spamming the live output log.
 */
export function formatAgyToolInvocation(step: AgyToolStep): string {
  const toolName = step.tool_name || step.tool_info?.name || "tool";
  const params = step.tool_info?.parameters ?? {};

  if (toolName === "call_mcp_tool") {
    const server = String(params.ServerName ?? "mcp");
    const tool = String(params.ToolName ?? "tool");
    const args = (
      params.Arguments && typeof params.Arguments === "object" ? params.Arguments : {}
    ) as Record<string, unknown>;
    const summaryParts: string[] = [];

    if (args.recipient) summaryParts.push(`recipient: ${args.recipient}`);
    if (args.issue_id || args.issue_number || args.IssueId) {
      summaryParts.push(`#${args.issue_id ?? args.issue_number ?? args.IssueId}`);
    }
    if (args.status) summaryParts.push(`status: ${args.status}`);
    if (args.action || args.Action) summaryParts.push(`action: ${args.action ?? args.Action}`);
    if (args.id || args.Id) summaryParts.push(`id: ${args.id ?? args.Id}`);
    if (args.query || args.Query) summaryParts.push(`query: "${args.query ?? args.Query}"`);
    if (args.message_id) summaryParts.push(`msg: ${args.message_id}`);
    if (args.thread_id) summaryParts.push(`thread: ${args.thread_id}`);

    if (summaryParts.length === 0 && params.toolSummary) {
      summaryParts.push(String(params.toolSummary));
    }

    const suffix = summaryParts.length > 0 ? ` (${summaryParts.join(", ")})` : "";
    return `\n[MCP ${server}:${tool}${suffix}]\n`;
  }

  if (toolName === "run_command" && params.CommandLine) {
    return `\n[run_command: ${truncate(String(params.CommandLine), 120)}]\n`;
  }

  if (toolName === "view_file" && params.AbsolutePath) {
    return `\n[view_file: ${params.AbsolutePath}]\n`;
  }

  if (
    toolName === "write_to_file" ||
    toolName === "replace_file_content" ||
    toolName === "multi_replace_file_content"
  ) {
    const target = params.TargetFile || params.AbsolutePath || "file";
    const desc =
      params.Description || params.Instruction || params.toolSummary || params.toolAction;
    const descSuffix = desc ? ` — "${truncate(String(desc), 100)}"` : "";
    return `\n[edit: ${target}${descSuffix}]\n`;
  }

  if (toolName === "grep_search" && params.Query) {
    const pathSuffix = params.SearchPath ? ` in ${params.SearchPath}` : "";
    return `\n[grep_search: "${params.Query}"${pathSuffix}]\n`;
  }

  if (toolName === "search_web" && params.query) {
    return `\n[search_web: "${params.query}"]\n`;
  }

  if (toolName === "list_dir" && params.DirectoryPath) {
    return `\n[list_dir: ${params.DirectoryPath}]\n`;
  }

  const desc = params.toolAction || params.toolSummary || params.Description;
  if (desc) {
    return `\n[${toolName}: ${truncate(String(desc), 120)}]\n`;
  }

  return `\n[Executing ${toolName}...]\n`;
}

/**
 * Google Antigravity CLI provider.
 *
 * The binary is `agy` (installed at ~/.local/bin/agy); the provider name is
 * "antigravity". Runs a single prompt non-interactively with
 * `agy -p "<prompt>" --dangerously-skip-permissions [--model "<model>"]`.
 * Models are agy's display names, e.g. "Gemini 3.1 Pro (High)" or
 * "Claude Sonnet 4.6 (Thinking)" (see `agy models`).
 *
 * Auth: `agy` caches an OAuth token under ~/.gemini/antigravity-cli/; the sandbox
 * binds that dir writable (see sandbox.ts authMode "antigravity"). No API key.
 */
export class AntigravityProvider implements CodingProvider {
  public readonly providerName = "antigravity";

  constructor(
    public readonly name: string,
    private readonly config: ProviderConfig,
    public readonly model?: string,
    private readonly conversationsDir = antigravityConversationsDir(),
    public readonly effort?: string
  ) {}

  async run(opts: RunOptions): Promise<RunResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const command = this.config.cliCommand ?? "agy";
    const incomingDbPath = opts.session?.id
      ? join(this.conversationsDir, `${opts.session.id}.db`)
      : undefined;
    const generationCursor = incomingDbPath ? agyGenerationCursor(incomingDbPath) : -1;

    let tempMcpConfigPath: string | undefined;

    // agy reads MCP from a Claude-Desktop-style mcp_config.json under GeminiDir
    // (~/.gemini), not a per-invocation flag. Merge our servers in, preserving
    // any user-configured ones.
    if (opts.mcpServers && opts.mcpServers.length > 0) {
      if (opts.sandbox) {
        for (const path of agyMcpConfigPaths()) {
          try {
            mkdirSync(dirname(path), { recursive: true });
          } catch (err) {
            console.warn(
              `[antigravity] failed to ensure directory ${dirname(path)}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
        try {
          tempMcpConfigPath = createTempAgyMcpConfig(opts.mcpServers);
        } catch (err) {
          console.warn(
            `[antigravity] failed to create temp MCP config: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        for (const path of agyMcpConfigPaths()) {
          try {
            mergeAgyMcpConfig(path, opts.mcpServers);
          } catch (err) {
            console.warn(
              `[antigravity] failed to write ${path}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }

    // When the caller wants a session, capture agy's conversation id from a
    // per-invocation --log-file (agy logs it at run start — race-free and not
    // model-mediated). The log MUST live inside the actor's working dir, which is
    // the one path bind-mounted read-write into the sandbox (host and sandbox see
    // the same inode). Host /tmp does NOT work for sandboxed workers: the sandbox
    // mounts a fresh tmpfs at /tmp, so agy's write lands in that throwaway mount
    // and the host-side read finds nothing — session capture silently fails and
    // the worker loses all continuity across wakes. Use the real cwd so the path
    // matches the sandbox's in-situ bind.
    let logDir = opts.cwd;
    try {
      logDir = realpathSync(opts.cwd);
    } catch {
      /* cwd not yet real — fall back to the given path */
    }
    const logFile = opts.session ? join(logDir, `.rusa-agy-${randomUUID()}.log`) : undefined;

    const args = buildAntigravityArgs({
      prompt: opts.prompt,
      model: this.model,
      effort: this.effort,
      conversationId: opts.session?.id,
      addDirs: opts.addDirs,
      logFile,
      timeoutMs,
    });

    let spawnCommand = command;
    let spawnArgs = args;
    const spawnCwd = opts.sandbox ? "/" : opts.cwd;
    const tempPaths: string[] = [];

    if (opts.sandbox) {
      // The actor's cwd is its private working directory; the sandbox shadows
      // everything beside it and binds a per-invocation agy mcp_config.
      const bwrapResult = buildActorBwrapArgs(
        opts.cwd,
        "antigravity",
        tempMcpConfigPath,
        opts.sandbox.isE2eRoot,
        opts.sandbox.understandingMount
      );
      tempPaths.push(...bwrapResult.tempPaths);
      if (opts.sandbox.understandingMount) {
        tempPaths.push(opts.sandbox.understandingMount);
      }
      spawnArgs = buildActorBwrapCommand(bwrapResult, command, args);
      spawnCommand = "bwrap";
    }

    const cleanup = () => {
      if (tempMcpConfigPath) {
        try {
          rmSync(tempMcpConfigPath, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
        tempMcpConfigPath = undefined;
      }
      for (const p of tempPaths) {
        try {
          rmSync(p, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      tempPaths.length = 0;
      if (opts.sandbox) {
        teardownFlutterOverlay(opts.cwd);
      }
    };

    let buffer = "";
    let capturedSessionId = opts.session?.id;
    let finalResultText: string | undefined;
    const emittedChunks: string[] = [];

    const processLine = (line: string, chunks?: string[]) => {
      if (!line.trim()) return;
      try {
        const json = JSON.parse(line);
        if (json.conversation_id && !capturedSessionId) {
          capturedSessionId = json.conversation_id;
        }
        if (json.event === "init") {
          if (json.conversation_id && !capturedSessionId) {
            capturedSessionId = json.conversation_id;
          }
          opts.onChunk?.("");
        } else if (json.event === "step_update" && json.step_update) {
          const step = json.step_update;
          if (step.conversation_id && !capturedSessionId) {
            capturedSessionId = step.conversation_id;
          }
          if (step.step_type === "tool") {
            if (step.state === "ACTIVE") {
              const msg = formatAgyToolInvocation(step);
              opts.onChunk?.(msg);
              emittedChunks.push(msg);
              chunks?.push(msg);
            } else if (step.state === "DONE") {
              opts.onChunk?.("");
              const info = step.tool_info;
              if (info) {
                if (info.is_error && info.error) {
                  const msg = `\n[Tool error: ${truncate(String(info.error), 200)}]\n`;
                  opts.onChunk?.(msg);
                  emittedChunks.push(msg);
                  chunks?.push(msg);
                } else if (
                  typeof info.output === "string" &&
                  (info.output.startsWith("Error:") || info.output.startsWith("Failed:"))
                ) {
                  const msg = `\n[Tool error: ${truncate(info.output.trim(), 200)}]\n`;
                  opts.onChunk?.(msg);
                  emittedChunks.push(msg);
                  chunks?.push(msg);
                }
              }
            }
          } else if (step.step_type === "agent_response") {
            if (step.text_delta) {
              opts.onChunk?.(step.text_delta);
              emittedChunks.push(step.text_delta);
              chunks?.push(step.text_delta);
            } else if (step.thinking_delta) {
              opts.onChunk?.(step.thinking_delta);
              emittedChunks.push(step.thinking_delta);
              chunks?.push(step.thinking_delta);
            }
          }
        } else if (json.event === "result" && json.result) {
          if (json.result.conversation_id && !capturedSessionId) {
            capturedSessionId = json.result.conversation_id;
          }
          if (json.result.status === "ERROR" && json.result.error) {
            const msg = `\n[Error]: ${json.result.error}\n`;
            opts.onChunk?.(msg);
            emittedChunks.push(msg);
            chunks?.push(msg);
            finalResultText = json.result.error;
          } else if (json.result.response) {
            finalResultText = json.result.response;
            if (emittedChunks.length === 0) {
              opts.onChunk?.(json.result.response);
              emittedChunks.push(json.result.response);
              chunks?.push(json.result.response);
            }
          }
        }
      } catch {
        // Not JSON, emit as raw text
        opts.onChunk?.(line);
        emittedChunks.push(line);
        chunks?.push(line);
      }
    };

    const captureSessionFromLog = (): string | undefined => {
      let sessionId = capturedSessionId ?? opts.session?.id;
      if (logFile) {
        // The id is logged at run start, so capture it regardless of exit code.
        try {
          sessionId = parseConversationId(readFileSync(logFile, "utf8")) ?? sessionId;
        } catch {
          /* log unreadable */
        }
        try {
          unlinkSync(logFile);
        } catch {
          /* best effort */
        }
        if (!sessionId) {
          console.warn("[antigravity] could not capture the conversation id from the run log");
        }
      }
      return sessionId;
    };
    const withTokenUsage = (result: RunResult): RunResult => {
      const sessionId = result.sessionId ?? opts.session?.id;
      const extracted =
        sessionId && generationCursor !== undefined
          ? extractAgyTokenUsageFromDb(
              join(this.conversationsDir, `${sessionId}.db`),
              generationCursor
            )
          : null;
      const model = extracted?.model ?? this.model ?? null;
      return {
        ...result,
        tokenUsage: extracted
          ? attributedTokenUsage("agy", model, extracted.totals)
          : unattributedTokenUsage("agy", model),
      };
    };
    const quotaRefusalWatermarks = opts.session?.id
      ? conversationWatermarks(opts.session.id, this.conversationsDir)
      : undefined;

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
      cleanup,
      buildKilledResult: ({ output, exitCode, cancelled, interrupted, graceKilled }) => {
        if (buffer) {
          processLine(buffer);
          buffer = "";
        }
        return withTokenUsage({
          success: false,
          output: finalResultText ?? (emittedChunks.length > 0 ? emittedChunks.join("") : output),
          exitCode,
          cancelled,
          interrupted,
          graceKilled,
          sessionId: opts.session?.id,
        });
      },
      buildSignalResult: ({ output, exitCode, cancelled, interrupted, graceKilled }) => {
        if (buffer) {
          processLine(buffer);
          buffer = "";
        }
        return withTokenUsage({
          success: false,
          output: finalResultText ?? (emittedChunks.length > 0 ? emittedChunks.join("") : output),
          exitCode,
          cancelled,
          interrupted,
          graceKilled,
          sessionId: captureSessionFromLog(),
        });
      },
      buildExitResult: (output, exitCode) => {
        if (buffer) {
          processLine(buffer);
          buffer = "";
        }
        const sessionId = captureSessionFromLog();
        const effectiveOutput =
          finalResultText ?? (emittedChunks.length > 0 ? emittedChunks.join("") : output);
        if (exitCode === 0) {
          const refusal = classifyAntigravityQuotaRefusal(
            sessionId,
            this.conversationsDir,
            quotaRefusalWatermarks
          );
          if (refusal) {
            return withTokenUsage({
              success: false,
              output: formatQuotaRefusalFailure(refusal),
              exitCode: 1,
              sessionId,
            });
          }
        }
        return withTokenUsage({
          success: exitCode === 0,
          output: effectiveOutput,
          exitCode,
          sessionId,
        });
      },
      buildSpawnErrorResult: (err) =>
        withTokenUsage({
          success: false,
          output: `Failed to spawn agy: ${err.message}`,
          exitCode: 1,
          sessionId: opts.session?.id,
        }),
    });
  }
}
