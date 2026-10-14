import { SocketModeClient } from "@slack/socket-mode";
import type { DurableEventDelivery, RawSlackIntegrationEvent } from "../runtime/event-manager.js";
import {
  mentionsSlackUser,
  type SlackWakeFacts,
  type SlackWakeMode,
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
  /** The installed bot's own Slack user id, or `undefined` when it is unknown. */
  selfUserId?: () => Promise<string | undefined>;
  /** The exact conversation's stored mode, or `undefined` for the default. */
  wakeModeFor: (channel: string) => SlackWakeMode | undefined;
}

const COMPATIBILITY_POLICY: SlackWakePolicy = { wakeModeFor: () => undefined };

/**
 * Remember the installed bot's identity once it is known. A failed lookup is
 * reported and retried on a later event; meanwhile the source knows no self
 * user, which only narrows what wakes: a plain-text mention goes undetected
 * and Slack's `app_mention` event still arrives.
 */
export function rememberSlackSelf(
  identify: () => Promise<{ userId: string }>,
  onError: (error: unknown) => void
): () => Promise<string | undefined> {
  let known: Promise<string> | undefined;
  return async () => {
    known ??= identify().then((self) => self.userId);
    try {
      return await known;
    } catch (error) {
      known = undefined;
      onError(error);
      return undefined;
    }
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

  async start(
    onMessage: (message: SlackInboundMessage) => Promise<void>,
    policy: SlackWakePolicy = COMPATIBILITY_POLICY
  ): Promise<void> {
    this.socket.on("slack_event", async ({ body, type, ack }) => {
      if (type !== "events_api") {
        await ack();
        return;
      }
      // Ignore irrelevant events promptly. A relevant event is acknowledged only
      // after the durable inbox accepts it, so Slack can retry a failed delivery.
      const message = await this.admit(body, policy);
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
      try {
        await onMessage(message);
        await ack();
      } catch (error) {
        this.onError(error);
      }
    });
    await this.socket.start();
  }

  /**
   * The message an event carries when its conversation's policy says it wakes.
   * A policy read that fails is reported and treated as unset, so it can only
   * fall back to the compatibility default, never broaden coverage.
   */
  private async admit(body: unknown, policy: SlackWakePolicy): Promise<SlackInboundMessage | null> {
    const selfUserId = await policy.selfUserId?.();
    const message = parseSlackEvent(body, selfUserId);
    if (!message) return null;
    let mode: SlackWakeMode | undefined;
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
