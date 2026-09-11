import type { MeshChat } from "../db/repositories/mesh-chat-repository.js";

/** Last durable session rows included in a voice handoff. */
export const MAX_VOICE_TRANSFER_CONTEXT_MESSAGES = 12;
/** Per-row body ceiling keeps one verbose reply from crowding out the handoff. */
export const MAX_VOICE_TRANSFER_MESSAGE_CHARS = 600;
/** Optional actor-authored note ceiling at the same durable inbox boundary. */
export const MAX_VOICE_TRANSFER_NOTE_CHARS = 2_000;

function boundedText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/**
 * Deterministically render the bounded, chronological `mesh_chat` projection
 * carried in a `voice.transfer` inbox hint. This has no model summarization:
 * it preserves the source rows' order and says when their bodies were clipped.
 */
export function renderVoiceTransferContext(
  messages: readonly MeshChat[],
  handoffNote?: string
): string {
  const rows = messages.map((message) => {
    const body = boundedText(message.body, MAX_VOICE_TRANSFER_MESSAGE_CHARS);
    return `${message.ts} ${message.senderId} → ${message.recipientId}: ${body}`;
  });
  const context = [
    "Bounded durable session context (oldest to newest):",
    ...(rows.length > 0 ? rows : ["(no durable mesh-chat rows recorded for this session)"]),
  ];
  const note = handoffNote?.trim();
  if (note) {
    context.push("Actor handoff note:", boundedText(note, MAX_VOICE_TRANSFER_NOTE_CHARS));
  }
  return context.join("\n");
}
