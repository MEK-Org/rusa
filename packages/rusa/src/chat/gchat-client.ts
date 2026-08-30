import { defaultGchatConfigDir, GchatOAuth } from "./gchat-oauth.js";
import {
  type ChatAttachment,
  type ChatClient,
  type ChatMessagePage,
  type ChatReadMessage,
  type ChatSendMessageOptions,
  type ChatSpace,
  type ChatSpaceMember,
  type ChatSpaceMemberPage,
  type ChatSpacePage,
  type ChatUploadAttachmentResult,
  type ListChatMessagesOptions,
  type ListChatSpaceMembersOptions,
  type ListChatSpacesOptions,
  MAX_CHAT_ATTACHMENT_BYTES,
  MESSAGE_ATTACHMENT_NAME_RE,
} from "./types.js";

export { defaultGchatConfigDir, type GchatIdentity, loadGchatIdentity } from "./gchat-oauth.js";

const CHAT_API = "https://chat.googleapis.com/v1";
const EYES = "\u{1F440}"; // 👀

/**
 * Google Chat REST client authenticated as the gchat user-OAuth identity
 * (`client.json` + `token.json` produced by `gchat-auth`). Mirrors the proven
 * Python `gchat` CLI: trade the refresh token for an access token (cached by
 * {@link GchatOAuth}) and call the Chat REST API as that user.
 */
export class GchatClient implements ChatClient {
  private readonly oauth: GchatOAuth;
  private readonly maxSizeBytes: number;

  constructor(configDir = defaultGchatConfigDir(), maxSizeBytes = MAX_CHAT_ATTACHMENT_BYTES) {
    this.oauth = new GchatOAuth(configDir);
    this.maxSizeBytes = maxSizeBytes;
  }

  private token(): Promise<string> {
    return this.oauth.token();
  }

