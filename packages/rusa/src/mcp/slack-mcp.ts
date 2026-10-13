import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Logger } from "../observability/logger.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import {
  MAX_SLACK_FILE_BYTES,
  MAX_SLACK_HISTORY_PAGE,
  SLACK_CONVERSATION_TYPES,
  type SlackClient,
  type SlackConversationType,
  type SlackHistoryQuery,
} from "../slack/slack-client.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";
import {
  readBoundedRegularFile,
  resolveAttachmentPath,
  resolveDownloadPath,
  writeNewFileInWorkdir,
} from "./workdir-path.js";

export const SLACK_READ_MCP_NAME = "slack-read";
export const SLACK_WRITE_MCP_NAME = "slack-write";

export interface SlackMcpOptions {
  /** The calling actor's workdir; file uploads read from and downloads write into it. */
  workDir?: string;
  /** Rechecked when a file tool is called, because follower placement can change live. */
  fileToolsAvailable?: () => boolean;
  maxFileBytes?: number;
}

export interface SlackWriteMcpOptions extends SlackMcpOptions {
  /**
   * Called once Slack has accepted a write, so the run that made it is protected
   * from coalescing abort and is not repeated by a replacement run.
   */
  onWrite?: () => void;
  /** Currently selected inbox entries for this run; they decide reply placement (#1034). */
  selectedInboxEntries?: () => readonly InboxEntry[];
  /** Optional structured logger for reply routing diagnostics. */
  logger?: Logger;
}

function requireWorkDir(options: SlackMcpOptions): string {
  if (!options.workDir) throw new Error("Slack file tools need an actor workdir");
  return options.workDir;
}

function requireFileToolsAvailable(options: SlackMcpOptions): void {
  if (options.fileToolsAvailable?.() === false) {
    throw new Error("Slack file tools are unavailable for follower-hosted actors (see #812)");
  }
}

const SLACK_TS = /^\d{1,12}(\.\d{1,6})?$/;
const ISO_INSTANT =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Milliseconds for an ISO-8601 instant, or NaN. `Date.parse` rolls an
 * impossible calendar date such as 30 February into the next month, so the
 * wall-clock fields must read back unchanged.
 */
function isoInstantMs(value: string): number {
  const match = ISO_INSTANT.exec(value);
  if (!match) return Number.NaN;
  const wall = `${match[1]}T${match[2]}:${match[3] ?? "00"}`;
  if (new Date(`${wall}Z`).toISOString().slice(0, 19) !== wall) return Number.NaN;
  return Date.parse(value);
}

/**
 * A history bound as Slack expects it: seconds since the epoch with up to six
 * decimals. Accepts a Slack message timestamp as-is, or an ISO-8601 instant
 * with an explicit offset so a date range never depends on the host's zone.
 */
export function toSlackTimestamp(value: string, field: string): string {
  if (SLACK_TS.test(value)) return value;
  const ms = isoInstantMs(value);
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(
      `${field} must be a Slack timestamp (e.g. 1712345678.000100) or an ISO-8601 instant with an offset (e.g. 2026-10-13T00:00:00Z)`
    );
  }
  return (ms / 1000).toFixed(6);
}

const historyBoundsSchema = {
  oldest: z
    .string()
    .optional()
    .describe(
      "Only messages after this time: a Slack timestamp or ISO-8601 instant with offset (exclusive unless inclusive)"
    ),
  latest: z
    .string()
    .optional()
    .describe(
      "Only messages before this time: a Slack timestamp or ISO-8601 instant with offset (exclusive unless inclusive); defaults to now"
    ),
  inclusive: z.boolean().optional().describe("Include messages exactly at oldest or latest"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SLACK_HISTORY_PAGE)
    .optional()
    .describe(`Page size, at most ${MAX_SLACK_HISTORY_PAGE} (default 50)`),
  cursor: z
    .string()
    .optional()
    .describe("nextCursor from the previous page; keep the same channel, thread and bounds"),
};

