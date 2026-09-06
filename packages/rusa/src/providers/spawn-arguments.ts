/**
 * Launch-boundary safety for the argv a provider CLI is spawned with.
 *
 * Node validates argv synchronously: `child_process.spawn` throws
 * `ERR_INVALID_ARG_VALUE` ("must be a string without null bytes") before any
 * child exists, so one literal NUL anywhere in the assembled prompt kills the
 * run before the CLI starts. That is reachable through ordinary context — an
 * actor discussing or repairing a file that holds a stray NUL byte puts the byte
 * straight into its next prompt — so the boundary replaces the character rather
 * than letting a normal run die at the launch (#206).
 */

/** What a NUL becomes in argv: U+FFFD REPLACEMENT CHARACTER. */
export const ARGV_NUL_REPLACEMENT = "\uFFFD";

/** `Error.name` carried by the run error a synchronous spawn rejection becomes. */
export const SPAWN_ARGUMENT_ERROR_NAME = "SpawnArgumentError";

/**
 * Replace every NUL in one argv value with {@link ARGV_NUL_REPLACEMENT}.
 *
 * Deterministic and character-for-character: the surrounding text is delivered
 * intact, so the agent sees one damaged character where the byte was instead of
 * a silently truncated prompt. Anything else the process API accepts is left
 * exactly as assembled — this is not general binary normalization.
 */
export function sanitizeArgvValue(value: string): string {
  return value.includes("\0") ? value.replaceAll("\0", ARGV_NUL_REPLACEMENT) : value;
}

/** Apply {@link sanitizeArgvValue} to a whole argv vector. */
export function sanitizeArgv(args: readonly string[]): string[] {
  return args.map(sanitizeArgvValue);
}

/**
 * A synchronous spawn/argument-validation rejection, reduced to what is safe to
 * put in a run record.
 *
 * Node's own message quotes the rejected value (up to 128 inspected characters)
 * and its stack repeats it, so for a provider launch the raw error is a verbatim
 * slice of the prompt. Only the actionable identifiers survive here: the error
 * class and its code. The original is deliberately NOT attached as `cause`
 * either — a serializer that walks the cause chain would put the quoted value
 * straight back into the record.
 */
export class SpawnArgumentError extends Error {
  /** Constructor name of the rejection (e.g. `TypeError`). */
  readonly errorClass: string;
  /** Node's stable error code (e.g. `ERR_INVALID_ARG_VALUE`), when it had one. */
  readonly code?: string;

  constructor(errorClass: string, code?: string) {
    super(
      "process-argument validation rejected this launch before the CLI started " +
        `(${code ? `${errorClass} [${code}]` : errorClass}); argument values withheld`
    );
    this.name = SPAWN_ARGUMENT_ERROR_NAME;
    this.errorClass = errorClass;
    this.code = code;
  }
}

/**
 * Reduce whatever `spawn` threw to a {@link SpawnArgumentError}. Total: an
 * unrecognizable throw still yields a named error rather than escaping into the
 * generic terminal-failure path, where its stack — argv and all — would become
 * the run's output.
 */
export function toSpawnArgumentError(err: unknown): SpawnArgumentError {
  if (err instanceof SpawnArgumentError) return err;
  const errorClass = err instanceof Error ? err.name : typeof err;
  const code = (err as { code?: unknown } | null)?.code;
  return new SpawnArgumentError(errorClass, typeof code === "string" ? code : undefined);
}
