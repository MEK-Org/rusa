import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { WebClient } from "@slack/web-api";
import { assertSecretContainment, secretsDirPath } from "../config/secrets.js";

export function readSlackToken(path: string, home: string): string {
  const secretsDir = secretsDirPath(home);
  const filename = basename(path);
  if (resolve(path) !== resolve(join(secretsDir, filename))) {
    throw new Error(`Slack token file must be directly inside ${secretsDir}`);
  }
  const safePath = assertSecretContainment(filename, secretsDir);
  const token = readFileSync(safePath, "utf8").trim();
  if (!token) throw new Error(`Slack token file is empty: ${path}`);
  return token;
}

export interface SlackMessage {
  channel: string;
  ts: string;
  text: string;
  user?: string;
  threadTs?: string;
}

export class SlackClient {
  readonly web: WebClient;

  constructor(botToken: string) {
    this.web = new WebClient(botToken);
  }

  async getChannel(channel: string): Promise<{ id: string; name: string }> {
    const response = await this.web.conversations.info({ channel });
    const found = response.channel;
    if (!found?.id) throw new Error(`Slack channel not found: ${channel}`);
    return { id: found.id, name: found.name ?? found.id };
  }

  async getMessage(channel: string, ts: string): Promise<SlackMessage> {
    const response = await this.web.conversations.replies({
      channel,
      ts,
      oldest: ts,
      latest: ts,
      inclusive: true,
      limit: 1,
    });
    const found = response.messages?.find((message) => message.ts === ts);
    if (!found) throw new Error(`Slack message not found: ${channel}/${ts}`);
    return {
      channel,
      ts,
      text: found.text ?? "",
      user: found.user,
      threadTs: found.thread_ts,
    };
  }

  async send(channel: string, text: string, threadTs?: string): Promise<string> {
    const result = await this.web.chat.postMessage({ channel, text, thread_ts: threadTs });
    if (!result.ts) throw new Error("Slack did not return a message timestamp");
    return result.ts;
  }

  async react(channel: string, ts: string, emoji = "eyes"): Promise<void> {
    await this.web.reactions.add({ channel, timestamp: ts, name: emoji });
  }
}
