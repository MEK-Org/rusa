import { describe, expect, it } from "vitest";
import { parseSlackEvent } from "./socket-source.js";

describe("Slack event ingestion", () => {
  it("accepts mentions and DMs with a stable event ID", () => {
    expect(
      parseSlackEvent({
        event_id: "Ev1",
        event: {
          type: "app_mention",
          channel: "C1",
          ts: "1720000000.000001",
          user: "U1",
          text: "hi",
        },
      })
    ).toMatchObject({ channel: "C1", eventId: "Ev1", isDirectMessage: false });
    expect(
      parseSlackEvent({
        event_id: "Ev2",
        event: {
          type: "message",
          channel_type: "im",
          channel: "D1",
          ts: "1720000001.000001",
          thread_ts: "1720000000.000001",
          user: "U1",
          text: "reply",
        },
      })
    ).toMatchObject({
      channel: "D1",
      eventId: "Ev2",
      isDirectMessage: true,
      threadTs: "1720000000.000001",
    });
  });

  it("ignores bot messages, edits, and ordinary channel chatter", () => {
    const base = { type: "message", channel: "C1", ts: "1720000000.000001", user: "U1" };
    expect(parseSlackEvent({ event: { ...base, channel_type: "channel" } })).toBeNull();
    expect(parseSlackEvent({ event: { ...base, channel_type: "im", bot_id: "B1" } })).toBeNull();
    expect(
      parseSlackEvent({ event: { ...base, channel_type: "im", subtype: "message_changed" } })
    ).toBeNull();
  });
});
