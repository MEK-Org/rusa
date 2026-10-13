import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MAX_SLACK_FILE_BYTES,
  MAX_SLACK_HISTORY_PAGE,
  type SlackClient,
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
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A history bound as Slack expects it: seconds since the epoch with up to six
 * decimals. Accepts a Slack message timestamp as-is, or an ISO-8601 instant
 * with an explicit offset so a date range never depends on the host's zone.
 */
export function toSlackTimestamp(value: string, field: string): string {
  if (SLACK_TS.test(value)) return value;
  const ms = ISO_INSTANT.test(value) ? Date.parse(value) : Number.NaN;
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

export function createSlackWriteMcpServer(
  client: SlackClient,
  allowedChannels: "all" | string[],
  options: SlackMcpOptions = {}
): McpServer {
  const server = createMcpServer({ name: SLACK_WRITE_MCP_NAME, version: "0.1.0" });
  const allowed = (channel: string) =>
    allowedChannels === "all" || allowedChannels.includes(channel);
  server.registerTool(
    "send_message",
    {
      title: "Send a Slack message",
      description: "Post to a channel or reply in a thread using its parent timestamp.",
      inputSchema: { channel: z.string(), text: z.string(), threadTs: z.string().optional() },
    },
    async ({ channel, text, threadTs }) => {
      try {
        if (!allowed(channel)) throw new Error(`access denied: Slack channel ${channel}`);
        const ts = await client.send(channel, text, threadTs);
        return toolOk({ ref: `slack:channels/${channel}/messages/${ts}`, ts });
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
        "Share a file from your working directory into a channel, or a thread using its parent timestamp. Unavailable for follower-hosted actors (see #812).",
      inputSchema: {
        channel: z.string(),
        filePath: z
          .string()
          .describe(
            "Path to a file inside your working directory, absolute or relative to it; paths outside it are rejected"
          ),
        threadTs: z.string().optional(),
        filename: z.string().optional().describe("Defaults to the file's basename"),
        title: z.string().optional(),
        initialComment: z.string().optional().describe("Message text posted with the file"),
      },
    },
    async ({ channel, filePath, threadTs, filename, title, initialComment }) => {
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
        const fileIds = await client.uploadFile(channel, {
          filename: filename || basename(source),
          data,
          ...(threadTs ? { threadTs } : {}),
          ...(title ? { title } : {}),
          ...(initialComment ? { initialComment } : {}),
        });
        return toolOk({ fileIds, channel, ...(threadTs ? { threadTs } : {}) });
      } catch (err) {
        return toolError(err);
      }
    }
  );
  return server;
}
