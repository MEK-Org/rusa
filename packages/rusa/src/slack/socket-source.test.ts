import { describe, expect, it } from "vitest";
import { parseSlackEvent } from "./socket-source.js";
import { slackMessageWakes } from "./wake-mode.js";

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
    ).toMatchObject({
      channel: "C1",
      eventId: "Ev1",
      eventKind: "app_mention",
      conversationKind: undefined,
      mentionsSelf: true,
    });
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
      eventKind: "message",
      conversationKind: "im",
      mentionsSelf: false,
      threadTs: "1720000000.000001",
    });
  });

  it("classifies conversations and recognizes only the bot's own mention", () => {
    const message = (channel_type: string, text: string) =>
      parseSlackEvent(
        {
          event: { type: "message", channel_type, channel: "X1", ts: "1.0", user: "U1", text },
        },
        "UBOT"
      );
    expect(message("group", "hi")?.conversationKind).toBe("channel");
    expect(message("mpim", "hi")?.conversationKind).toBe("mpim");
    expect(message("app_home", "hi")).toBeNull();
    expect(message("im", "<@UBOT> hi")?.mentionsSelf).toBe(true);
    expect(message("im", "<@UBOT|rusa> hi")?.mentionsSelf).toBe(true);
    for (const text of ["@rusa hi", "<@UBOTX> hi", "<!here> hi", "<!channel>", "<!subteam^S1>"]) {
      expect(message("im", text)?.mentionsSelf, text).toBe(false);
    }
    // Without a known identity, no plain-text mention is recognized.
    expect(
      parseSlackEvent({
        event: {
          type: "message",
          channel_type: "im",
          channel: "D1",
          ts: "1.0",
          user: "U1",
          text: "<@UBOT>",
        },
      })?.mentionsSelf
    ).toBe(false);
  });

  it("ignores bot messages, edits, and ordinary channel chatter", () => {
    const base = { type: "message", channel: "C1", ts: "1720000000.000001", user: "U1" };
    // Channel chatter parses; the unset default policy is what declines it.
    const chatter = parseSlackEvent({ event: { ...base, channel_type: "channel" } });
    expect(chatter).toMatchObject({ conversationKind: "channel", mentionsSelf: false });
    expect(chatter && slackMessageWakes(chatter, undefined)).toBe(false);
    expect(parseSlackEvent({ event: { ...base, channel_type: "im", bot_id: "B1" } })).toBeNull();
    expect(
      parseSlackEvent({ event: { ...base, channel_type: "im", subtype: "message_changed" } })
    ).toBeNull();
  });
});
