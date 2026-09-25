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
export const CHAT_WAKE_MODES = ["mentions", "all"] as const;
export type ChatWakeMode = (typeof CHAT_WAKE_MODES)[number];

/** One stored per-space choice, keyed by the canonical `gchat:spaces/<id>` resource. */
export interface ChatWakeModeSetting {
  resource: string;
  mode: ChatWakeMode;
}

/** What an owner reads back: `mode: null` means no mode is stored and the default applies. */
export interface ChatWakeModeView {
  resource: string;
  mode: ChatWakeMode | null;
}

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

/**
 * Durable per-space wake modes. SQLite in production
 * (`DbChatWakeModeStore`), in-memory for tests. Authority lives in the mesh,
 * never in the store: the store records whatever the mesh already accepted.
 */
export interface ChatWakeModeStore {
  get(resource: string): ChatWakeModeSetting | undefined;
  set(setting: ChatWakeModeSetting): void;
  /** Remove the stored mode so the space falls back to the built-in default. */
  clear(resource: string): void;
}

export class InMemoryChatWakeModeStore implements ChatWakeModeStore {
  private readonly settings = new Map<string, ChatWakeModeSetting>();

  get(resource: string): ChatWakeModeSetting | undefined {
    const setting = this.settings.get(resource);
    return setting ? { ...setting } : undefined;
  }

  set(setting: ChatWakeModeSetting): void {
    this.settings.set(setting.resource, { ...setting });
  }

  clear(resource: string): void {
    this.settings.delete(resource);
  }
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
