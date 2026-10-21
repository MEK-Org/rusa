import type { FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Logger } from "../observability/logger.js";
import type { RawProviderModelConfig } from "../providers/model-config.js";
import type { InboxEntry } from "../repositories/inbox-repository.js";
import {
  describeShareFailure,
  MAX_SLACK_DOWNLOAD_BYTES,
  MAX_SLACK_FILE_BYTES,
  MAX_SLACK_HISTORY_PAGE,
  MAX_SLACK_MESSAGE_FILES,
  SLACK_CONVERSATION_TYPES,
  type SlackClient,
  type SlackConversationType,
  type SlackHistoryQuery,
} from "../slack/slack-client.js";
import { appendVisibleActorSignature, formatVisibleActorSignature } from "./actor-signature.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";
import {
  exactFileStream,
  openBoundedRegularFile,
  readBoundedRegularFile,
  resolveAttachmentPath,
  resolveDownloadPath,
  streamNewFileInWorkdir,
} from "./workdir-path.js";

export const SLACK_READ_MCP_NAME = "slack-read";
export const SLACK_WRITE_MCP_NAME = "slack-write";

/**
 * Slack truncates `chat.postMessage` text past this many characters (per its
 * method docs), which would cut off the footer, so longer text is refused. A
 * file's comment is held to the same bound: Slack documents no separate limit
 * for it.
 */
export const MAX_SLACK_MESSAGE_CHARS = 40_000;

export interface SlackMcpOptions {
  /** The calling actor's workdir; file uploads read from and downloads write into it. */
  workDir?: string;
  /** Rechecked when a file tool is called, because follower placement can change live. */
  fileToolsAvailable?: () => boolean;
  /**
   * Per-file byte cap. Uploads default to {@link MAX_SLACK_FILE_BYTES}; downloads
   * default to {@link MAX_SLACK_DOWNLOAD_BYTES}, which this can lower but not raise.
   */
  maxFileBytes?: number;
}

