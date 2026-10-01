import { writeFile } from "node:fs/promises";
import { basename } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MAX_SLACK_FILE_BYTES, type SlackClient } from "../slack/slack-client.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";
import {
  readBoundedRegularFile,
  resolveAttachmentPath,
  resolveDownloadPath,
} from "./workdir-path.js";

export const SLACK_READ_MCP_NAME = "slack-read";
export const SLACK_WRITE_MCP_NAME = "slack-write";

export interface SlackMcpOptions {
  isFenced?: () => boolean;
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

export function createSlackReadMcpServer(
  client: SlackClient,
  options: SlackMcpOptions = {}
): McpServer {
  const server = createMcpServer(
    { name: SLACK_READ_MCP_NAME, version: "0.1.0" },
    { isFenced: options.isFenced }
  );
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
        const target = await resolveDownloadPath(requireWorkDir(options), destinationPath);
        const { file, data } = await client.downloadMessageFile(
          channel,
          ts,
          fileId,
          options.maxFileBytes ?? MAX_SLACK_FILE_BYTES
        );
        await writeFile(target, data, { flag: "wx" });
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
  const server = createMcpServer(
    { name: SLACK_WRITE_MCP_NAME, version: "0.1.0" },
    { isFenced: options.isFenced }
  );
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
      description: "Add an emoji reaction to a message.",
      inputSchema: { channel: z.string(), ts: z.string(), emoji: z.string().optional() },
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
        const source = await resolveAttachmentPath(requireWorkDir(options), filePath);
        const data = await readBoundedRegularFile(
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
