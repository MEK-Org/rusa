import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ErrorCode, type FetchFunction, WebClient } from "@slack/web-api";
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
  /** User ID of the uploader. */
  user?: string;
  /** Upload time, in Unix seconds. */
  created?: number;
  /** Slack's file mode; `tombstone` marks a deleted file, `hidden_by_limit` one past the plan limit. */
  mode?: string;
}

export interface SlackMessage {
  channel: string;
  ts: string;
  text: string;
  user?: string;
  threadTs?: string;
  files?: SlackFile[];
}

/**
 * Bounds on the arrays and rich payloads one {@link SlackMessageDetail} carries.
 * These are estimates, not sizes measured from real messages: generous enough
 * for an ordinary rich message, small enough to keep one read out of the way of
 * an agent's context.
 */
export const SLACK_MESSAGE_LIMITS = {
  files: 20,
  reactions: 50,
  reactionUsers: 50,
  /** Serialized JSON bytes kept for each of `blocks` and `attachments`. */
  richBytes: 32 * 1024,
} as const;

/**
 * One Slack message as `get_message` returns it. A field is present only when
 * Slack returned it, so absent means Slack said nothing while an empty string
 * or array is what Slack said. `text` is Slack's own mrkdwn with link markup
 * such as `<@U1>`, `<#C1>` and `<https://example.com|label>` left intact.
 * Unlike a Google Chat message, it carries no sender display name: `user` is an
 * ID to look up with `getUser`, and bot posts name themselves through
 * `botId`, `botProfile` and `username`. Arrays and rich payloads past
 * {@link SLACK_MESSAGE_LIMITS} are cut to whole items, and `truncated` names
 * each field cut. This is the single-message read; listings, including the
 * history tools' {@link SlackHistoryMessage}, return the slimmer
 * {@link SlackMessage} summary, which has no reactions or rich payloads and
 * reports an absent `text` as `""`.
 */
export interface SlackMessageDetail {
  channel: string;
  ts: string;
  text?: string;
  type?: string;
  subtype?: string;
  user?: string;
  botId?: string;
  /** Name Slack shows for a bot or webhook post; chosen by the poster, so never proof of identity. */
  username?: string;
  botProfile?: { id?: string; name?: string; appId?: string; deleted?: boolean };
  threadTs?: string;
  replyCount?: number;
  edited?: { user?: string; ts?: string };
  reactions?: { name: string; count?: number; users?: string[] }[];
  /** Block Kit blocks, as Slack returned them. */
  blocks?: unknown[];
  /** Legacy rich attachments (link unfurls, app cards), as Slack returned them. */
  attachments?: unknown[];
  files?: SlackFile[];
  truncated?: string[];
}

/**
 * A Slack user's profile. `status` is `unknown` when Slack has no user by that
 * ID visible to this token; `reason` then carries Slack's error code. Names are
 * chosen by the user and never identify a principal or grant authority.
 */
export interface SlackUser {
  id: string;
  status: "active" | "deleted" | "unknown";
  reason?: string;
  name?: string;
  realName?: string;
  displayName?: string;
  isBot?: boolean;
  isAppUser?: boolean;
  /** Guest account. */
  isRestricted?: boolean;
  /** Belongs to another workspace reached through a shared channel. */
  isStranger?: boolean;
  teamId?: string;
}

interface RawSlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  user?: string;
  created?: number;
  mode?: string;
  url_private_download?: string;
}

interface RawSlackMessage {
  type?: string;
  subtype?: string;
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  bot_profile?: { id?: string; name?: string; app_id?: string; deleted?: boolean };
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  edited?: { user?: string; ts?: string };
  reactions?: { name?: string; count?: number; users?: string[] }[];
  blocks?: unknown[];
  attachments?: unknown[];
  files?: RawSlackFile[];
}

function toSlackFile(file: RawSlackFile & { id: string }): SlackFile {
  return {
    id: file.id,
    ...(file.name ? { name: file.name } : {}),
    ...(file.title ? { title: file.title } : {}),
    ...(file.mimetype ? { mimetype: file.mimetype } : {}),
    ...(file.filetype ? { filetype: file.filetype } : {}),
    ...(file.size !== undefined ? { size: file.size } : {}),
    ...(file.user ? { user: file.user } : {}),
    ...(file.created !== undefined ? { created: file.created } : {}),
    ...(file.mode ? { mode: file.mode } : {}),
  };
}

/** The largest page an actor may request from a history tool. */
export const MAX_SLACK_HISTORY_PAGE = 200;

