import { isHumanOperator } from "../mcp/stamp.js";
import type { InboxEntry } from "./inbox-store.js";

/**
 * An inbox entry enriched with an optional run-scoped handling hint.
 * Returned to actors at selection time by the inbox MCP server.
 */
export interface SelectedInboxEntry extends InboxEntry {
  hint?: string;
}

function extractThreadId(threadName: string): string | undefined {
  const trimmed = threadName.trim();
  const match = /\/threads\/([^/]+)$/.exec(trimmed);
  return match ? match[1] : trimmed.includes("/") ? undefined : trimmed;
}

function extractMessageId(messageName: string): string | undefined {
  const trimmed = messageName.trim();
  const match = /\/messages\/([^/]+)$/.exec(trimmed);
  return match ? match[1] : trimmed.includes("/") ? undefined : trimmed;
}

/**
 * Checks whether a Google Chat message is the HEAD of its thread (i.e. top-level).
 * Google Chat creates an implicit thread for every message, giving head messages
 * a message resource name of the form `spaces/S/messages/M.M` or `spaces/S/messages/M`
 * matching the thread resource name `spaces/S/threads/M`.
 */
export function isGchatThreadHead(messageName?: string, threadName?: string): boolean {
  if (!messageName || !threadName) return false;
  const threadId = extractThreadId(threadName);
  const messageId = extractMessageId(messageName);
  if (!threadId || !messageId) return false;
  return messageId === threadId || messageId === `${threadId}.${threadId}`;
}

/**
 * Resolve a concise handling hint for an inbox entry based on its source and payload.
 * Returns undefined when no special handling reminder is needed.
 */
export function resolveInboxHint(entry: InboxEntry): string | undefined {
  const { source, payload } = entry;
  const fromId = typeof payload.fromId === "string" ? payload.fromId : undefined;

  // an issue: Human operator message cue
  if (
    payload.type === "human.message" ||
    payload.type === "human.voice" ||
    (fromId !== undefined && isHumanOperator(fromId)) ||
    source === "mesh:human" ||
    source.startsWith("mesh:human:")
  ) {
    return "This is a message from the human operator. Reply directly to the human operator using your reply tool or mesh chat.";
  }

  // an issue, ISSUE_NUM: Google Chat threading guidance
  if (payload.type === "gchat.message" || source.startsWith("chat_space:")) {
    const threadName =
      typeof payload.threadName === "string" && payload.threadName.trim().length > 0
        ? payload.threadName.trim()
        : undefined;
    const messageName =
      typeof payload.messageName === "string" && payload.messageName.trim().length > 0
        ? payload.messageName.trim()
        : undefined;
    const spaceName =
      typeof payload.spaceName === "string" && payload.spaceName.trim().length > 0
        ? payload.spaceName.trim()
        : undefined;

    // threadName has the form spaces/SPACE/threads/THREAD, so the space can be
    // recovered from it when the payload didn't carry spaceName separately.
    const effectiveSpace =
      spaceName ??
      (threadName?.includes("/threads/") ? threadName.split("/threads/")[0] : undefined);

    // Google Chat gives every message a threadName, including one that heads no
    // thread yet, so its presence alone does not mean "this message is in a
    // thread" -- reading it that way makes a reply open a thread underneath a
    // standalone message. The id comparison below is what separates the two, and
    // the hints say so explicitly because the two payloads look alike.
    const isThreadHead = isGchatThreadHead(messageName, threadName);

    if (threadName && !isThreadHead) {
      const confirmation = messageName
        ? ` You can confirm this one from the payload alone — messageName is '${messageName}', whose message id differs from its thread id, making this a reply inside an existing thread.`
        : "";
      return `This Google Chat message is in thread '${threadName}'.${confirmation} Reply inside this thread with the chat-write 'send_message' tool, passing spaceName '${effectiveSpace ?? "<the space from threadName>"}' and threadName '${threadName}' (threadName must belong to spaceName).`;
    }

    if (isThreadHead) {
      if (effectiveSpace) {
        return `This Google Chat message is at top-level in '${effectiveSpace}' (not in a thread) — in the UI it appears as a standalone message, and a thread only comes into being if someone replies to it. It still carries a threadName: in Google Chat every message has one, and on a top-level message that id is the handle you would use to start a thread here, not a sign that a thread already exists. You can confirm this one from the payload alone — messageName is '${messageName}', whose message id equals its thread id, the signature of a message heading its own as-yet-empty thread. Reply with the chat-write 'send_message' tool, passing spaceName '${effectiveSpace}' and omitting threadName, unless the message explicitly requests creating a new thread.`;
      }
      return `This Google Chat message is at top-level (not in a thread) — in the UI it appears as a standalone message, and a thread only comes into being if someone replies to it. It still carries a threadName: in Google Chat every message has one, and on a top-level message that id is the handle you would use to start a thread here, not a sign that a thread already exists. You can confirm this one from the payload alone — messageName is '${messageName}', whose message id equals its thread id, the signature of a message heading its own as-yet-empty thread. Reply with the chat-write 'send_message' tool, passing the message's spaceName and omitting threadName, unless the message explicitly requests creating a new thread.`;
    }

    if (effectiveSpace) {
      return `This Google Chat message is at top-level in '${effectiveSpace}' (not in a thread). Reply with the chat-write 'send_message' tool, passing spaceName '${effectiveSpace}' and omitting threadName, unless the message explicitly requests creating a new thread.`;
    }
    return "This Google Chat message is at top-level (not in a thread). Reply with the chat-write 'send_message' tool, passing the message's spaceName and omitting threadName, unless the message explicitly requests creating a new thread.";
  }

  return undefined;
}

/**
 * Enriches a list of inbox entries with handling hints.
 */
export function attachInboxHints(entries: InboxEntry[]): SelectedInboxEntry[] {
  return entries.map((entry) => {
    const hint = resolveInboxHint(entry);
    return hint !== undefined ? { ...entry, hint } : { ...entry };
  });
}
