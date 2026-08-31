/**
 * Google Chat integration seam.
 *
 * Inbound chat arrives through a {@link ChatSource} (production: a Pub/Sub
 * pull subscription fed by the Workspace Events API; tests: a fake). Outbound
 * actions go through a {@link ChatClient} acting as the authenticated gchat
 * user. Keeping both behind interfaces lets the actor-mesh wiring swap real
 * vs. fake implementations without touching call sites (mirrors the
 * everything-is-MCP direction).
 */

export const MAX_CHAT_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50MB default

/**
 * Exact grammar of a message-attachment resource name. Capture group 1 is the
 * parent message name, which is where an attachment's metadata actually lives
 * (`spaces.messages.attachments.get` is `chat.bot`-gated, `messages.get` is not).
 */
export const MESSAGE_ATTACHMENT_NAME_RE = /^(spaces\/[^/]+\/messages\/[^/]+)\/attachments\/[^/]+$/;

/** Opaque media token accepted directly by `media.download`. */
export const MEDIA_TOKEN_RE = /^media\/.+$/;

export interface ChatAttachmentDataRef {
  /** Resource name for the uploaded attachment media. */
  resourceName?: string;
}

export interface ChatDriveDataRef {
  /** Drive file ID. */
  driveFileId?: string;
}

/** A Google Chat attachment. */
export interface ChatAttachment {
  /** Full attachment resource name: `spaces/{s}/messages/{m}/attachments/{a}`. */
  name?: string;
  /** Original filename of the attachment. */
  contentName?: string;
  /** MIME type of the attachment. */
  contentType?: string;
  /** Reference to uploaded attachment data. */
  attachmentDataRef?: ChatAttachmentDataRef;
  /** Reference to a Google Drive file. */
  driveDataRef?: ChatDriveDataRef;
  /** Thumbnail URL if available. */
  thumbnailUri?: string;
  /** Download URL if available. */
  downloadUri?: string;
  /** Source of the attachment: `DRIVE_FILE` | `UPLOADED_CONTENT` | other. */
  source?: string;
}

/** A normalized inbound Google Chat message. */
export interface ChatMessage {
  /** Full message resource name: `spaces/{s}/messages/{t}.{m}`. */
  name: string;
  /** Space resource name: `spaces/{s}`. */
  spaceName: string;
  /** `DIRECT_MESSAGE` | `SPACE` | `GROUP_CHAT` | other. */
  spaceType: string;
  /** Thread resource name `spaces/{s}/threads/{t}` when present. */
  threadName?: string;
  /** Sender resource name: `users/{id}`. */
  senderName: string;
  senderDisplayName?: string;
  /** Plain-text body. */
  text: string;
  /** RFC3339 create time, when available. */
  createTime?: string;
  /** True if the message @mentions the authenticated user. */
  mentionsSelf: boolean;
  /** True for a 1:1 DM or a room containing only self and one human. */
  isDirectMessage: boolean;
  /** Attachments included on the inbound message. */
  attachments?: ChatAttachment[];
}

/** Inbound chat event source. */
export interface ChatSource {
  /** Start delivering messages to `onMessage`; resolves once listening. */
  start(onMessage: (msg: ChatMessage) => void | Promise<void>): Promise<void>;
  /** Stop delivering and release resources. */
  close(): Promise<void>;
}

/** A Google Chat message returned by the source-backed read API. */
export interface ChatReadMessage {
  /** Full message resource name: `spaces/{s}/messages/{m}`. */
  name: string;
  text?: string;
  formattedText?: string;
  sender?: {
    name?: string;
    displayName?: string;
    type?: string;
  };
  thread?: {
    name?: string;
  };
  createTime?: string;
  lastUpdateTime?: string;
  deleteTime?: string;
  /** Attachments included on the message. */
  attachment?: ChatAttachment[];
}

export interface ListChatMessagesOptions {
  pageSize?: number;
  pageToken?: string;
  threadName?: string;
  orderBy?: "ASC" | "DESC";
  createdAfter?: string;
  createdBefore?: string;
  showDeleted?: boolean;
}

export interface ChatMessagePage {
  messages: ChatReadMessage[];
  nextPageToken?: string;
}

/** A Google Chat space the authenticated user is a member of. */
export interface ChatSpace {
  /** Space resource name: `spaces/{s}`. */
  name: string;
  /** `SPACE` | `GROUP_CHAT` | `DIRECT_MESSAGE` | other. */
  spaceType?: string;
  displayName?: string;
}

export interface ListChatSpacesOptions {
  pageSize?: number;
  pageToken?: string;
}

export interface ChatSpacePage {
  spaces: ChatSpace[];
  nextPageToken?: string;
}

/** A user currently joined to a Google Chat space. */
export interface ChatSpaceMember {
  /** User resource name: `users/{id}`. */
  name: string;
  /** `HUMAN` | `BOT` | other. */
  type?: string;
}

export interface ListChatSpaceMembersOptions {
  pageSize?: number;
  pageToken?: string;
}

export interface ChatSpaceMemberPage {
  members: ChatSpaceMember[];
  nextPageToken?: string;
}

export interface ChatSendMessageAttachment {
  /** Resource name of an uploaded attachment. */
  resourceName?: string;
  /** Attachment data reference object. */
  attachmentDataRef?: ChatAttachmentDataRef;
}

export interface ChatSendMessageOptions {
  threadName?: string;
  attachments?: ChatSendMessageAttachment[];
}

export interface ChatUploadAttachmentResult {
  attachmentDataRef: {
    resourceName: string;
  };
}

/** Chat actions performed as the authenticated user. */
export interface ChatClient {
  /** Read one message by its full Google Chat resource name. */
  getMessage(messageName: string): Promise<ChatReadMessage>;
  /** List one page of messages in a space, optionally narrowed to a thread. */
  listMessages(spaceName: string, options?: ListChatMessagesOptions): Promise<ChatMessagePage>;
  /** List one page of the spaces the authenticated user is a member of. */
  listSpaces(options?: ListChatSpacesOptions): Promise<ChatSpacePage>;
  /** List one page of the users currently joined to a space. */
  listSpaceMembers(
    spaceName: string,
    options?: ListChatSpaceMembersOptions
  ): Promise<ChatSpaceMemberPage>;
  /** Add a reaction (default 👀) to a message. */
  react(messageName: string, emoji?: string): Promise<void>;
  /** Send a message to a space, optionally replying within a thread and attaching documents. */
  send(spaceName: string, text: string, opts?: ChatSendMessageOptions): Promise<{ name: string }>;
  /** Read attachment metadata by its full Google Chat resource name. */
  getAttachment(attachmentName: string): Promise<ChatAttachment>;
  /** Download an attachment's binary content by its resource name (or attachmentDataRef resourceName). */
  downloadAttachment(resourceName: string): Promise<Buffer>;
  /** Upload a file as an attachment to a space, returning its attachmentDataRef for use in send(). */
  uploadAttachment(
    spaceName: string,
    filename: string,
    content: Buffer | Uint8Array,
    mimeType?: string
  ): Promise<ChatUploadAttachmentResult>;
}