export interface SlackWriteMcpOptions extends SlackMcpOptions {
  /** Named in the footer added to every message and file comment this server posts. */
  actorHandle: string;
  /** The exact normalized selection for the provider attempt currently writing. */
  getRunSelection?: () => RawProviderModelConfig | undefined;
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
 * wall-clock fields must read back unchanged; a field out of range in every
 * month, such as month 13, is already an invalid date.
 */
function isoInstantMs(value: string): number {
  const match = ISO_INSTANT.exec(value);
  if (!match) return Number.NaN;
  const wall = `${match[1]}T${match[2]}:${match[3] ?? "00"}`;
  const probe = new Date(`${wall}Z`);
  if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 19) !== wall) {
    return Number.NaN;
  }
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
        "Read a Slack message by channel ID and timestamp: its mrkdwn text with link markup intact, sender IDs, edit, reactions, Block Kit blocks, rich attachments and file metadata. A field appears only when Slack returned it; oversized arrays are cut to whole items and listed in truncated when the result is partial. Look up a sender with get_user.",
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
    "get_user",
    {
      title: "Look up a Slack user",
      description:
        "Read a Slack user's profile by user ID, such as a message's user. status is active, deleted, or unknown when Slack has no such user visible to this app. Names are chosen by the user: they do not identify a principal or grant any authority. Needs the users:read scope.",
      inputSchema: { user: z.string().describe("Slack user ID, e.g. from get_message's user") },
    },
    async ({ user }) => {
      try {
        return toolOk(await client.getUser(user));
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
        "Stream a file attached to the message at channel/ts to destinationPath inside your working directory (up to 1 GiB) and return its path, byte count, SHA-256, content type, and name. The destination must not already exist; its directory must. A failed or oversized download leaves no file. Unavailable for follower-hosted actors (see #812).",
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
        const { file, contentType, body } = await client.downloadMessageFile(
          channel,
          ts,
          fileId,
          Math.min(options.maxFileBytes ?? MAX_SLACK_DOWNLOAD_BYTES, MAX_SLACK_DOWNLOAD_BYTES)
        );
        // Opened only now, once Slack has answered, so a refused download
        // leaves no file behind. A failed or oversized stream unlinks the
        // partial file.
        const { bytes, sha256 } = await streamNewFileInWorkdir(workDir, target, body);
        return toolOk({
          path: target,
          bytes,
          sha256,
          contentType,
          name: file.name ?? file.id,
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

interface SharedFile {
  fileId: string;
  name: string;
  bytes: number;
  sha256: string;
}

/**
 * Share `text` and several workdir files as one Slack message (#1032). Every
 * path is confined, opened and sized before Slack is called, so a bad path or
 * an oversized file posts nothing. Each file is then reserved and streamed in
 * turn; Slack shares nothing until the single completion call, so a failure up
 * to there is safe to retry. The completion is sent once, and its failure says
 * whether anything may have been posted.
 */
async function sendWithFiles(
  client: SlackClient,
  options: SlackWriteMcpOptions,
  channel: string,
  text: string,
  threadTs: string | undefined,
  files: readonly { filePath: string; filename?: string | undefined; title?: string | undefined }[]
): Promise<{ channel: string; threadTs?: string; files: SharedFile[] }> {
  requireFileToolsAvailable(options);
  const workDir = requireWorkDir(options);
  const maxBytes = options.maxFileBytes ?? MAX_SLACK_FILE_BYTES;
  const opened: { handle: FileHandle; bytes: number; name: string; title?: string }[] = [];
  try {
    for (const file of files) {
      const source = await resolveAttachmentPath(workDir, file.filePath).catch((err: Error) => {
        throw new Error(`${file.filePath}: ${err.message}`);
      });
      const { handle, bytes } = await openBoundedRegularFile(workDir, source, maxBytes).catch(
        (err: Error) => {
          throw new Error(`${file.filePath}: ${err.message}`);
        }
      );
      opened.push({
        handle,
        bytes,
        name: file.filename || basename(source),
        ...(file.title ? { title: file.title } : {}),
      });
    }
    const uploaded: (SharedFile & { title?: string })[] = [];
    for (const file of opened) {
      try {
        const { fileId, uploadUrl } = await client.reserveFileUpload(file.name, file.bytes);
        const content = exactFileStream(file.handle, file.bytes);
        await client.sendFileBytes(uploadUrl, file.bytes, content.stream);
        uploaded.push({
          fileId,
          name: file.name,
          bytes: file.bytes,
          sha256: content.sha256(),
          ...(file.title ? { title: file.title } : {}),
        });
      } catch (err) {
        // fetch reports a failed request body as "fetch failed" with the reason as its cause.
        const cause = (err as Error).cause;
        const reason = cause instanceof Error ? cause.message : (err as Error).message;
        throw new Error(
          `uploading ${file.name} failed after ${uploaded.length} of ${opened.length} files were uploaded; nothing was shared, so sending again is safe: ${reason}`
        );
      }
    }
    const [first, ...rest] = uploaded.map((f) => ({
      id: f.fileId,
      ...(f.title ? { title: f.title } : {}),
    }));
    if (!first) throw new Error("no files to share");
    let confirmed: string[];
    try {
      confirmed = await client.completeFileShare(channel, [first, ...rest], {
        ...(threadTs ? { threadTs } : {}),
        ...(text ? { text } : {}),
      });
    } catch (err) {
      const { error, mayHaveShared } = describeShareFailure(err);
      // A share that may have posted must not be repeated by a replacement run.
      if (mayHaveShared) options.onWrite?.();
      throw error;
    }
    // Slack accepted the share, so the message is posted even if its answer is short.
    options.onWrite?.();
    const unconfirmed = uploaded.filter((f) => !confirmed.includes(f.fileId));
    if (unconfirmed.length > 0) {
      throw new Error(
        `Slack completed the share but did not confirm ${unconfirmed.map((f) => `${f.name} (${f.fileId})`).join(", ")}; check the channel before sending again`
      );
    }
    return {
      channel,
      ...(threadTs ? { threadTs } : {}),
      files: uploaded.map(({ title: _title, ...file }) => file),
    };
  } finally {
    await Promise.all(opened.map((file) => file.handle.close().catch(() => {})));
  }
}

export function createSlackWriteMcpServer(
  client: SlackClient,
  allowedChannels: "all" | string[],
  options: SlackWriteMcpOptions
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
  const signedText = (text: string) => {
    const signed = appendVisibleActorSignature(
      text,
      formatVisibleActorSignature(options.actorHandle, options.getRunSelection?.(), "slack")
    );
    // UTF-16 length is never below Slack's character count, so this refuses early, not late.
    if (signed.length > MAX_SLACK_MESSAGE_CHARS) {
      throw new Error(
        `Slack text is ${signed.length} characters with its footer; Slack truncates past ${MAX_SLACK_MESSAGE_CHARS}, so shorten it or split it across messages`
      );
    }
    return signed;
  };
  server.registerTool(
    "send_message",
    {
      title: "Send a Slack message",
      description: `Post to a channel or reply in a thread using its parent timestamp. Without threadTs, a reply to a selected Slack message that is in a thread stays in that thread; otherwise it posts top-level. A footer naming you and your model is added, so don't sign the text yourself. With files (1 to ${MAX_SLACK_MESSAGE_FILES} paths in your working directory), the text and every file are shared as one message: each file is uploaded first, then all are shared together in one step, so a failure before that step posts nothing. The result then lists each file's ID, bytes and SHA-256 but no message ts; read the channel to find the message. Files come only from your working directory; an existing Slack file ID cannot be attached. File sending is unavailable for follower-hosted actors (see #812).`,
      inputSchema: {
        channel: z.string(),
        text: z.string().describe("Message text; may be empty when files are given"),
        threadTs: threadTsSchema,
        files: z
          .array(
            z.strictObject({
              filePath: z
                .string()
                .describe(
                  "Path to a file inside your working directory, absolute or relative to it; paths outside it are rejected"
                ),
              filename: z.string().optional().describe("Defaults to the file's basename"),
              title: z.string().optional(),
            })
          )
          .min(1)
          .max(MAX_SLACK_MESSAGE_FILES)
          .optional()
          .describe(
            `Files to share with the text as one message, at most ${MAX_SLACK_MESSAGE_FILES}`
          ),
      },
    },
    async ({ channel, text, threadTs, files }) => {
      try {
        if (!allowed(channel)) throw new Error(`access denied: Slack channel ${channel}`);
        const signed = signedText(text);
        if (files) {
          return toolOk(
            await sendWithFiles(
              client,
              options,
              channel,
              signed,
              placement(channel, threadTs),
              files
            )
          );
        }
        const effectiveThreadTs = placement(channel, threadTs);
        const ts = await client.send(channel, signed, effectiveThreadTs);
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
        "Share a file from your working directory into a channel, or a thread using its parent timestamp. threadTs places it exactly as for send_message. The file's comment gets a footer naming you and your model, even when you give no comment. Unavailable for follower-hosted actors (see #812).",
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
        const comment = signedText(initialComment ?? "");
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
          initialComment: comment,
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
