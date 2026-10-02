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

/** Default cap on a file an actor may download from or upload to Slack. */
export const MAX_SLACK_FILE_BYTES = 50 * 1024 * 1024;

/** The only host a bot token is ever sent to when fetching a private file. */
const SLACK_FILE_HOST = "files.slack.com";

/** Metadata for a file attached to a Slack message; never carries its private URL. */
export interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
}

export interface SlackMessage {
  channel: string;
  ts: string;
  text: string;
  user?: string;
  threadTs?: string;
  files?: SlackFile[];
}

interface RawSlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private_download?: string;
}

function toSlackFile(file: RawSlackFile & { id: string }): SlackFile {
  return {
    id: file.id,
    ...(file.name ? { name: file.name } : {}),
    ...(file.title ? { title: file.title } : {}),
    ...(file.mimetype ? { mimetype: file.mimetype } : {}),
    ...(file.filetype ? { filetype: file.filetype } : {}),
    ...(file.size !== undefined ? { size: file.size } : {}),
  };
}

function sizeLimitError(maxBytes: number): Error {
  return new Error(`file size limit exceeded: file is larger than ${maxBytes} bytes`);
}

async function readBodyWithLimit(resp: Response, maxBytes: number): Promise<Buffer> {
  if (!resp.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of resp.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) {
      await resp.body.cancel().catch(() => {});
      throw sizeLimitError(maxBytes);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class SlackClient {
  readonly web: WebClient;
  readonly #botToken: string;

  constructor(botToken: string) {
    this.web = new WebClient(botToken);
    this.#botToken = botToken;
  }

  async getChannel(channel: string): Promise<{ id: string; name: string }> {
    const response = await this.web.conversations.info({ channel });
    const found = response.channel;
    if (!found?.id) throw new Error(`Slack channel not found: ${channel}`);
    return { id: found.id, name: found.name ?? found.id };
  }

  private async findMessage(channel: string, ts: string) {
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
    return found;
  }

  async getMessage(channel: string, ts: string): Promise<SlackMessage> {
    const found = await this.findMessage(channel, ts);
    const files = ((found.files ?? []) as RawSlackFile[])
      .filter((file): file is RawSlackFile & { id: string } => Boolean(file.id))
      .map(toSlackFile);
    return {
      channel,
      ts,
      text: found.text ?? "",
      user: found.user,
      threadTs: found.thread_ts,
      ...(files.length > 0 ? { files } : {}),
    };
  }

  /**
   * Download a file attached to the message at `channel`/`ts`. The file is
   * resolved through that message, never by bare ID, so a caller can only read
   * files it can name a source message for. The bot token is sent only to
   * Slack's private file host, and the size cap holds whether or not Slack
   * reported the size up front.
   */
  async downloadMessageFile(
    channel: string,
    ts: string,
    fileId: string,
    maxBytes = MAX_SLACK_FILE_BYTES
  ): Promise<{ file: SlackFile; data: Buffer }> {
    const found = await this.findMessage(channel, ts);
    const raw = ((found.files ?? []) as RawSlackFile[]).find((file) => file.id === fileId);
    if (!raw?.id) throw new Error(`Slack file ${fileId} is not attached to ${channel}/${ts}`);
    const file = toSlackFile({ ...raw, id: raw.id });
    if (raw.size !== undefined && raw.size > maxBytes) throw sizeLimitError(maxBytes);
    if (!raw.url_private_download) {
      throw new Error(`Slack file ${fileId} has no downloadable content`);
    }
    const url = new URL(raw.url_private_download);
    if (url.protocol !== "https:" || url.hostname !== SLACK_FILE_HOST) {
      throw new Error(`refusing to send Slack credentials to ${url.host}`);
    }
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${this.#botToken}` } });
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      throw new Error(`Slack file download failed: HTTP ${resp.status}`);
    }
    // Without files:read Slack answers with its sign-in page instead of an error.
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.startsWith("text/html") && raw.mimetype !== "text/html") {
      await resp.body?.cancel().catch(() => {});
      throw new Error(
        "Slack returned an HTML page instead of the file; check the files:read scope"
      );
    }
    const declared = Number(resp.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await resp.body?.cancel().catch(() => {});
      throw sizeLimitError(maxBytes);
    }
    return { file, data: await readBodyWithLimit(resp, maxBytes) };
  }

  /**
   * Share a file into a channel, or a thread when `threadTs` is given, through
   * Slack's external upload flow (`files.getUploadURLExternal`, upload, then
   * `files.completeUploadExternal`), which the SDK's `uploadV2` drives.
   */
  async uploadFile(
    channel: string,
    upload: {
      filename: string;
      data: Buffer;
      threadTs?: string;
      title?: string;
      initialComment?: string;
    }
  ): Promise<string[]> {
    const common = {
      channel_id: channel,
      file: upload.data,
      filename: upload.filename,
      ...(upload.title ? { title: upload.title } : {}),
      ...(upload.initialComment ? { initial_comment: upload.initialComment } : {}),
    };
    const response = await this.web.files.uploadV2(
      upload.threadTs ? { ...common, thread_ts: upload.threadTs } : common
    );
    const completions = (response as { files?: { files?: { id?: string }[] }[] }).files ?? [];
    const ids = completions.flatMap((c) => c.files ?? []).flatMap((f) => (f.id ? [f.id] : []));
    if (ids.length === 0) throw new Error("Slack did not confirm the uploaded file");
    return ids;
  }

  /**
   * The newest `limit` messages, oldest first: the tail of the thread rooted at
   * `threadTs` when given, otherwise the channel's top-level messages. Replies
   * page from the thread's start, so a long thread is walked to its end, up to
   * `maxScanned` messages.
   */
  async listRecentMessages(
    channel: string,
    opts: { threadTs?: string; limit: number; maxScanned?: number }
  ): Promise<SlackMessage[]> {
    const toMessage = (m: {
      ts?: string;
      text?: string;
      user?: string;
      bot_id?: string;
      thread_ts?: string;
    }) => ({
      channel,
      ts: m.ts ?? "",
      text: m.text ?? "",
      user: m.user ?? m.bot_id,
      threadTs: m.thread_ts,
    });
    if (!opts.threadTs) {
      // History also carries replies broadcast to the channel; over-fetch so
      // dropping them still leaves `limit` top-level messages in the common case.
      const response = await this.web.conversations.history({
        channel,
        limit: Math.min(opts.limit * 3, 200),
      });
      return (response.messages ?? [])
        .filter((m) => !m.thread_ts || m.thread_ts === m.ts)
        .slice(0, opts.limit)
        .map(toMessage)
        .reverse();
    }
    const maxScanned = opts.maxScanned ?? 1000;
    const replies: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.web.conversations.replies({
        channel,
        ts: opts.threadTs,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      replies.push(...(response.messages ?? []).map(toMessage));
      cursor = response.response_metadata?.next_cursor || undefined;
    } while (cursor && replies.length < maxScanned);
    return replies.slice(-opts.limit);
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
