import { beforeEach, describe, expect, it, vi } from "vitest";

type SocketEnvelope = { type: string; body: unknown; ack: () => Promise<void> };
const mock = vi.hoisted(() => ({
  listeners: new Map<string, (envelope: SocketEnvelope) => Promise<void>>(),
}));

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: class {
    on(name: string, listener: (envelope: SocketEnvelope) => Promise<void>) {
      mock.listeners.set(name, listener);
    }
    async start() {}
    async disconnect() {}
  },
}));

import { SlackSocketSource } from "./socket-source.js";

describe("Slack Socket Mode delivery", () => {
  beforeEach(() => mock.listeners.clear());

  it("receives Events API messages through the SDK's slack_event emitter", async () => {
    const onMessage = vi.fn(async () => {});
    const ack = vi.fn(async () => {});
    await new SlackSocketSource("app-token").start(onMessage);

    expect(mock.listeners.has("slack_event")).toBe(true);
    await mock.listeners.get("slack_event")?.({
      type: "events_api",
      body: {
        event_id: "Ev1",
        event: {
          type: "message",
          channel_type: "im",
          channel: "D1",
          ts: "1720000000.000001",
          user: "U1",
          text: "hello",
        },
      },
      ack,
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "D1", eventId: "Ev1" })
    );
    expect(ack).toHaveBeenCalledOnce();
  });
});
