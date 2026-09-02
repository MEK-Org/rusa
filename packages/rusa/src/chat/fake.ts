import {
  type ChatAttachment,
  type ChatClient,
  type ChatMessage,
  type ChatMessagePage,
  type ChatReadMessage,
  type ChatSendMessageAttachment,
  type ChatSendMessageOptions,
  type ChatSource,
  type ChatSpace,
  type ChatSpaceMember,
  type ChatSpaceMemberPage,
  type ChatSpacePage,
  type ChatUploadAttachmentResult,
  type ListChatMessagesOptions,
  type ListChatSpaceMembersOptions,
  type ListChatSpacesOptions,
  MAX_CHAT_ATTACHMENT_BYTES,
} from "./types.js";

/** In-memory {@link ChatSource} for tests/e2e: deliver messages via {@link emit}. */
export class FakeChatSource implements ChatSource {
  private handler: ((msg: ChatMessage) => void | Promise<void>) | null = null;

  async start(onMessage: (msg: ChatMessage) => void | Promise<void>): Promise<void> {
    this.handler = onMessage;
  }

  async close(): Promise<void> {
    this.handler = null;
  }

  /** Deliver a message as if it had arrived from Chat. */
  async emit(msg: ChatMessage): Promise<void> {
    if (!this.handler) throw new Error("FakeChatSource.emit called before start()");
    await this.handler(msg);
  }
}

/** Records outbound actions instead of calling the Chat API. */
export class FakeChatClient implements ChatClient {
  readonly maxSizeBytes: number;

  constructor(options?: { maxSizeBytes?: number }) {
    this.maxSizeBytes = options?.maxSizeBytes ?? MAX_CHAT_ATTACHMENT_BYTES;
  }

  readonly messages: ChatReadMessage[] = [];
  readonly reactions: { messageName: string; emoji: string }[] = [];
  readonly sent: {
    spaceName: string;
    text: string;
    threadName?: string;
    attachments?: ChatSendMessageAttachment[];
  }[] = [];
  /** Membership the fake reports from {@link listSpaces}; push to populate it. */
  readonly spaces: ChatSpace[] = [];
  /** Current members by space resource name. */
  readonly spaceMembers = new Map<string, ChatSpaceMember[]>();
  /** Mock attachment data keyed by resource name or attachment name. */
  readonly attachments = new Map<string, { metadata: ChatAttachment; data: Buffer }>();
  /** Log of uploaded attachments. */
  readonly uploadedAttachments: Array<{
    spaceName: string;
    filename: string;
    content: Buffer;
    mimeType?: string;
    resourceName: string;
  }> = [];

  async getSpace(spaceName: string): Promise<ChatSpace> {
    const space = this.spaces.find((s) => s.name === spaceName);
    if (!space) throw new Error(`space not found: ${spaceName}`);
    return space;
  }

  async getMessage(messageName: string): Promise<ChatReadMessage> {
    const message = this.messages.find((candidate) => candidate.name === messageName);
    if (!message) throw new Error(`message not found: ${messageName}`);
    return message;
  }