  private async call(
    method: string,
    path: string,
    query?: Record<string, string>,
    body?: unknown
  ): Promise<unknown> {
    const token = await this.token();
    const qs =
      query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : "";
    const resp = await fetch(`${CHAT_API}/${path}${qs}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(
        `gchat ${method} ${path} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    return resp.json();
  }

  async react(messageName: string, emoji: string = EYES): Promise<void> {
    await this.call("POST", `${messageName}/reactions`, undefined, { emoji: { unicode: emoji } });
  }

  async getMessage(messageName: string): Promise<ChatReadMessage> {
    return (await this.call("GET", messageName)) as ChatReadMessage;
  }

  async listMessages(
    spaceName: string,
    options: ListChatMessagesOptions = {}
  ): Promise<ChatMessagePage> {
    const query: Record<string, string> = {};
    if (options.pageSize !== undefined) query.pageSize = String(options.pageSize);
    if (options.pageToken) query.pageToken = options.pageToken;

    const filterClauses: string[] = [];
    if (options.threadName) {
      filterClauses.push(`thread.name = ${options.threadName}`);
    }
    if (options.createdAfter) {
      filterClauses.push(`createTime > "${options.createdAfter}"`);
    }
    if (options.createdBefore) {
      filterClauses.push(`createTime < "${options.createdBefore}"`);
    }
    if (filterClauses.length > 0) {
      query.filter = filterClauses.join(" AND ");
    }

    if (options.orderBy) {
      query.orderBy = options.orderBy === "ASC" ? "createTime asc" : "createTime desc";
    }
    if (options.showDeleted !== undefined) query.showDeleted = String(options.showDeleted);

    const result = (await this.call("GET", `${spaceName}/messages`, query)) as {
      messages?: ChatReadMessage[];
      nextPageToken?: string;
    };
    return {
      messages: result.messages ?? [],
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    };
  }

  /**
   * List one page of the spaces this identity is a member of (`GET /v1/spaces`
   * returns exactly that — membership, not everything in the domain). This is
   * what makes the distiller's chat read set a *measurement* instead of a
   * hand-maintained assertion : a space nobody remembered to list is no
   * longer a silent hole.
   */
  async listSpaces(options: ListChatSpacesOptions = {}): Promise<ChatSpacePage> {
    const query: Record<string, string> = {};
    if (options.pageSize !== undefined) query.pageSize = String(options.pageSize);
    if (options.pageToken) query.pageToken = options.pageToken;
    const result = (await this.call("GET", "spaces", query)) as {
      spaces?: ChatSpace[];
      nextPageToken?: string;
    };
    return {
      spaces: result.spaces ?? [],
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    };
  }

  async listSpaceMembers(
    spaceName: string,
    options: ListChatSpaceMembersOptions = {}
  ): Promise<ChatSpaceMemberPage> {
    const query: Record<string, string> = {};
    if (options.pageSize !== undefined) query.pageSize = String(options.pageSize);
    if (options.pageToken) query.pageToken = options.pageToken;
    const result = (await this.call("GET", `${spaceName}/members`, query)) as {
      memberships?: Array<{
        state?: string;
        member?: ChatSpaceMember;
      }>;
      nextPageToken?: string;
    };
    const members = (result.memberships ?? [])
      .filter((membership) => membership.state === undefined || membership.state === "JOINED")
      .map((membership) => membership.member)
      .filter((member): member is ChatSpaceMember => Boolean(member?.name));
    return {
      members,
      ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    };
  }

  /**
   * Resolve a space's type (e.g. `DIRECT_MESSAGE`, `SPACE`). The message.created
   * event payload omits this, so we fetch it (callers should cache).
   */
  async getSpaceType(spaceName: string): Promise<string> {
    const r = (await this.call("GET", spaceName)) as { spaceType?: string; type?: string };
    return r.spaceType ?? r.type ?? "UNKNOWN";
  }

  /**
   * Read one attachment's metadata.
   *
   * Google gates `spaces.messages.attachments.get` behind the `chat.bot` scope,
   * which belongs to a Chat *app* identity and can never be granted to a user
   * OAuth consent — so calling it as the gchat user always 403s
   * `ACCESS_TOKEN_SCOPE_INSUFFICIENT`. `messages.get` is satisfied by our
   * `chat.messages` scope and already carries the same attachment records
   * inline, so we resolve metadata from the parent message instead.
   */
  async getAttachment(attachmentName: string): Promise<ChatAttachment> {
    const messageName = MESSAGE_ATTACHMENT_NAME_RE.exec(attachmentName)?.[1];
    if (!messageName) {
      throw new Error(
        `invalid attachment resource name: expected spaces/{space}/messages/{message}/attachments/{attachment} (got ${attachmentName})`
      );
    }
    const message = await this.getMessage(messageName);
    const attachment = message.attachment?.find((a) => a.name === attachmentName);
    if (!attachment) {
      throw new Error(`attachment ${attachmentName} is not present on message ${messageName}`);
    }
    return attachment;
  }

  private async readBodyWithLimit(resp: Response, maxBytes: number): Promise<Buffer> {
    const body = resp.body;
    if (!body) {
      return Buffer.alloc(0);
    }

    if (typeof (body as unknown as ReadableStream).getReader === "function") {
      const reader = (body as unknown as ReadableStream).getReader();
      const chunks: Uint8Array[] = [];
      let totalSize = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalSize += value.byteLength;
            if (totalSize > maxBytes) {
              throw new Error(
                `attachment size limit exceeded: attachment is larger than ${maxBytes} bytes`
              );
            }
            chunks.push(value);
          }
        }
      } catch (err) {
        try {
          await reader.cancel(err instanceof Error ? err.message : String(err));
        } catch (_) {}
        throw err;
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks.map((c) => Buffer.from(c)));
    }

    if (
      body &&
      typeof (body as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
    ) {
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array | string>) {
        const buf = Buffer.from(chunk);
        totalSize += buf.length;
        if (totalSize > maxBytes) {
          throw new Error(
            `attachment size limit exceeded: attachment is larger than ${maxBytes} bytes`
          );
        }
        chunks.push(buf);
      }
      return Buffer.concat(chunks);
    }

    const arrayBuffer = await resp.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(
        `attachment size limit exceeded: attachment is larger than ${maxBytes} bytes`
      );
    }
    return Buffer.from(arrayBuffer);
  }

  async downloadAttachment(resourceName: string): Promise<Buffer> {
    let dataRef: string;
    if (resourceName.startsWith("spaces/")) {
      const attachment = await this.getAttachment(resourceName);
      if (attachment.source === "DRIVE_FILE") {
        throw new Error(
          `attachment ${resourceName} is a Drive file; access it using the Drive API instead of downloadAttachment`
        );
      }
      const ref = attachment.attachmentDataRef?.resourceName;
      if (!ref) {
        throw new Error(`attachment ${resourceName} does not contain an attachmentDataRef`);
      }
      dataRef = ref;
    } else if (resourceName.startsWith("media/")) {
      dataRef = resourceName;
    } else {
      throw new Error(
        `invalid attachment resource name: expected spaces/... or media/... (got ${resourceName})`
      );
    }

    const token = await this.token();
    const dataRefPath = dataRef.startsWith("media/") ? dataRef.slice("media/".length) : dataRef;
    const encoded = encodeURIComponent(dataRefPath);
    const resp = await fetch(`${CHAT_API}/media/${encoded}?alt=media`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!resp.ok) {
      throw new Error(
        `gchat download attachment ${resourceName} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    const contentLength = resp.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > this.maxSizeBytes) {
      throw new Error(
        `attachment size limit exceeded: attachment is larger than ${this.maxSizeBytes} bytes`
      );
    }
    return this.readBodyWithLimit(resp, this.maxSizeBytes);
  }

  async uploadAttachment(
    spaceName: string,
    filename: string,
    content: Buffer | Uint8Array,
    mimeType = "application/octet-stream"
  ): Promise<ChatUploadAttachmentResult> {
    const size = Buffer.isBuffer(content) ? content.length : content.byteLength;
    if (size > this.maxSizeBytes) {
      throw new Error(
        `attachment size limit exceeded: attachment is larger than ${this.maxSizeBytes} bytes`
      );
    }
    const token = await this.token();
    const meta = JSON.stringify({ filename });
    const boundary = `====mcboundary${Date.now()}`;
    const pre = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`;
    const post = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
      Buffer.from(pre, "utf8"),
      Buffer.isBuffer(content) ? content : Buffer.from(content),
      Buffer.from(post, "utf8"),
    ]);

    const resp = await fetch(
      `https://chat.googleapis.com/upload/v1/${spaceName}/attachments:upload?upload_type=multipart`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );
    if (!resp.ok) {
      throw new Error(
        `gchat upload attachment ${spaceName} ${filename} -> HTTP ${resp.status} ${(await resp.text()).slice(0, 300)}`
      );
    }
    return (await resp.json()) as ChatUploadAttachmentResult;
  }

  async send(
    spaceName: string,
    text: string,
    opts?: ChatSendMessageOptions
  ): Promise<{ name: string }> {
    const body: Record<string, unknown> = { text };
    if (opts?.attachments && opts.attachments.length > 0) {
      body.attachment = opts.attachments.map((a) => {
        if (a.attachmentDataRef) return { attachmentDataRef: a.attachmentDataRef };
        if (a.resourceName) return { attachmentDataRef: { resourceName: a.resourceName } };
        return a;
      });
    }
    const query: Record<string, string> = {};
    if (opts?.threadName) {
      body.thread = { name: opts.threadName };
      query.messageReplyOption = "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD";
    }
    const r = (await this.call("POST", `${spaceName}/messages`, query, body)) as { name: string };
    return { name: r.name };
  }
}
