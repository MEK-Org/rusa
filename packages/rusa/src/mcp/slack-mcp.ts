import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SlackClient } from "../slack/slack-client.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const SLACK_READ_MCP_NAME = "slack-read";
export const SLACK_WRITE_MCP_NAME = "slack-write";

export function createSlackReadMcpServer(client: SlackClient, isFenced?: () => boolean): McpServer {
  const server = createMcpServer({ name: SLACK_READ_MCP_NAME, version: "0.1.0" }, { isFenced });
  server.registerTool(
    "get_message",
    {
      title: "Read a Slack message",
      description: "Read a Slack message by channel ID and timestamp.",
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
  return server;
}

export function createSlackWriteMcpServer(
  client: SlackClient,
  allowedChannels: "all" | string[],
  isFenced?: () => boolean
): McpServer {
  const server = createMcpServer({ name: SLACK_WRITE_MCP_NAME, version: "0.1.0" }, { isFenced });
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
  return server;
}