/** A message as listed by the history tools: one page entry, without private file URLs. */
export interface SlackHistoryMessage extends SlackMessage {
  botId?: string;
  subtype?: string;
  /** Present on a thread parent: how many replies Slack counts in its thread. */
  replyCount?: number;
  latestReply?: string;
}

export interface SlackHistoryPage {
  channel: string;
  threadTs?: string;
  /** Channel history is newest first; thread replies are oldest first. */
  order: "newest_first" | "oldest_first";
  messages: SlackHistoryMessage[];
  /** Whether Slack reports more messages within the bounds beyond this page. */
  hasMore: boolean;
  /** Pass back as `cursor`, with the same channel, thread and bounds, for the next page. */
  nextCursor?: string;
}

export interface SlackHistoryQuery {
  /** Slack timestamp (seconds since the epoch, e.g. "1712345678.000100"). */
  oldest?: string;
  latest?: string;
  inclusive?: boolean;
  limit: number;
  cursor?: string;
}

function toHistoryMessage(channel: string, m: RawSlackMessage): SlackHistoryMessage {
  const files = (m.files ?? [])
    .filter((file): file is RawSlackFile & { id: string } => Boolean(file.id))
    .map(toSlackFile);
  return {
    channel,
    ts: m.ts ?? "",
    text: m.text ?? "",
    ...(m.user ? { user: m.user } : {}),
    ...(m.bot_id ? { botId: m.bot_id } : {}),
    ...(m.subtype ? { subtype: m.subtype } : {}),
    ...(m.thread_ts ? { threadTs: m.thread_ts } : {}),
    ...(m.reply_count !== undefined ? { replyCount: m.reply_count } : {}),
    ...(m.latest_reply ? { latestReply: m.latest_reply } : {}),
    ...(files.length > 0 ? { files } : {}),
  };
}

/**
 * The conversation types `listConversations` lists. Slack can also list `im`
 * (one row per DM, naming the partner) and `mpim` (group DMs, named after their
 * members), but both are left out until an operator asks for that roster; a DM
 * or group DM whose ID is already known can still be read through the history
 * tools.
 */
export const SLACK_CONVERSATION_TYPES = ["public_channel", "private_channel"] as const;
export type SlackConversationType = (typeof SLACK_CONVERSATION_TYPES)[number];

export interface SlackConversation {
  id: string;
  name?: string;
  /** `"unknown"` when Slack's flags match none of the listed types. */
  type: SlackConversationType | "unknown";
  /** Whether the app is a member; absent when Slack does not say. */
  isMember?: boolean;
  isArchived?: boolean;
}

export interface SlackConversationPage {
  conversations: SlackConversation[];
  /** Whether Slack has more to list; a page may be short, or even empty, while it does. */
  hasMore: boolean;
  nextCursor?: string;
}

interface RawSlackConversation {
  id?: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
}

function conversationType(c: RawSlackConversation): SlackConversation["type"] {
  if (c.is_private || c.is_group) return "private_channel";
  if (c.is_channel) return "public_channel";
  return "unknown";
}

function toConversation(c: RawSlackConversation & { id: string }): SlackConversation {
  return {
    id: c.id,
    ...(c.name ? { name: c.name } : {}),
    type: conversationType(c),
    ...(c.is_member !== undefined ? { isMember: c.is_member } : {}),
    ...(c.is_archived !== undefined ? { isArchived: c.is_archived } : {}),
  };
}

/**
 * Rephrase a Web API failure from a read tool so the actor can tell a missing
 * scope, a conversation the app cannot see, and a rate limit apart. Only Slack's
 * error code and the scope it says is needed are echoed, never the request.
 */
export function describeSlackReadError(method: string, err: unknown): Error {
  const coded = err as {
    code?: string;
    retryAfter?: number;
    data?: { error?: string; needed?: string };
  };
  if (coded?.code === ErrorCode.RateLimitedError) {
    return new Error(
      `Slack rate limited ${method}; retry after ${coded.retryAfter ?? "an unknown number of"} seconds`
    );
  }
  if (coded?.code !== ErrorCode.PlatformError || !coded.data?.error) {
    return err instanceof Error ? err : new Error(String(err));
  }
  const code = coded.data.error;
  switch (code) {
    case "missing_scope":
      return new Error(
        `Slack token lacks a scope ${method} needs for this request` +
          (coded.data.needed ? ` (needed: ${coded.data.needed})` : "")
      );
    case "not_in_channel":
      return new Error(
        `Slack app is not a member of this conversation; ${method} needs it to be invited (not_in_channel)`
      );
    case "channel_not_found":
      return new Error(
        `Slack conversation not found or not visible to this token (channel_not_found)`
      );
    case "thread_not_found":
      return new Error(`Slack thread not found in this conversation (thread_not_found)`);
    case "ratelimited":
      return new Error(`Slack rate limited ${method} (ratelimited); retry later`);
    default:
      return new Error(`Slack ${method} failed: ${code}`);
  }
}

