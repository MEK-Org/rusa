import { SocketModeClient } from "@slack/socket-mode";
import type { ChatWakeMode } from "../chat/wake-mode.js";
import type { DurableEventDelivery, RawSlackIntegrationEvent } from "../runtime/event-manager.js";
import { verifiedSenderWorkspace } from "./sender-workspace.js";
import {
  mentionsSlackUser,
  type SlackWakeFacts,
  slackConversationKind,
  slackMessageWakes,
} from "./wake-mode.js";

export interface SlackInboundMessage extends SlackWakeFacts {
  channel: string;
  ts: string;
  text: string;
  user: string;
  threadTs?: string;
  /** The envelope that carried this message, kept for diagnostics only. */
  eventId: string;
  /** The sender's verified workspace (#1038); absent when it cannot be proven. */
  workspaceId?: string;
}

/**
 * Normalize one Events API envelope into the message it carries, or `null`
 * when it is not a human message this source handles: another event type, an
 * edit/delete/system subtype, a bot or the installed bot itself, or an ordinary
 * message from a conversation type this source does not support. Wake policy
 * is applied separately, by {@link slackMessageWakes}.
 */
export function parseSlackEvent(body: unknown, selfUserId?: string): SlackInboundMessage | null {
  if (!body || typeof body !== "object") return null;
  const envelope = body as {
    event_id?: string;
    event?: {
      type?: string;
      subtype?: string;
      channel?: string;
      channel_type?: string;
      ts?: string;
      thread_ts?: string;
      text?: string;
      user?: string;
      bot_id?: string;
    };
  };
  const event = envelope.event;
  if (!event || (event.type !== "app_mention" && event.type !== "message")) return null;
  if (event.subtype || event.bot_id || !event.user || !event.channel || !event.ts) return null;
  if (selfUserId && event.user === selfUserId) return null;
  const conversationKind = slackConversationKind(event.channel_type);
  if (event.type === "message" && conversationKind === undefined) return null;
  const text = typeof event.text === "string" ? event.text : "";
  return {
    channel: event.channel,
    ts: event.ts,
    text,
    user: event.user,
    threadTs: event.thread_ts,
    eventKind: event.type,
    conversationKind,
    mentionsSelf:
      event.type === "app_mention" || (selfUserId ? mentionsSlackUser(text, selfUserId) : false),
    eventId: envelope.event_id ?? `${event.channel}:${event.ts}`,
  };
}

/**
 * What decides whether an arriving event wakes anyone. Both parts are read for
 * every event, so a stored mode change governs the next one without a restart.
 */
export interface SlackWakePolicy {
  /**
   * The installed bot's own Slack user id, or `undefined` while it is unknown.
   * It never waits, so no lookup stands between an event and its ack.
   */
  selfUserId?: () => string | undefined;
  /** The exact conversation's stored mode, or `undefined` for the default. */
  wakeModeFor: (channel: string) => ChatWakeMode | undefined;
}

const COMPATIBILITY_POLICY: SlackWakePolicy = { wakeModeFor: () => undefined };

/** The least wait before another identity lookup after one fails. */
const SELF_LOOKUP_COOLDOWN_MS = 30_000;

/**
 * Remember the installed bot's identity once it is known. The returned getter
 * never waits: it answers from what is already known and, while nothing is,
 * starts a lookup unless one is in flight. A failed lookup is reported and
 * retried on a later event, but not before Slack's retry-after has passed, nor
 * sooner than 30 seconds, so a rate limit is not met with a lookup per event.
 * Meanwhile the source knows no self user: a plain-text mention goes
 * undetected, though Slack's `app_mention` event still arrives, and the bot's
 * own posts are still dropped by their `bot_id`.
 */
export function rememberSlackSelf(
  identify: () => Promise<{ userId: string }>,
  onError: (error: unknown) => void
): () => string | undefined {
  let known: string | undefined;
  let lookup: Promise<void> | undefined;
  let retryAt = 0;
  return () => {
    if (known === undefined && !lookup && Date.now() >= retryAt) {
      lookup = Promise.resolve()
        .then(identify)
        .then(
          (self) => {
            known = self.userId;
          },
          (error: unknown) => {
            const retryAfter = (error as { retryAfter?: unknown } | undefined)?.retryAfter;
            const wait = typeof retryAfter === "number" ? retryAfter * 1000 : 0;
            retryAt = Date.now() + Math.max(wait, SELF_LOOKUP_COOLDOWN_MS);
            onError(error);
          }
        )
        .finally(() => {
          lookup = undefined;
        });
    }
    return known;
  };
}

