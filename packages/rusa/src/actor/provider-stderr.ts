import type { RunResult } from "../providers/types.js";
import { sanitizeFailureText } from "./failure-sink.js";

/** Maximum raw provider stderr retained for one execution attempt. */
export const PROVIDER_STDERR_MAX_CHARS = 8_000;
const STDERR_HEAD_CHARS = PROVIDER_STDERR_MAX_CHARS / 2;
const STDERR_TAIL_CHARS = PROVIDER_STDERR_MAX_CHARS / 2;

/**
 * A bounded streaming capture that retains both the opening diagnostic and the
 * terminal error. Keeping both matters for CLIs that prefix a provider error
 * with a request id and only explain the actual failure at the end.
 */
export class ProviderStderrCapture {
  private totalChars = 0;
  private head = "";
  private tail = "";

  append(chunk: string): void {
    if (!chunk) return;
    this.totalChars += chunk.length;
    if (this.head.length < STDERR_HEAD_CHARS) {
      this.head += chunk.slice(0, STDERR_HEAD_CHARS - this.head.length);
    }
    this.tail = `${this.tail}${chunk}`.slice(-STDERR_TAIL_CHARS);
  }

  render(): string {
    if (this.totalChars === 0) return "";
    const captured =
      this.totalChars <= PROVIDER_STDERR_MAX_CHARS
        ? this.head
        : `${this.head}\n… [provider stderr truncated]\n${this.tail}`;
    return sanitizeProviderStderr(captured);
  }
}

/**
 * Provider stderr is untrusted process output. Keep useful error text while
 * removing common credential forms before it becomes durable actor history.
 */
export function sanitizeProviderStderr(stderr: string): string {
  return sanitizeFailureText(stderr)
    .replace(/\b(authorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(
      /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]"
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|token|secret|password)=)[^&#\s]+/gi,
      "$1[redacted]"
    );
}

/**
 * Successful output remains exactly provider-owned. Failed subprocess exits
 * gain a clearly delimited, sanitized diagnostic in the existing bounded run
 * output field, avoiding a second persistence schema.
 */
export function appendFailedProviderStderr(result: RunResult, stderr: string): RunResult {
  if (result.success || result.exitCode === 0 || !stderr) return result;
  return {
    ...result,
    output: [result.output, "--- provider stderr (sanitized) ---", stderr]
      .filter((part) => part.length > 0)
      .join("\n\n"),
  };
}
