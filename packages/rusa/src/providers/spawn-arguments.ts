/**
 * Launch-boundary safety for the assembled text a provider CLI is spawned with.
 *
 * Node validates argv synchronously: `child_process.spawn` throws
 * `ERR_INVALID_ARG_VALUE` ("must be a string without null bytes") before any
 * child exists, so one literal NUL anywhere in the assembled prompt kills the
 * run before the CLI starts. That is not hypothetical: a worker run was observed
 * dying exactly this way, the rejected argv element carrying assembled charter
 * text. Where the byte came from upstream was never established, so the repair
 * is placed at the point assembled text enters argv — the boundary that is known
 * to be crossed — rather than at a guessed source (#206).
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
