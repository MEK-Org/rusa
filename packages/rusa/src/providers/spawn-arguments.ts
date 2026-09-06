/**
 * Launch-boundary safety for the assembled text a provider CLI is spawned with.
 *
 * Node validates argv synchronously: `child_process.spawn` throws
 * `ERR_INVALID_ARG_VALUE` ("must be a string without null bytes") before any
 * child exists, so one literal NUL anywhere in the assembled prompt kills the
 * run before the CLI starts. That is reachable through ordinary context — an
 * actor discussing or repairing a file that holds a stray NUL byte puts the byte
 * straight into its next prompt — so the text is repaired at the point it enters
 * argv rather than letting a normal run die at the launch (#206).
 *
 * ONLY assembled text goes through here. Everything else a provider puts in
 * argv is a configured value or a host path — the CLI's own executable, and
 * under `bwrap` every bind and `--chdir` operand as well — where substituting a
 * character would name a *different* path and launch it. A NUL in one of those
 * is a configuration fault: it reaches `spawn` untouched and is reported by
 * {@link runSubprocess} instead of repaired.
 */

/** What a NUL becomes in assembled text: U+FFFD REPLACEMENT CHARACTER. */
export const ARGV_NUL_REPLACEMENT = "\uFFFD";

/**
 * Make one piece of assembled text — a prompt, a charter — spawnable.
 *
 * Deterministic and character-for-character: the surrounding text is delivered
 * intact, so the agent sees one damaged character where the byte was instead of
 * a silently truncated prompt. Anything else the process API accepts is left
 * exactly as assembled — this is not general binary normalization.
 */
export function sanitizeArgvText(value: string): string {
  return value.includes("\0") ? value.replaceAll("\0", ARGV_NUL_REPLACEMENT) : value;
}
