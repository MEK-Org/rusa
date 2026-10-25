import type { ChatAttachment, ChatMessage, ChatSpaceMember } from "./types.js";

/**
 * Parsing for Google Workspace Events `google.workspace.chat.message.v1.created`
 * payloads. The Pub/Sub message `data` (once base64-decoded) is JSON of the form
 * `{ "message": { …Chat message resource… } }`. Notably the resource's `space`
 * carries only `name` — not `spaceType` — so DM detection is resolved separately.
 */

interface RawSpace {
  name?: string;
  type?: string;
  spaceType?: string;
}

interface RawSender {
  name?: string;
  type?: string;
  displayName?: string;
}

interface RawAnnotation {
  type?: string;
  userMention?: { user?: { name?: string } };
}

interface RawAttachment {
  name?: string;
  contentName?: string;
  contentType?: string;
  attachmentDataRef?: { resourceName?: string };
  driveDataRef?: { driveFileId?: string };
  thumbnailUri?: string;
  downloadUri?: string;
  source?: string;
}

interface RawMessage {
  name?: string;
  sender?: RawSender;
  createTime?: string;
  text?: string;
  formattedText?: string;
  argumentText?: string;
  thread?: { name?: string };
  space?: RawSpace;
  annotations?: RawAnnotation[];
  attachment?: RawAttachment[];
}

export interface ParsedChatMessage {
  name: string;
  spaceName: string;
  /** Present only if the payload carried it (usually absent — resolve separately). */
  spaceType?: string;
  threadName?: string;
  senderName: string;
  senderType?: string;
  senderDisplayName?: string;
  text: string;
  createTime?: string;
  mentionedUserNames: string[];
  attachments?: ChatAttachment[];
}

/**
 * Parse the decoded `data` payload of a chat message event into the message
 * resource fields. Returns null when the payload is not a usable chat message.
 */
export function parseChatMessageData(data: string): ParsedChatMessage | null {
  let payload: { message?: RawMessage };
  try {
    payload = JSON.parse(data) as { message?: RawMessage };
  } catch {
    return null;
  }
  const m = payload.message;
  if (!m?.name || !m.space?.name || !m.sender?.name) return null;

  const mentioned: string[] = [];
  for (const a of m.annotations ?? []) {
    if (a.type === "USER_MENTION" && a.userMention?.user?.name) {
      mentioned.push(a.userMention.user.name);
    }
  }

  const attachments: ChatAttachment[] | undefined = m.attachment?.map((a) => ({
    ...(a.name ? { name: a.name } : {}),
    ...(a.contentName ? { contentName: a.contentName } : {}),
    ...(a.contentType ? { contentType: a.contentType } : {}),
    ...(a.attachmentDataRef ? { attachmentDataRef: a.attachmentDataRef } : {}),
    ...(a.driveDataRef ? { driveDataRef: a.driveDataRef } : {}),
    ...(a.thumbnailUri ? { thumbnailUri: a.thumbnailUri } : {}),
    ...(a.downloadUri ? { downloadUri: a.downloadUri } : {}),
    ...(a.source ? { source: a.source } : {}),
  }));

  return {
    name: m.name,
    spaceName: m.space.name,
    spaceType: m.space.spaceType ?? m.space.type,
    threadName: m.thread?.name,
    senderName: m.sender.name,
    senderType: m.sender.type,
    senderDisplayName: m.sender.displayName,
    text: m.text ?? m.formattedText ?? m.argumentText ?? "",
    createTime: m.createTime,
    mentionedUserNames: mentioned,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
  };
}

/** Build the normalized {@link ChatMessage} from a parse, space type, and current membership. */
export function toChatMessage(
  parsed: ParsedChatMessage,
  selfUserId: string,
  spaceType: string,
  spaceMembers: readonly ChatSpaceMember[] = []
): ChatMessage {
  const isTwoPersonSpace =
    spaceMembers.length === 2 &&
    spaceMembers.filter((member) => member.name === selfUserId).length === 1 &&
    spaceMembers.filter((member) => member.name !== selfUserId && member.type === "HUMAN")
      .length === 1;
  return {
    name: parsed.name,
    spaceName: parsed.spaceName,
    spaceType,
    threadName: parsed.threadName,
    senderName: parsed.senderName,
    senderDisplayName: parsed.senderDisplayName,
    text: parsed.text,
    createTime: parsed.createTime,
    mentionsSelf: parsed.mentionedUserNames.includes(selfUserId),
    isDirectMessage: spaceType === "DIRECT_MESSAGE" || isTwoPersonSpace,
    ...(parsed.attachments && parsed.attachments.length > 0
      ? { attachments: parsed.attachments }
      : {}),
  };
}
