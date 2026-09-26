import { parseReference } from "../references/reference.js";
import type { ChatMessage } from "./types.js";

/**
 * How a Google Chat space wakes its event-source owner (#692).
 *
 * - `mentions`: only a message that @mentions the Rusa user wakes.
 * - `all`: every message wakes.
 *
 * A space with no stored mode keeps the built-in default: a direct message or
 * a two-person space wakes on every message, and any larger space wakes only on
 * mentions. The default is derived per message rather than written down, so
 * spaces that existed before the setting did keep exactly the behavior they had.
 */
export type ChatWakeMode = "mentions" | "all";

/**
 * The canonical `gchat:spaces/<id>` resource for one Google Chat space, from
 * either that reference or a bare `spaces/<id>` name as the Chat API spells it.
 * Anything wider or narrower than a single space — `gchat:spaces`, a thread, a
 * message — is refused: the mode is a property of a space.
 */
export function chatSpaceResource(space: string): string {
  const trimmed = space.trim();
  // Anything already carrying a scheme is parsed as given, so another
  // source's reference is refused rather than nested under spaces/.
  const candidate = trimmed.includes(":")
    ? trimmed
    : `gchat:${trimmed.startsWith("spaces/") ? trimmed : `spaces/${trimmed}`}`;
  const notOneSpace = () =>
    new Error(`a chat wake mode applies to one space (gchat:spaces/<id>), not ${trimmed}`);
  let ref: ReturnType<typeof parseReference>;
  try {
    ref = parseReference(candidate);
  } catch {
    throw notOneSpace();
  }
  if (ref.scheme !== "gchat" || ref.segments.length !== 2 || ref.segments[0] !== "spaces") {
    throw notOneSpace();
  }
  return ref.key;
}

/**
 * Try to resolve a space string into a canonical `gchat:spaces/<id>` resource.
 * Returns `undefined` if the input is malformed, empty, or does not name
 * exactly one space, rather than throwing.
 *
 * Used by inbound ingestion where unexpected inputs must not abort processing,
 * while {@link chatSpaceResource} remains strict for owner-facing tools (#695).
 */
export function tryChatSpaceResource(space: string): string | undefined {
  if (typeof space !== "string" || !space.trim()) return undefined;
  try {
    return chatSpaceResource(space);
  } catch {
    return undefined;
  }
}

type EventSourceConfigV1 = Record<string, unknown> & {
  version: 1;
  chatWakeMode?: ChatWakeMode;
};

function parseEventSourceConfigV1(raw: string | null): EventSourceConfigV1 | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      return undefined;
    }
    const chatWakeMode = (parsed as { chatWakeMode?: unknown }).chatWakeMode;
    if (chatWakeMode !== undefined && chatWakeMode !== "mentions" && chatWakeMode !== "all") {
      return undefined;
    }
    return parsed as EventSourceConfigV1;
  } catch {
    return undefined;
  }
}

/** Read this feature's value from the event source's versioned generic config blob. */
export function chatWakeModeFromConfig(raw: string | null | undefined): ChatWakeMode | undefined {
  return raw === undefined ? undefined : parseEventSourceConfigV1(raw)?.chatWakeMode;
}

/** The mode a space behaves as when none is stored, from what the message says about its space. */
export function defaultChatWakeMode(msg: Pick<ChatMessage, "isDirectMessage">): ChatWakeMode {
  return msg.isDirectMessage ? "all" : "mentions";
}

/** Whether an arriving message wakes the space's owner under `mode` (or the default when unset). */
export function chatMessageWakes(
  msg: Pick<ChatMessage, "isDirectMessage" | "mentionsSelf">,
  mode: ChatWakeMode | undefined
): boolean {
  return (mode ?? defaultChatWakeMode(msg)) === "all" || msg.mentionsSelf;
}
