import { ErrorCode } from "@slack/web-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSlackEvent, rememberSlackSelf } from "./socket-source.js";
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
    for (const text of [
      "@rusa hi",
      "<@UBOTX> hi",
      "example: <@UBOT|unfinished",
      "<@UBOT|x <@UOTHER> hi",
      "<!here> hi",
      "<!channel>",
      "<!subteam^S1>",
    ]) {
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

describe("Slack bot identity lookup", () => {
  afterEach(() => vi.useRealTimers());

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("waits out Slack's retry-after, else 30 seconds, before looking up again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const rateLimited = Object.assign(new Error("rate limited"), {
      code: ErrorCode.RateLimitedError,
      retryAfter: 45,
    });
    const identify = vi
      .fn<() => Promise<{ userId: string }>>()
      .mockRejectedValueOnce(rateLimited)
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ userId: "UBOT" });
    const onError = vi.fn();
    const selfUserId = rememberSlackSelf(identify, onError);

    // The first lookup is rate limited with retry-after 45s.
    expect(selfUserId()).toBeUndefined();
    await settle();
    expect(onError).toHaveBeenCalledWith(rateLimited);

    // Events inside that window answer at once and start no lookup.
    vi.advanceTimersByTime(44_999);
    expect(selfUserId()).toBeUndefined();
    await settle();
    expect(identify).toHaveBeenCalledOnce();

    // After it, the next event looks up again; this failure names no
    // retry-after, so the wait is the 30-second minimum.
    vi.advanceTimersByTime(1);
    expect(selfUserId()).toBeUndefined();
    await settle();
    expect(identify).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(29_999);
    selfUserId();
    await settle();
    expect(identify).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    selfUserId();
    await settle();
    expect(identify).toHaveBeenCalledTimes(3);
    expect(selfUserId()).toBe("UBOT");
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
