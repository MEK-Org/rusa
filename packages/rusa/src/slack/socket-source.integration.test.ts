import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableEventDelivery } from "../runtime/event-manager.js";

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

import {
  type SlackInboundMessage,
  SlackSocketSource,
  withReceiptReaction,
} from "./socket-source.js";

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

describe("Slack receipt reaction (#609)", () => {
  beforeEach(() => mock.listeners.clear());

  type Delivery = Pick<DurableEventDelivery, "entries" | "ownerIds">;
  const accepted: Delivery = {
    entries: [{ id: "entry-1" }] as unknown as Delivery["entries"],
    ownerIds: ["owner-1"],
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  function platformError(code: string) {
    return Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } });
  }

  async function receive(
    deliver: (message: SlackInboundMessage) => Promise<Delivery>,
    react: (channel: string, ts: string) => Promise<void>,
    event: Record<string, unknown>
  ) {
    const onReactionError = vi.fn();
    const onError = vi.fn();
    const ack = vi.fn(async () => {});
    await new SlackSocketSource("app-token", onError).start(
      withReceiptReaction(deliver, react, onReactionError)
    );
    await mock.listeners.get("slack_event")?.({
      type: "events_api",
      body: { event_id: "Ev1", event },
      ack,
    });
    // Let the fire-and-forget receipt settle.
    await settle();
    return { ack, onError, onReactionError };
  }

  const dm = {
    type: "message",
    channel_type: "im",
    channel: "D1",
    ts: "1720000000.000001",
    user: "U1",
    text: "hello",
  };
  const threadMention = {
    type: "app_mention",
    channel: "C1",
    ts: "1720000005.000002",
    thread_ts: "1720000000.000001",
    user: "U1",
    text: "<@B1> look",
  };

  it("reacts with eyes to a DM and a channel mention after inbox delivery", async () => {
    // Gate both sides: the receipt must wait for durable delivery, and the ack
    // must not wait for the receipt.
    let completeDelivery!: (delivery: Delivery) => void;
    const deliver = vi.fn(
      () =>
        new Promise<Delivery>((resolve) => {
          completeDelivery = resolve;
        })
    );
    let completeReaction!: () => void;
    const react = vi.fn(
      (_channel: string, _ts: string) =>
        new Promise<void>((resolve) => {
          completeReaction = resolve;
        })
    );
    const ack = vi.fn(async () => {});
    await new SlackSocketSource("app-token").start(withReceiptReaction(deliver, react, vi.fn()));
    const handled = mock.listeners.get("slack_event")?.({
      type: "events_api",
      body: { event_id: "Ev1", event: dm },
      ack,
    });

    await settle();
    expect(deliver).toHaveBeenCalledOnce();
    expect(react).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();

    completeDelivery(accepted);
    await settle();
    expect(react).toHaveBeenCalledExactlyOnceWith("D1", "1720000000.000001");
    expect(ack).toHaveBeenCalledOnce();

    completeReaction();
    await handled;

    deliver.mockImplementation(async () => accepted);
    react.mockImplementation(async () => {});
    await receive(deliver, react, { ...threadMention, thread_ts: undefined });
    expect(react).toHaveBeenLastCalledWith("C1", "1720000005.000002");
  });

  it("reacts to the reply itself, not its thread parent", async () => {
    const react = vi.fn(async () => {});
    await receive(async () => accepted, react, threadMention);
    expect(react).toHaveBeenCalledExactlyOnceWith("C1", "1720000005.000002");
  });

  it("posts no receipt and no ack when inbox delivery fails", async () => {
    const react = vi.fn(async () => {});
    const { ack, onError } = await receive(
      async () => {
        throw new Error("inbox unavailable");
      },
      react,
      dm
    );
    expect(react).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("ignores bot messages, edits, and channel chatter without delivering or reacting", async () => {
    const deliver = vi.fn(async () => accepted);
    const react = vi.fn(async () => {});
    for (const event of [
      { ...dm, bot_id: "B1" },
      { ...dm, subtype: "message_changed" },
      { ...dm, channel_type: "channel" },
    ]) {
      const { ack } = await receive(deliver, react, event);
      expect(ack).toHaveBeenCalledOnce();
    }
    expect(deliver).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
  });

  it("posts no receipt for an event no subscription accepted", async () => {
    const react = vi.fn(async () => {});
    const { ack } = await receive(async () => ({ entries: [], ownerIds: [] }), react, dm);
    expect(react).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
  });

  it("treats a redelivery's already_reacted as success", async () => {
    // A redelivered event inserts no new row but still resolves to its owner.
    const react = vi.fn(async () => {
      throw platformError("already_reacted");
    });
    const { ack, onReactionError } = await receive(
      async () => ({ entries: [], ownerIds: ["owner-1"] }),
      react,
      dm
    );
    expect(react).toHaveBeenCalledExactlyOnceWith("D1", "1720000000.000001");
    expect(onReactionError).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledOnce();
  });

  it("reports reaction failures without failing delivery or retrying", async () => {
    for (const react of [
      vi.fn(async () => {
        throw platformError("missing_scope");
      }),
      vi.fn(() => {
        throw new Error("client unavailable");
      }),
    ]) {
      const deliver = vi.fn(async () => accepted);
      const { ack, onError, onReactionError } = await receive(deliver, react, dm);
      expect(deliver).toHaveBeenCalledOnce();
      expect(react).toHaveBeenCalledOnce();
      expect(ack).toHaveBeenCalledOnce();
      expect(onError).not.toHaveBeenCalled();
      expect(onReactionError).toHaveBeenCalledExactlyOnceWith(
        expect.any(Error),
        expect.objectContaining({ channel: "D1", eventId: "Ev1" })
      );
    }
  });
});