/** Copy only the keys whose value is defined, so absent stays absent. */
function defined<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined)
  ) as Partial<T>;
}

/**
 * Drops Slack's private file URLs, which a forwarded message's attachments can
 * nest, so downloads go through `download_file`. This is policy, not a security
 * boundary: other Slack URLs such as `permalink` and `thumb_*` stay.
 */
function withoutPrivateUrls(key: string, value: unknown): unknown {
  return key.startsWith("url_private") ? undefined : value;
}

/** Keep the leading items whose serialized JSON fits in `maxBytes`. */
function boundedJson(items: unknown[], maxBytes: number): unknown[] {
  const kept: unknown[] = [];
  let total = 2;
  for (const item of items) {
    const json = JSON.stringify(item, withoutPrivateUrls) ?? "null";
    total += Buffer.byteLength(json) + 1;
    if (total > maxBytes) break;
    kept.push(JSON.parse(json));
  }
  return kept;
}

function toSlackMessageDetail(channel: string, ts: string, raw: RawSlackMessage) {
  const limits = SLACK_MESSAGE_LIMITS;
  const truncated: string[] = [];
  const cap = <T>(field: string, items: T[], max: number): T[] => {
    if (items.length > max) truncated.push(field);
    return items.slice(0, max);
  };
  const capJson = (field: string, items: unknown[] | undefined) => {
    if (!Array.isArray(items)) return undefined;
    const kept = boundedJson(items, limits.richBytes);
    if (kept.length < items.length) truncated.push(field);
    return kept;
  };
  const files = Array.isArray(raw.files)
    ? cap(
        "files",
        raw.files.filter((file): file is RawSlackFile & { id: string } => Boolean(file.id)),
        limits.files
      ).map(toSlackFile)
    : undefined;
  const reactions = Array.isArray(raw.reactions)
    ? cap(
        "reactions",
        raw.reactions.filter((r): r is typeof r & { name: string } => Boolean(r.name)),
        limits.reactions
      ).map((r) =>
        defined({
          name: r.name,
          count: r.count,
          users: Array.isArray(r.users)
            ? cap(`reactions.${r.name}.users`, r.users, limits.reactionUsers)
            : undefined,
        })
      )
    : undefined;
  const botProfile = raw.bot_profile
    ? defined({
        id: raw.bot_profile.id,
        name: raw.bot_profile.name,
        appId: raw.bot_profile.app_id,
        deleted: raw.bot_profile.deleted,
      })
    : undefined;
  const edited = raw.edited ? defined({ user: raw.edited.user, ts: raw.edited.ts }) : undefined;
  const detail = defined({
    channel,
    ts,
    text: typeof raw.text === "string" ? raw.text : undefined,
    type: raw.type,
    subtype: raw.subtype,
    user: raw.user,
    botId: raw.bot_id,
    username: raw.username,
    botProfile,
    threadTs: raw.thread_ts,
    replyCount: raw.reply_count,
    edited,
    reactions,
    blocks: capJson("blocks", raw.blocks),
    attachments: capJson("attachments", raw.attachments),
    files,
    truncated: truncated.length > 0 ? truncated : undefined,
  });
  return detail as SlackMessageDetail;
}