  async listMessages(
    spaceName: string,
    options: ListChatMessagesOptions = {}
  ): Promise<ChatMessagePage> {
    const spacePrefix = `${spaceName}/messages/`;
    let messages = this.messages.filter(
      (message) =>
        message.name.startsWith(spacePrefix) &&
        (!options.threadName || message.thread?.name === options.threadName) &&
        (!options.createdAfter || (message.createTime ?? "") > options.createdAfter) &&
        (!options.createdBefore || (message.createTime ?? "") < options.createdBefore)
    );
    messages = messages.sort((a, b) => (a.createTime ?? "").localeCompare(b.createTime ?? ""));
    if (options.orderBy === "DESC") messages.reverse();

    const offset = options.pageToken ? Number.parseInt(options.pageToken, 10) : 0;
    const pageSize = options.pageSize ?? 25;
    const page = messages.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      messages: page,
      ...(nextOffset < messages.length ? { nextPageToken: String(nextOffset) } : {}),
    };
  }

  async listSpaces(options: ListChatSpacesOptions = {}): Promise<ChatSpacePage> {
    const offset = options.pageToken ? Number.parseInt(options.pageToken, 10) : 0;
    const pageSize = options.pageSize ?? 100;
    const page = this.spaces.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      spaces: page,
      ...(nextOffset < this.spaces.length ? { nextPageToken: String(nextOffset) } : {}),
    };
  }

  async listSpaceMembers(
    spaceName: string,
    options: ListChatSpaceMembersOptions = {}
  ): Promise<ChatSpaceMemberPage> {
    const members = this.spaceMembers.get(spaceName) ?? [];
    const offset = options.pageToken ? Number.parseInt(options.pageToken, 10) : 0;
    const pageSize = options.pageSize ?? 100;
    const page = members.slice(offset, offset + pageSize);
    const nextOffset = offset + page.length;
    return {
      members: page,
      ...(nextOffset < members.length ? { nextPageToken: String(nextOffset) } : {}),
    };
  }

  async react(messageName: string, emoji = "\u{1F440}"): Promise<void> {
    this.reactions.push({ messageName, emoji });
  }

  async getAttachment(attachmentName: string): Promise<ChatAttachment> {
    const entry = this.attachments.get(attachmentName);
    if (entry) return entry.metadata;
    for (const msg of this.messages) {
      const match = msg.attachment?.find(
        (a) => a.name === attachmentName || a.attachmentDataRef?.resourceName === attachmentName
      );
      if (match) return match;
    }
    throw new Error(`attachment not found: ${attachmentName}`);
  }

  async downloadAttachment(resourceName: string): Promise<Buffer> {
    let targetRef: string;
    if (resourceName.startsWith("spaces/")) {
      const metadata = await this.getAttachment(resourceName);
      if (metadata.source === "DRIVE_FILE") {
        throw new Error(
          `attachment ${resourceName} is a Drive file; access it using the Drive API instead of downloadAttachment`
        );
      }
      targetRef = metadata.attachmentDataRef?.resourceName ?? metadata.name ?? resourceName;
    } else if (resourceName.startsWith("media/")) {
      targetRef = resourceName;
    } else {
      throw new Error(
        `invalid attachment resource name: expected spaces/... or media/... (got ${resourceName})`
      );
    }

    let data: Buffer | undefined;
    const entry = this.attachments.get(targetRef);
    if (entry) {
      data = entry.data;
    } else {
      const uploaded = this.uploadedAttachments.find((u) => u.resourceName === targetRef);
      if (uploaded) {
        data = uploaded.content;
      } else {
        for (const [, v] of this.attachments.entries()) {
          if (
            v.metadata.attachmentDataRef?.resourceName === targetRef ||
            v.metadata.name === targetRef
          ) {
            data = v.data;
            break;
          }
        }
      }
    }
    if (!data) {
      throw new Error(`attachment not found: ${resourceName}`);
    }
    if (data.length > this.maxSizeBytes) {
      throw new Error(
        `attachment size limit exceeded: attachment is larger than ${this.maxSizeBytes} bytes`
      );
    }
    return data;
  }

  async uploadAttachment(
    spaceName: string,
    filename: string,
    content: Buffer | Uint8Array,
    mimeType?: string
  ): Promise<ChatUploadAttachmentResult> {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (buf.length > this.maxSizeBytes) {
      throw new Error(
        `attachment size limit exceeded: attachment is larger than ${this.maxSizeBytes} bytes`
      );
    }
    const resourceName = `${spaceName}/attachments/fake-${this.uploadedAttachments.length + 1}`;
    this.uploadedAttachments.push({
      spaceName,
      filename,
      content: buf,
      mimeType,
      resourceName,
    });
    this.attachments.set(resourceName, {
      metadata: {
        name: resourceName,
        contentName: filename,
        contentType: mimeType,
        attachmentDataRef: { resourceName },
        source: "UPLOADED_CONTENT",
      },
      data: buf,
    });
    return { attachmentDataRef: { resourceName } };
  }

  async send(
    spaceName: string,
    text: string,
    opts?: ChatSendMessageOptions
  ): Promise<{ name: string }> {
    this.sent.push({
      spaceName,
      text,
      threadName: opts?.threadName,
      ...(opts?.attachments ? { attachments: opts.attachments } : {}),
    });
    const msgName = `${spaceName}/messages/fake-${this.sent.length}`;
    const attachmentsList: ChatAttachment[] = (opts?.attachments ?? []).map((att) => {
      const ref = att.attachmentDataRef?.resourceName ?? att.resourceName;
      const uploaded = this.uploadedAttachments.find((u) => u.resourceName === ref);
      return {
        name: `${msgName}/attachments/${ref?.split("/").pop() ?? "att"}`,
        contentName: uploaded?.filename,
        contentType: uploaded?.mimeType,
        attachmentDataRef: ref ? { resourceName: ref } : undefined,
        source: "UPLOADED_CONTENT",
      };
    });
    this.messages.push({
      name: msgName,
      text,
      thread: opts?.threadName ? { name: opts.threadName } : undefined,
      createTime: new Date().toISOString(),
      ...(attachmentsList.length > 0 ? { attachment: attachmentsList } : {}),
    });
    return { name: msgName };
  }
}