function historyQuery(input: {
  oldest?: string | undefined;
  latest?: string | undefined;
  inclusive?: boolean | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}): SlackHistoryQuery {
  const oldest = input.oldest ? toSlackTimestamp(input.oldest, "oldest") : undefined;
  const latest = input.latest ? toSlackTimestamp(input.latest, "latest") : undefined;
  if (oldest && latest && Number(oldest) > Number(latest)) {
    throw new Error("oldest must not be after latest");
  }
  return {
    limit: input.limit ?? 50,
    ...(oldest ? { oldest } : {}),
    ...(latest ? { latest } : {}),
    ...(input.inclusive ? { inclusive: true } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}

export function createSlackReadMcpServer(
  client: SlackClient,
  options: SlackMcpOptions = {}
): McpServer {
  const server = createMcpServer({ name: SLACK_READ_MCP_NAME, version: "0.1.0" });
  server.registerTool(
    "get_message",
    {
      title: "Read a Slack message",
      description:
        "Read a Slack message by channel ID and timestamp, including metadata for any attached files.",
      inputSchema: { channel: z.string(), ts: z.string() },
    },
    async ({ channel, ts }) => {
      try {
        return toolOk(await client.getMessage(channel, ts));
      } catch (err) {
        return toolError(err);
      }
    }
  );
  server.registerTool(
    "get_channel",
    {
      title: "Read a Slack channel",
      description: "Read a Slack channel by ID.",
      inputSchema: { channel: z.string() },
    },
    async ({ channel }) => {
      try {
        return toolOk(await client.getChannel(channel));
      } catch (err) {
        return toolError(err);
      }
    }
  );
  server.registerTool(
    "list_conversations",
    {
      title: "List Slack conversations",
      description:
        "Discover public and private channels this Slack token can see, one page per call, with each one's ID, name, type and, where Slack reports it, whether the app is a member. DMs and group DMs are not listed; read one whose ID you already have with the history tools. Slack lists private channels only where the app is a member, so even a full walk is not a complete workspace inventory. Pass nextCursor back with the same types until it is absent; a page can be short or empty while more remain. Each type needs its read scope (channels:read for public channels, groups:read for private ones). Slack may leave out a type the token has no scope for, or refuse the call with an error, so a page without a type does not show there are none.",
      inputSchema: {
        types: z
          .array(z.enum(SLACK_CONVERSATION_TYPES))
          .min(1)
          .optional()
          .describe("Conversation types to list (default public_channel)"),
        excludeArchived: z
          .boolean()
          .optional()
          .describe("Leave out archived conversations (default true)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SLACK_HISTORY_PAGE)
          .optional()
          .describe(`Page size, at most ${MAX_SLACK_HISTORY_PAGE} (default 100)`),
        cursor: z
          .string()
          .optional()
          .describe("nextCursor from the previous page; keep the same types and archive filter"),
      },
    },
    async ({ types, excludeArchived, limit, cursor }) => {
      try {
        return toolOk(
          await client.listConversations({
            types: [...new Set<SlackConversationType>(types ?? ["public_channel"])],
            excludeArchived: excludeArchived ?? true,
            limit: limit ?? 100,
            ...(cursor ? { cursor } : {}),
          })
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );
  server.registerTool(
    "list_channel_history",
    {
      title: "List a page of Slack channel history",
      description:
        "Read one page of a conversation's messages, newest first, optionally between oldest and latest. Thread replies appear only when broadcast to the channel; a thread parent carries replyCount, so read the thread with list_thread_replies. To walk a date range, set oldest and latest and pass each page's nextCursor back until it is absent. Needs the history scope for the conversation type (channels:history, groups:history, im:history or mpim:history); Slack answers not_in_channel when the app has not been added to the conversation.",
      inputSchema: {
        channel: z.string().describe("Conversation ID, e.g. C0123"),
        ...historyBoundsSchema,
      },
    },
    async ({ channel, ...bounds }) => {
      try {
        return toolOk(await client.listHistory(channel, historyQuery(bounds)));
      } catch (err) {
        return toolError(err);
      }
    }
  );
  server.registerTool(
    "list_thread_replies",
    {
      title: "List a page of Slack thread replies",
      description:
        "Read one page of the thread rooted at threadTs, oldest first, optionally between oldest and latest. Slack may include the parent message (its ts equals threadTs). Pass each page's nextCursor back until it is absent to walk the thread. Needs the same history scope and conversation access as list_channel_history.",
      inputSchema: {
        channel: z.string().describe("Conversation ID, e.g. C0123"),
        threadTs: z.string().describe("Timestamp of the thread's parent message"),
        ...historyBoundsSchema,
      },
    },
    async ({ channel, threadTs, ...bounds }) => {
      try {
        if (!SLACK_TS.test(threadTs)) {
          throw new Error("threadTs must be a Slack message timestamp, e.g. 1712345678.000100");
        }
        return toolOk(await client.listThreadReplies(channel, threadTs, historyQuery(bounds)));
      } catch (err) {
        return toolError(err);
      }
    }
  );
  server.registerTool(
    "download_file",
    {
      title: "Download a file attached to a Slack message",
      description:
        "Save a file attached to the message at channel/ts into your working directory. The destination must not already exist; its directory must. Unavailable for follower-hosted actors (see #812).",
      inputSchema: {
        channel: z.string(),
        ts: z.string().describe("Timestamp of the message the file is attached to"),
        fileId: z.string().describe("File ID from get_message's files"),
        destinationPath: z
          .string()
          .describe("New file path inside your working directory, absolute or relative to it"),
      },
    },
    async ({ channel, ts, fileId, destinationPath }) => {
      try {
        requireFileToolsAvailable(options);
        const workDir = requireWorkDir(options);
        const target = await resolveDownloadPath(workDir, destinationPath);
        const { file, data } = await client.downloadMessageFile(
          channel,
          ts,
          fileId,
          options.maxFileBytes ?? MAX_SLACK_FILE_BYTES
        );
        // Opened only now, after the fetch, and walked from the root so a
        // directory swapped during the fetch cannot redirect the write.
        await writeNewFileInWorkdir(workDir, target, data);
        return toolOk({
          path: target,
          bytes: data.length,
          file,
          source: `slack:channels/${channel}/messages/${ts}`,
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );
  return server;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Resolves outbound Slack thread placement from the actor's selected inbox work
 * in the destination channel (#1034), as Google Chat does (#611). Selected
 * Slack messages in other channels are ignored.
 *
 * - An explicit threadTs is used as given; passing a message's own ts starts a
 *   thread under it.
 * - With threadTs omitted, a selected reply in an existing thread is answered in
 *   that thread, also when the thread's parent is selected with it.
 * - Otherwise an omitted threadTs posts top-level, including when selected
 *   messages in this channel point at different threads.
 */
export function resolveSlackReplyThreadTs(
  channel: string,
  callerThreadTs: string | undefined,
  selectedEntries: readonly InboxEntry[],
  logger?: Logger
): string | undefined {
  if (callerThreadTs) return callerThreadTs;
  const selected = selectedEntries.flatMap((entry) => {
    const payload = entry.payload;
    if (payload?.type !== "slack.message" || nonEmpty(payload.channel) !== channel) return [];
    const ts = nonEmpty(payload.ts);
    if (!ts) return [];
    // A thread's parent can carry a thread_ts equal to its own ts.
    const threadTs = nonEmpty(payload.threadTs);
    return [{ ts, thread: threadTs !== ts ? threadTs : undefined }];
  });
  const threads = new Set(selected.flatMap((m) => (m.thread ? [m.thread] : [])));
  const [thread] = threads;
  if (!thread) return undefined;
  if (threads.size === 1 && selected.every((m) => m.thread || m.ts === thread)) {
    logger?.info("slack_reply_assigned_thread", {
      channel,
      effectiveThreadTs: thread,
      reason: "selected_thread_entry",
    });
    return thread;
  }
  logger?.warn("slack_reply_ambiguous_selection", { channel, matchingCount: selected.length });
  return undefined;
}

const threadTsSchema = z
  .string()
  .optional()
  .describe(
    "Parent timestamp of the thread to post in, used as given; pass a message's own ts to start a thread under it. When omitted and the Slack message selected from your inbox in this channel is a thread reply, the post goes into that thread; otherwise it posts top-level."
  );

export function createSlackWriteMcpServer(
  client: SlackClient,
  allowedChannels: "all" | string[],
  options: SlackWriteMcpOptions = {}
): McpServer {
  const server = createMcpServer({ name: SLACK_WRITE_MCP_NAME, version: "0.1.0" });
  const allowed = (channel: string) =>
    allowedChannels === "all" || allowedChannels.includes(channel);
  const placement = (channel: string, threadTs?: string) =>
    resolveSlackReplyThreadTs(
      channel,
      threadTs,
      options.selectedInboxEntries?.() ?? [],
      options.logger
    );
  server.registerTool(
    "send_message",
    {
      title: "Send a Slack message",
      description:
        "Post to a channel or reply in a thread using its parent timestamp. Without threadTs, a reply to a selected Slack message that is in a thread stays in that thread; otherwise it posts top-level.",
      inputSchema: {
        channel: z.string(),
        text: z.string(),
        threadTs: threadTsSchema,
      },
    },
    async ({ channel, text, threadTs }) => {
      try {
        if (!allowed(channel)) throw new Error(`access denied: Slack channel ${channel}`);
        const effectiveThreadTs = placement(channel, threadTs);
        const ts = await client.send(channel, text, effectiveThreadTs);
        options.onWrite?.();
        return toolOk({
          ref: `slack:channels/${channel}/messages/${ts}`,
          ts,
          ...(effectiveThreadTs ? { threadTs: effectiveThreadTs } : {}),
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );
  server.registerTool(
    "react",
    {
      title: "React to a Slack message",
      description: "Add an emoji reaction (default eyes) to a message.",
      inputSchema: {
        channel: z.string(),
        ts: z.string(),
        emoji: z.string().optional().describe("Slack emoji name without colons (defaults to eyes)"),
      },
    },
    async ({ channel, ts, emoji }) => {
      try {
        if (!allowed(channel)) throw new Error(`access denied: Slack channel ${channel}`);
        await client.react(channel, ts, emoji);
        options.onWrite?.();
        return toolOk({ ok: true });
      } catch (err) {
        return toolError(err);
      }
    }
  );
  server.registerTool(
    "upload_file",
    {
      title: "Upload a file to Slack",
      description:
        "Share a file from your working directory into a channel, or a thread using its parent timestamp. threadTs places it exactly as for send_message. Unavailable for follower-hosted actors (see #812).",
      inputSchema: {
        channel: z.string(),
        filePath: z
          .string()
          .describe(
            "Path to a file inside your working directory, absolute or relative to it; paths outside it are rejected"
          ),
        threadTs: threadTsSchema,
        filename: z.string().optional().describe("Defaults to the file's basename"),
        title: z.string().optional(),
        initialComment: z.string().optional().describe("Message text posted with the file"),
      },
    },
    async ({ channel, filePath, threadTs: callerThreadTs, filename, title, initialComment }) => {
      try {
        if (!allowed(channel)) throw new Error(`access denied: Slack channel ${channel}`);
        requireFileToolsAvailable(options);
        const workDir = requireWorkDir(options);
        const source = await resolveAttachmentPath(workDir, filePath);
        const data = await readBoundedRegularFile(
          workDir,
          source,
          options.maxFileBytes ?? MAX_SLACK_FILE_BYTES
        );
        const threadTs = placement(channel, callerThreadTs);
        const fileIds = await client.uploadFile(channel, {
          filename: filename || basename(source),
          data,
          ...(threadTs ? { threadTs } : {}),
          ...(title ? { title } : {}),
          ...(initialComment ? { initialComment } : {}),
        });
        // Slack completed the share, so the file is posted even if no ID came back.
        options.onWrite?.();
        if (fileIds.length === 0) {
          throw new Error(
            "Slack completed the upload but returned no file ID; check the channel before uploading again"
          );
        }
        return toolOk({ fileIds, channel, ...(threadTs ? { threadTs } : {}) });
      } catch (err) {
        return toolError(err);
      }
    }
  );
  return server;
}