function slackErrorCode(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === "string" ? data.error : undefined;
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
  /**
   * The client for the history and discovery tools and `getUser`: a
   * rate-limited call fails with Slack's retry-after instead of the SDK
   * silently waiting, and a network or HTTP failure is not retried, so an
   * actor's tool call reports the failure rather than stalling for the SDK's
   * default of ten retries over about 30 minutes.
   */
  readonly historyWeb: WebClient;
  readonly #botToken: string;

  constructor(botToken: string, options: { fetch?: FetchFunction } = {}) {
    this.web = new WebClient(botToken, options);
    this.historyWeb = new WebClient(botToken, {
      ...options,
      rejectRateLimitedCalls: true,
      retryConfig: { retries: 0 },
    });
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

  async getMessage(channel: string, ts: string): Promise<SlackMessageDetail> {
    const found = await this.findMessage(channel, ts);
    return toSlackMessageDetail(channel, ts, found as RawSlackMessage);
  }

  /** One `users.info` call; an ID Slack cannot find comes back as `unknown`, not an error. */
  async getUser(user: string): Promise<SlackUser> {
    let response: Awaited<ReturnType<WebClient["users"]["info"]>>;
    try {
      response = await this.historyWeb.users.info({ user });
    } catch (err) {
      const code = slackErrorCode(err);
      if (code === "user_not_found" || code === "user_not_visible") {
        return { id: user, status: "unknown", reason: code };
      }
      throw describeSlackReadError("users.info", err);
    }
    const found = response.user;
    if (!found?.id) return { id: user, status: "unknown", reason: "no_user_in_response" };
    return defined({
      id: found.id,
      status: found.deleted ? "deleted" : "active",
      name: found.name,
      realName: found.real_name ?? found.profile?.real_name,
      displayName: found.profile?.display_name,
      isBot: found.is_bot,
      isAppUser: found.is_app_user,
      isRestricted: found.is_restricted,
      isStranger: found.is_stranger,
      teamId: found.team_id,
    }) as SlackUser;
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
   * `files.completeUploadExternal`), which the SDK's `uploadV2` drives. Returns
   * the file IDs Slack reports; the list is empty if Slack completed the share
   * without naming a file.
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

  /**
   * One page of the conversations of `types` this token can see
   * (`conversations.list`). Slack lists private channels only where the app
   * is a member, and leaves out a type the token has no scope for, so no page
   * or walk is a complete workspace inventory.
   */
  async listConversations(query: {
    types: SlackConversationType[];
    excludeArchived: boolean;
    limit: number;
    cursor?: string;
  }): Promise<SlackConversationPage> {
    let response: Awaited<ReturnType<WebClient["conversations"]["list"]>>;
    try {
      response = await this.historyWeb.conversations.list({
        types: query.types.join(","),
        exclude_archived: query.excludeArchived,
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
      });
    } catch (err) {
      throw describeSlackReadError("conversations.list", err);
    }
    return {
      conversations: ((response.channels ?? []) as RawSlackConversation[])
        .filter((c): c is RawSlackConversation & { id: string } => Boolean(c.id))
        .map(toConversation),
      ...pageContinuation(response),
    };
  }

  /**
   * One page of a conversation's history (`conversations.history`), newest
   * first, between the optional `oldest`/`latest` bounds. Replies appear only
   * when broadcast to the channel; read a thread with {@link listThreadReplies}.
   */
  async listHistory(channel: string, query: SlackHistoryQuery): Promise<SlackHistoryPage> {
    let response: Awaited<ReturnType<WebClient["conversations"]["history"]>>;
    try {
      response = await this.historyWeb.conversations.history({ channel, ...historyArgs(query) });
    } catch (err) {
      throw describeSlackReadError("conversations.history", err);
    }
    return {
      channel,
      order: "newest_first",
      messages: (response.messages ?? []).map((m) =>
        toHistoryMessage(channel, m as RawSlackMessage)
      ),
      ...pageContinuation(response),
    };
  }

  /**
   * One page of the thread rooted at `threadTs` (`conversations.replies`),
   * oldest first, between the optional bounds. Slack may include the parent
   * message (its `ts` equals `threadTs`).
   */
  async listThreadReplies(
    channel: string,
    threadTs: string,
    query: SlackHistoryQuery
  ): Promise<SlackHistoryPage> {
    let response: Awaited<ReturnType<WebClient["conversations"]["replies"]>>;
    try {
      response = await this.historyWeb.conversations.replies({
        channel,
        ts: threadTs,
        ...historyArgs(query),
      });
    } catch (err) {
      throw describeSlackReadError("conversations.replies", err);
    }
    return {
      channel,
      threadTs,
      order: "oldest_first",
      messages: (response.messages ?? []).map((m) =>
        toHistoryMessage(channel, m as RawSlackMessage)
      ),
      ...pageContinuation(response),
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

function historyArgs(query: SlackHistoryQuery) {
  return {
    limit: query.limit,
    ...(query.oldest ? { oldest: query.oldest } : {}),
    ...(query.latest ? { latest: query.latest } : {}),
    ...(query.inclusive ? { inclusive: true } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  };
}

function pageContinuation(response: {
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}): { hasMore: boolean; nextCursor?: string } {
  const cursor = response.response_metadata?.next_cursor;
  return {
    hasMore: Boolean(response.has_more || cursor),
    ...(cursor ? { nextCursor: cursor } : {}),
  };
}
