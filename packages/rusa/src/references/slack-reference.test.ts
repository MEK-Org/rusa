import { describe, expect, it, vi } from "vitest";
import type { ReferenceCacheRepository } from "../db/repositories/reference-cache-repository.js";
import { ReferenceCacheService } from "./cache-service.js";
import { resolveReference } from "./resolve.js";

const ref = "slack:channels/C123/messages/1720000000.000001";
const slackClient = {
  getChannel: vi.fn().mockResolvedValue({ id: "C123", name: "test" }),
  getMessage: vi.fn().mockResolvedValue({
    channel: "C123",
    ts: "1720000000.000001",
    text: "The decision is yes",
    user: "U123",
  }),
};

describe("Slack obligation references", () => {
  it("fetches the exact message body and preserves a browsable URL", async () => {
    const result = await resolveReference(ref, { slackClient });
    expect(slackClient.getMessage).toHaveBeenCalledWith("C123", "1720000000.000001");
    expect(result.body).toBe("The decision is yes");
    expect(result.entity).toEqual({ type: "slack_message", contents: "The decision is yes" });
    expect(result.url).toBe("https://app.slack.com/archives/C123/p1720000000000001");
  });

  it("retains message contents in the dashboard reference cache", async () => {
    const rows = new Map<string, unknown>();
    const repo = {
      get: (key: string) => rows.get(key) ?? null,
      set: (row: { ref: string }) => {
        rows.set(row.ref, row);
      },
    } as unknown as ReferenceCacheRepository;
    const cache = new ReferenceCacheService({ repo, deadlineMs: 1000 });
    expect((await cache.get(ref, { slackClient })).entity).toEqual({
      type: "slack_message",
      contents: "The decision is yes",
    });
    expect((await cache.get(ref, { slackClient })).entity).toEqual({
      type: "slack_message",
      contents: "The decision is yes",
    });
    expect(slackClient.getMessage).toHaveBeenCalledTimes(2);
  });
});
