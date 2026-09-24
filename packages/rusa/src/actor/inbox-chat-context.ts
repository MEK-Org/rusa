import type { ChatClient, ChatReadMessage } from "../chat/types.js";
import type { MeshChat } from "../db/repositories/mesh-chat-repository.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import { VOICE_INBOX_PAYLOAD_TYPE } from "../runtime/run-manager.js";
import type { SlackClient } from "../slack/slack-client.js";
import { isGchatThreadHead, type SelectedInboxEntry } from "./inbox-hints.js";

/** How many of the most recent messages a chat selection carries (#651). */
export const CHAT_CONTEXT_MESSAGE_LIMIT = 10;
/**
 * Byte ceiling for one window, measured over each message's JSON form. Ten
 * top-level messages in a busy space measured about 8.6 KB with envelopes, so
 * this only bites when a few messages are very long.
 */
export const CHAT_CONTEXT_MAX_BYTES = 64 * 1024;
/** Top-level Google Chat messages are found by scanning the space newest first. */
export const GCHAT_TOP_LEVEL_SCAN_LIMIT = 300;
/** A slow chat backend must not hold the selection open. */
export const CHAT_CONTEXT_TIMEOUT_MS = 10_000;

/** One literal chat message. Ids let the actor page further back with the read tools. */
export interface ChatContextMessage {
  messageId: string;
  threadId?: string;
  sender: string;
  senderDisplayName?: string;
  timestamp: string;
  text: string;
  /** Set on the message this inbox entry refers to, when it falls inside the window. */
  selected?: true;
  /** Set when the only remaining message alone exceeded the byte ceiling. */
  textTruncated?: true;
}

export interface ChatContextWindow {
  source: "gchat" | "slack" | "mesh";
  /** `thread`: that thread's tail. `top_level`: the space/channel's top-level messages. `conversation`: the pairwise mesh conversation. */
  scope: "thread" | "top_level" | "conversation";
  /** Oldest first, ending at the newest message at selection time. */
  messages: ChatContextMessage[];
  /** Messages dropped, oldest first, to fit CHAT_CONTEXT_MAX_BYTES. */
  omittedForBytes?: number;
}

export interface InboxChatContextSources {
  chatClient?: Pick<ChatClient, "listMessages">;
  slackClient?: Pick<SlackClient, "listRecentMessages">;
  meshChat?: {
    listForActor: (actorId: string, opts?: { peerId?: string; limit?: number }) => MeshChat[];
  };
}

export interface ChatContextBounds {
  limit: number;
  maxBytes: number;
}

const DEFAULT_BOUNDS: ChatContextBounds = {
  limit: CHAT_CONTEXT_MESSAGE_LIMIT,
  maxBytes: CHAT_CONTEXT_MAX_BYTES,
};

const MESH_CHAT_PAYLOAD_TYPES = new Set([
  "mesh.message",
  "human.message",
  VOICE_INBOX_PAYLOAD_TYPE,
]);

