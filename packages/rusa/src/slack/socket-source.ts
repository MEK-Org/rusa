import { SocketModeClient } from "@slack/socket-mode";
import type { DurableEventDelivery } from "../runtime/event-manager.js";

export interface SlackInboundMessage {
  channel: string;
  ts: string;
  text: string;
  user: string;
  threadTs?: string;
  isDirectMessage: boolean;
  eventId: string;
}

export function parseSlackEvent(body: unknown): SlackInboundMessage | null {
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
  if (event.type === "message" && event.channel_type !== "im") return null;
  if (event.subtype || event.bot_id || !event.user || !event.channel || !event.ts) return null;
  return {
    channel: event.channel,
    ts: event.ts,
    text: event.text ?? "",
    user: event.user,
    threadTs: event.thread_ts,
    isDirectMessage: event.channel_type === "im",
    eventId: envelope.event_id ?? `${event.channel}:${event.ts}`,
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

  async start(onMessage: (message: SlackInboundMessage) => Promise<void>): Promise<void> {
    this.socket.on("slack_event", async ({ body, type, ack }) => {
      if (type !== "events_api") {
        await ack();
        return;
      }
      // Ignore irrelevant events promptly. A relevant event is acknowledged only
      // after the durable inbox accepts it, so Slack can retry a failed delivery.
      const message = parseSlackEvent(body);
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
