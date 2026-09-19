import type { RusaConfig } from "../config/types.js";
import { parseReference } from "../references/reference.js";

export type WritableErrorSource =
  | { ref: string; kind: "gchat"; target: string }
  | { ref: string; kind: "slack"; target: string };

/** Resolve the preferred event-source reference, retaining the old Chat setting during migration. */
export function configuredErrorSource(config: RusaConfig): string | undefined {
  const configured = config.observability?.errorSource;
  if (configured !== undefined && (typeof configured !== "string" || !configured.trim())) {
    throw new Error("observability.errorSource must be a non-empty event source reference");
  }
  const preferred = configured?.trim();
  const oldSpace = config.chat?.errorChat;
  if (oldSpace !== undefined && (typeof oldSpace !== "string" || !oldSpace.trim())) {
    throw new Error("chat.errorChat must be a non-empty Google Chat space name");
  }
  const legacy = oldSpace ? `gchat:${oldSpace.trim()}` : undefined;
  if (preferred && legacy && preferred !== legacy) {
    throw new Error("observability.errorSource conflicts with deprecated chat.errorChat");
  }
  return preferred ?? legacy;
}

/** The error destination must be a concrete, configured event source with an outbound writer. */
export function resolveWritableErrorSource(config: RusaConfig): WritableErrorSource | null {
  const ref = configuredErrorSource(config);
  if (!ref) return null;
  const parsed = parseReference(ref);
  const [collection, target] = parsed.segments;
  if (!target || parsed.segments.length !== 2) {
    throw new Error(`error source must name a concrete writable event source: ${ref}`);
  }
  if (parsed.scheme === "gchat" && collection === "spaces" && config.chat) {
    return { ref, kind: "gchat", target: `spaces/${target}` };
  }
  if (parsed.scheme === "slack" && collection === "channels" && config.slack) {
    return { ref, kind: "slack", target };
  }
  throw new Error(`error source has no configured writer: ${ref}`);
}