interface ChatContextTarget {
  /** Entries sharing a key share one window. */
  key: string;
  selectedMessageId?: string;
  load: (
    sources: InboxChatContextSources,
    limit: number
  ) => Promise<Omit<ChatContextWindow, "omittedForBytes">>;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function fromGchat(message: ChatReadMessage): ChatContextMessage {
  return {
    messageId: message.name,
    ...(message.thread?.name ? { threadId: message.thread.name } : {}),
    sender: message.sender?.name ?? "unknown",
    ...(message.sender?.displayName ? { senderDisplayName: message.sender.displayName } : {}),
    timestamp: message.createTime ?? "",
    text: message.text ?? "",
  };
}

/** Which conversation an entry belongs to, or undefined for a non-chat entry. */
function chatContextTarget(entry: InboxEntry, actorId: string): ChatContextTarget | undefined {
  const { source, payload } = entry;

  if (payload.type === "gchat.message" || source.startsWith("chat_space:")) {
    const messageName = nonEmpty(payload.messageName);
    const threadName = nonEmpty(payload.threadName);
    const spaceName =
      nonEmpty(payload.spaceName) ??
      (threadName?.includes("/threads/") ? threadName.split("/threads/")[0] : undefined);
    if (!spaceName) return undefined;
    const space = spaceName.startsWith("spaces/") ? spaceName : `spaces/${spaceName}`;
    // Same test the reply hint uses: every Google Chat message carries a
    // threadName, so only a message id that differs from its thread id is a reply.
    if (threadName && !isGchatThreadHead(messageName, threadName)) {
      return {
        key: `gchat:${threadName}`,
        selectedMessageId: messageName,
        load: async ({ chatClient }, limit) => {
          if (!chatClient) throw new Error("Google Chat is not configured on this instance");
          const page = await chatClient.listMessages(space, {
            threadName,
            orderBy: "DESC",
            pageSize: limit,
          });
          return {
            source: "gchat",
            scope: "thread",
            messages: page.messages.slice(0, limit).reverse().map(fromGchat),
          };
        },
      };
    }
    return {
      key: `gchat:${space}:top_level`,
      selectedMessageId: messageName,
      load: async ({ chatClient }, limit) => {
        if (!chatClient) throw new Error("Google Chat is not configured on this instance");
        const heads: ChatReadMessage[] = [];
        let scanned = 0;
        let pageToken: string | undefined;
        do {
          const page = await chatClient.listMessages(space, {
            orderBy: "DESC",
            pageSize: 100,
            ...(pageToken ? { pageToken } : {}),
          });
          scanned += page.messages.length;
          for (const message of page.messages) {
            if (isGchatThreadHead(message.name, message.thread?.name)) heads.push(message);
          }
          pageToken = page.nextPageToken;
        } while (pageToken && heads.length < limit && scanned < GCHAT_TOP_LEVEL_SCAN_LIMIT);
        return {
          source: "gchat",
          scope: "top_level",
          messages: heads.slice(0, limit).reverse().map(fromGchat),
        };
      },
    };
  }

  if (payload.type === "slack.message") {
    const channel = nonEmpty(payload.channel);
    const ts = nonEmpty(payload.ts);
    if (!channel) return undefined;
    const threadTs = nonEmpty(payload.threadTs);
    const inThread = threadTs !== undefined && threadTs !== ts;
    return {
      key: inThread ? `slack:${channel}:${threadTs}` : `slack:${channel}:top_level`,
      selectedMessageId: ts,
      load: async ({ slackClient }, limit) => {
        if (!slackClient) throw new Error("Slack is not configured on this instance");
        const messages = await slackClient.listRecentMessages(channel, {
          ...(inThread ? { threadTs } : {}),
          limit,
        });
        return {
          source: "slack",
          scope: inThread ? "thread" : "top_level",
          messages: messages.map((m) => ({
            messageId: m.ts,
            ...(m.threadTs ? { threadId: m.threadTs } : {}),
            sender: m.user ?? "unknown",
            timestamp: m.ts,
            text: m.text,
          })),
        };
      },
    };
  }

  if (MESH_CHAT_PAYLOAD_TYPES.has(String(payload.type)) && source.startsWith("mesh:")) {
    const peerId = nonEmpty(payload.fromId);
    if (!peerId) return undefined;
    return {
      key: `mesh:${peerId}`,
      selectedMessageId: nonEmpty(payload.messageId),
      load: async ({ meshChat }, limit) => {
        if (!meshChat) throw new Error("mesh chat storage is unavailable");
        const rows = meshChat.listForActor(actorId, { peerId, limit });
        return {
          source: "mesh",
          scope: "conversation",
          messages: rows.reverse().map((row) => ({
            messageId: row.id,
            sender: row.senderId,
            timestamp: row.ts,
            text: row.body,
          })),
        };
      },
    };
  }

  return undefined;
}

function byteLength(message: ChatContextMessage): number {
  return Buffer.byteLength(JSON.stringify(message), "utf8");
}

/**
 * Keep the newest `limit` messages, then drop the oldest until the window fits
 * `maxBytes`. When one message alone is over the ceiling, its text is cut to
 * fit rather than returning an empty window.
 */
export function boundChatContext(
  messages: readonly ChatContextMessage[],
  bounds: ChatContextBounds = DEFAULT_BOUNDS
): { messages: ChatContextMessage[]; omittedForBytes: number } {
  const kept = messages.slice(-bounds.limit);
  const sizes = kept.map(byteLength);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  let omittedForBytes = 0;
  while (kept.length > 1 && total > bounds.maxBytes) {
    total -= sizes.shift() ?? 0;
    kept.shift();
    omittedForBytes++;
  }
  const only = kept[0];
  if (kept.length === 1 && only && total > bounds.maxBytes) {
    const textBudget = Math.max(
      0,
      bounds.maxBytes - byteLength({ ...only, text: "", textTruncated: true })
    );
    const cut = Buffer.from(only.text, "utf8")
      .subarray(0, textBudget)
      .toString("utf8")
      .replace(/�$/, "");
    kept[0] = { ...only, text: cut, textTruncated: true };
  }
  return { messages: kept, omittedForBytes };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`chat context timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Attach the recent conversation around each selected chat entry (#651): a
 * thread's tail, the space/channel's top-level messages, or the pairwise mesh
 * conversation, both sides, literal. Non-chat entries pass through unchanged.
 * Entries in the same conversation share one fetch; later ones point at the
 * first. A failed fetch is reported on the entry and never fails the selection,
 * which has already committed.
 */
export async function attachChatContext(
  entries: SelectedInboxEntry[],
  actorId: string,
  sources: InboxChatContextSources,
  bounds: ChatContextBounds = DEFAULT_BOUNDS,
  timeoutMs: number = CHAT_CONTEXT_TIMEOUT_MS
): Promise<SelectedInboxEntry[]> {
  const firstEntryByKey = new Map<string, string>();
  const result: SelectedInboxEntry[] = [];
  for (const entry of entries) {
    const target = chatContextTarget(entry, actorId);
    if (!target) {
      result.push(entry);
      continue;
    }
    const first = firstEntryByKey.get(target.key);
    if (first !== undefined) {
      result.push({ ...entry, chatContext: { sameAsEntryId: first } });
      continue;
    }
    firstEntryByKey.set(target.key, entry.id);
    try {
      const window = await withTimeout(target.load(sources, bounds.limit), timeoutMs);
      const bounded = boundChatContext(window.messages, bounds);
      const messages = bounded.messages.map((message) =>
        message.messageId === target.selectedMessageId
          ? { ...message, selected: true as const }
          : message
      );
      result.push({
        ...entry,
        chatContext: {
          ...window,
          messages,
          ...(bounded.omittedForBytes > 0 ? { omittedForBytes: bounded.omittedForBytes } : {}),
        },
      });
    } catch (err) {
      result.push({
        ...entry,
        chatContextError: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
