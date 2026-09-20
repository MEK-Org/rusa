import { SocketModeClient } from "@slack/socket-mode";

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
