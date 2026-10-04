import type { MeshChat, MeshChatRepository } from "../db/repositories/mesh-chat-repository.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import type { InboxRepository } from "../repositories/inbox-repository.js";
import { readAcceptedHumanInput } from "./accepted-human-input.js";

export interface RoutedHumanReply {
  senderId: string;
  recipientId: string;
  body: string;
  sessionId: string;
  originalActorId: string;
  replyInput: { actorId: string; entryId: string };
}

/** The event locates proof; only an actor-owned accepted chain grants additional visibility. */
export function routedReplyActor(
  inbox: InboxRepository | undefined,
  chat: MeshChat,
  event: Pick<MeshEvent, "id" | "kind" | "actorId" | "payload"> | null
): string | null {
  if (!inbox || !event || event.kind !== "message_sent" || !event.payload) return null;
  try {
    const proof = JSON.parse(event.payload);
    if (
      proof.messageId !== chat.id ||
      proof.to !== chat.recipientId ||
      event.actorId !== chat.senderId ||
      proof.replyInput?.actorId !== chat.senderId ||
      typeof proof.replyInput?.entryId !== "string" ||
      typeof proof.originalActorId !== "string"
    )
      return null;
    const { binding } = readAcceptedHumanInput(inbox, chat.senderId, proof.replyInput.entryId);
    return binding.principalId === chat.recipientId &&
      binding.textRoute?.actorId === proof.originalActorId &&
      binding.textRoute?.sessionId === chat.sessionId
      ? proof.originalActorId
      : null;
  } catch {
    return null;
  }
}

/** HTTP history and live SSE expose the same validated route, never raw caller metadata. */
export function sanitizeRoutedReplyEvent(
  event: MeshEvent,
  inbox: InboxRepository | undefined,
  chatStore: Pick<MeshChatRepository, "getById" | "routedReplyProof"> | undefined
): MeshEvent {
  if (!event.payload) return event;
  try {
    const payload = JSON.parse(event.payload);
    if (!("originalActorId" in payload) && !("replyInput" in payload)) return event;
    const chat =
      typeof payload.messageId === "string" ? chatStore?.getById(payload.messageId) : null;
    const persisted = chat ? chatStore?.routedReplyProof(chat.id) : null;
    if (
      chat &&
      persisted?.id === event.id &&
      persisted.payload === event.payload &&
      routedReplyActor(inbox, chat, persisted)
    )
      return event;
    delete payload.originalActorId;
    delete payload.replyInput;
    return { ...event, payload: JSON.stringify(payload) };
  } catch {
    return { ...event, payload: null };
  }
}
