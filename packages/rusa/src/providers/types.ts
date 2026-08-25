/**
 * Provider abstraction for CLI-based coding agents.
 */

import type { RunTokenUsage } from "./token-accounting.js";

export type SandboxOptions = {
  worktreePath: string;
  /** True when the sandboxed actor is the E2E "root-agent" test double. */
  isE2eRoot?: boolean;
};

/**
 * An MCP server the agent should connect to for a run, over the streamable-HTTP
 * transport. Providers translate this to their own mechanism (claude: a
 * `--mcp-config` file; agy: a settings-file `mcpServers` entry).
 */
export interface McpServerSpec {
  /** Logical name the agent sees (e.g. "tracker", "chat"). */
  name: string;
  /** URL of the MCP server's streamable-HTTP endpoint. */
  url: string;
}

/**
 * Which session a run attaches to, for chained working memory across an actor's
 * runs. Omit `id` to create a new session; the provider returns the resulting id
 * in {@link RunResult.sessionId} — capture and persist it to resume later.
 *
 * Resolution differs per CLI: claude is given a chosen id at creation
 * (`--session-id`) and resumes by it (`--resume`); agy can't be told an id at
 * creation, so it mints its own conversation id which we capture and later pass
 * via `--conversation`.
 */
export interface SessionSpec {
  /** Existing session/conversation id to resume; omit to create a new one. */
  id?: string;
}

export interface RunOptions {
  /** The prompt/task description to send to the agent */
  prompt: string;
  /** Working directory for the agent subprocess */
  cwd: string;
  /** Timeout in milliseconds (default: 10 minutes) */
  timeoutMs?: number;
  /** AbortSignal for canceling the task */
  signal?: AbortSignal;
  /** Called with each stdout/stderr chunk as it arrives (subprocess providers only) */
  onChunk?: (chunk: string) => void;
  /** Called with raw stdout bytes decoded as UTF-8 before provider-specific parsing */
  onStdout?: (chunk: string) => void;
  /** Called with raw stderr bytes decoded as UTF-8 before provider-specific parsing */
  onStderr?: (chunk: string) => void;
  /** Bubblewrap sandbox options (when present, wraps the subprocess with bwrap) */
  sandbox?: SandboxOptions;
  /**
   * Attach to a provider session for chained working memory (used by long-lived
   * actors). Omit `session.id` to create a new session; its id comes back in
   * {@link RunResult.sessionId}.
   */
  session?: SessionSpec;
  /** MCP servers to attach for this run — the agent's tools. */
  mcpServers?: McpServerSpec[];
  /**
   * Extra directories to grant the agent beyond `cwd` (emitted as repeatable
   * `--add-dir`). Lets a multi-repo actor (e.g. the root) operate across several
   * synced repos at once. For unsandboxed runs these are host paths; sandboxed
   * multi-repo grants are handled by per-actor worktree binding (a later increment).
   */
  addDirs?: string[];
}

export interface RunResult {
  success: boolean;
  output: string;
  exitCode: number;
  cancelled?: boolean;
  interrupted?: boolean;
  /** True when the run was grace-killed by the supervisor after exceeding the yield grace period. */
  graceKilled?: boolean;
  /** The declared yield status ('complete' | 'blocked') if the run yielded. */
  yieldStatus?: string;
  /** True when the run failure is due to continuation-cap exhaustion. */
  capped?: boolean;
  /**
   * The session/conversation id used or newly created this run. For a created
   * session, persist it (e.g. in the thread registry) to resume the actor later.
   */
  sessionId?: string;
  /**
   * Provider read-back of the model actually bound for this session/run. This is
   * observability only; callers must not use it to choose or mutate providers.
   */
  boundModel?: string;
  /**
   * Provider read-back of tokens attributable to this invocation.
   * Observability only; callers must not use it to choose or mutate providers.
   */
  tokenUsage?: RunTokenUsage;
}

/**
 * A coding provider wraps a CLI tool (e.g. claude, codex) and
 * runs it as a subprocess in non-interactive mode.
 */
export interface CodingProvider {
  name: string;
  providerName: string;
  model?: string;
  run(opts: RunOptions): Promise<RunResult>;
}
