import { describe, expect, it, vi } from "vitest";
import { FcmVoicePushDelivery, REPLY_NOTIFICATION_CLICK_ACTION } from "./push-delivery.js";

describe("FcmVoicePushDelivery", () => {
  it("sends a content-free notification carrying only durable reply lookup keys", async () => {
    const tokens = {
      listForPrincipal: vi.fn(() => [
        {
          token: "fcm-a",
          principalId: "principal-a",
          registeredAt: "2026-11-06T00:00:00.000Z",
          refreshedAt: "2026-11-06T00:00:00.000Z",
        },
      ]),
      remove: vi.fn(),
    };
    const sender = { send: vi.fn(async () => "message-id") };
    const delivery = new FcmVoicePushDelivery(tokens, sender);

    await delivery.deliver({
      actorId: "actor-a",
      announcementId: "message-a",
      recipientId: "principal-a",
    });

    expect(sender.send).toHaveBeenCalledWith({
      token: "fcm-a",
      data: { actorId: "actor-a", announcementId: "message-a" },
      notification: { title: "New reply" },
      android: {
        priority: "high",
        notification: { clickAction: REPLY_NOTIFICATION_CLICK_ACTION },
      },
    });
    expect(tokens.remove).not.toHaveBeenCalled();
  });

  it("drops registrations FCM says are invalid but keeps transient failures", async () => {
    const tokens = {
      listForPrincipal: vi.fn(() => [
        {
          token: "bad",
          principalId: "principal-a",
          registeredAt: "2026-11-06T00:00:00.000Z",
          refreshedAt: "2026-11-06T00:00:00.000Z",
        },
        {
          token: "retry",
          principalId: "principal-a",
          registeredAt: "2026-11-06T00:00:00.000Z",
          refreshedAt: "2026-11-06T00:00:00.000Z",
        },
      ]),
      remove: vi.fn(),
    };
    const sender = {
      send: vi
        .fn()
        .mockRejectedValueOnce({ code: "messaging/registration-token-not-registered" })
        .mockRejectedValueOnce({ code: "messaging/internal-error" }),
    };
    const delivery = new FcmVoicePushDelivery(tokens, sender);

    await delivery.deliver({
      actorId: "actor-a",
      announcementId: "message-a",
      recipientId: "principal-a",
    });

    expect(tokens.remove).toHaveBeenCalledTimes(1);
    expect(tokens.remove).toHaveBeenCalledWith("bad");
  });
});