/**
 * The durable inbox event for an admitted message. It is keyed by the message
 * itself, not the envelope: Slack sends one message as both `message` and
 * `app_mention`, each with its own event ID and retries, and every one of
 * those must land as a single inbox item per owner.
 */
export function slackInboxEvent(message: SlackInboundMessage): RawSlackIntegrationEvent {
  return {
    sourceType: "slack",
    rawPayload: {
      channel: message.channel,
      ts: message.ts,
      threadTs: message.threadTs,
      user: message.user,
      ...(message.workspaceId ? { workspaceId: message.workspaceId } : {}),
    },
    idempotencyKey: `${message.channel}:${message.ts}`,
    priority: "responsive",
    eventSummary: `Slack message from ${message.user}`,
  };
}

export class SlackSocketSource {
  private readonly socket: SocketModeClient;

  constructor(
    appToken: string,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly onEvent?: (event: {
      type?: string;
      channelType?: string;
      subtype?: string;
      accepted: boolean;
    }) => void
  ) {
    this.socket = new SocketModeClient({ appToken });
  }

  /**
   * `installationWorkspaceId` is the team this connection's bot token belongs
   * to. A message keeps a `workspaceId` only when its envelope agrees with it
   * (#1038); without one, no message carries a workspace.
   */
  async start(
    onMessage: (message: SlackInboundMessage) => Promise<void>,
    policy: SlackWakePolicy & { installationWorkspaceId?: string } = COMPATIBILITY_POLICY
  ): Promise<void> {
    this.socket.on("slack_event", async ({ body, type, ack }) => {
      if (type !== "events_api") {
        await ack();
        return;
      }
      // Ignore irrelevant events promptly. A relevant event is acknowledged only
      // after the durable inbox accepts it, so Slack can retry a failed delivery.
      const message = this.admit(body, policy);
      const incoming = (
        body as { event?: { type?: string; channel_type?: string; subtype?: string } }
      )?.event;
      this.onEvent?.({
        type: incoming?.type,
        channelType: incoming?.channel_type,
        subtype: incoming?.subtype,
        accepted: message !== null,
      });
      if (!message) {
        await ack();
        return;
      }
      const workspaceId = verifiedSenderWorkspace(body, policy.installationWorkspaceId);
      try {
        await onMessage(workspaceId === undefined ? message : { ...message, workspaceId });
        await ack();
      } catch (error) {
        this.onError(error);
      }
    });
    // Start the identity lookup while the socket connects.
    policy.selfUserId?.();
    await this.socket.start();
  }

  /**
   * The message an event carries when its conversation's policy says it wakes.
   * A policy read that fails is reported and treated as unset, so it can only
   * fall back to the compatibility default, never broaden coverage.
   */
  private admit(body: unknown, policy: SlackWakePolicy): SlackInboundMessage | null {
    const selfUserId = policy.selfUserId?.();
    const message = parseSlackEvent(body, selfUserId);
    if (!message) return null;
    let mode: ChatWakeMode | undefined;
    try {
      mode = policy.wakeModeFor(message.channel);
    } catch (error) {
      this.onError(error);
    }
    return slackMessageWakes(message, mode) ? message : null;
  }

  async close(): Promise<void> {
    await this.socket.disconnect();
  }
}

/**
 * Wrap inbox delivery so an accepted message gets an 👀 receipt on that exact
 * message, thread replies included (#609). A delivery that throws is never
 * acknowledged, so Slack retries it and no receipt is posted. The receipt is
 * fire-and-forget: its failure is reported, never retried, and never fails
 * the delivery, so it cannot make Slack redeliver an event the inbox holds.
 */
export function withReceiptReaction(
  deliver: (
    message: SlackInboundMessage
  ) => Promise<Pick<DurableEventDelivery, "entries" | "ownerIds">>,
  react: (channel: string, ts: string) => Promise<void>,
  onReactionError: (error: unknown, message: SlackInboundMessage) => void
): (message: SlackInboundMessage) => Promise<void> {
  return async (message) => {
    const delivery = await deliver(message);
    // A redelivered event inserts no new row but still resolves to its owners;
    // an event no subscription covers resolves to nobody and gets no receipt.
    if (delivery.entries.length === 0 && delivery.ownerIds.length === 0) return;
    let receipt: Promise<void>;
    try {
      receipt = react(message.channel, message.ts);
    } catch (error) {
      receipt = Promise.reject(error);
    }
    void receipt.catch((error: unknown) => {
      if (isAlreadyReacted(error)) return;
      onReactionError(error, message);
    });
  };
}

function isAlreadyReacted(error: unknown): boolean {
  return (error as { data?: { error?: unknown } } | null)?.data?.error === "already_reacted";
}
