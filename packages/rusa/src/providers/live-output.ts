/**
 * Shared formatting for the provider-neutral live-output contract (issue #210):
 * the Antigravity shape is the reference — assistant reasoning/text streams
 * verbatim, tool/MCP invocations show up as concise notices, successful
 * tool-result bodies never reach the live `onChunk`/SSE path, bounded tool
 * errors stay visible, and suppressed result arrival still signals liveness
 * via an empty-string chunk. The durable run record (RunResult.output) is a
 * separate concern and keeps whatever the provider already captured.
 */

/** Bound a string for live display, marking the cut with an ellipsis. */
export function truncateForLive(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

const TOOL_ERROR_MAX = 200;

/** Bounded, actionable tool error — visible in live output, body truncated. */
export function formatToolError(text: string): string {
  return `\n[Tool error: ${truncateForLive(text.trim(), TOOL_ERROR_MAX)}]\n`;
}

const COMMAND_MAX = 120;

/** Concise notice for a shell-command invocation. */
export function formatRunCommandNotice(command: string): string {
  return `\n[run_command: ${truncateForLive(command, COMMAND_MAX)}]\n`;
}

/** Concise notice for an MCP tool invocation (server + tool only — no arguments). */
export function formatMcpInvocationNotice(server: string, tool: string): string {
  return `\n[MCP ${server}:${tool}]\n`;
}

/** Concise notice for a named tool invocation (arguments intentionally absent). */
export function formatExecutingNotice(toolName: string): string {
  return `\n[Executing ${toolName}...]\n`;
}

const LIVE_ERROR_MAX = 300;

/** Bounded provider/run-level error — visible in live output. */
export function formatLiveError(text: string): string {
  return `\n[Error]: ${truncateForLive(text.trim(), LIVE_ERROR_MAX)}\n`;
}
