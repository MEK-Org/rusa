import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readSlackToken, SlackClient } from "./slack-client.js";

describe("Slack token placement", () => {
  it("reads only files directly in the masked RUSA_HOME/secrets directory", () => {
    const home = mkdtempSync(join(tmpdir(), "rusa-slack-token-"));
    const dir = join(home, "secrets");
    mkdirSync(dir, { mode: 0o700 });
    const safe = join(dir, "bot-token");
    const outside = join(home, "bot-token");
    writeFileSync(safe, " xoxb-test \n", { mode: 0o600 });
    writeFileSync(outside, "xoxb-outside", { mode: 0o600 });
    expect(readSlackToken(safe, home)).toBe("xoxb-test");
    expect(() => readSlackToken(outside, home)).toThrow(/directly inside/);
  });
});

describe("SlackClient.listRecentMessages", () => {
  function clientWith(web: Record<string, unknown>): SlackClient {
    const client = new SlackClient("xoxb-test");
    Object.defineProperty(client, "web", { value: web });
    return client;
  }

  it("returns the channel's newest top-level messages oldest first, skipping broadcast replies", async () => {
    const history = vi.fn(async () => ({
      messages: [
        { ts: "4.0", text: "newest", user: "U1" },
        { ts: "3.5", text: "broadcast reply", user: "U2", thread_ts: "1.0" },
        { ts: "3.0", text: "bot", bot_id: "B1" },
        { ts: "2.0", text: "thread parent", user: "U2", thread_ts: "2.0" },
        { ts: "1.0", text: "too old", user: "U1" },
      ],
    }));
    const client = clientWith({ conversations: { history } });
    const messages = await client.listRecentMessages("C1", { limit: 3 });
    expect(history).toHaveBeenCalledWith({ channel: "C1", limit: 9 });
    expect(messages).toEqual([
      { channel: "C1", ts: "2.0", text: "thread parent", user: "U2", threadTs: "2.0" },
      { channel: "C1", ts: "3.0", text: "bot", user: "B1", threadTs: undefined },
      { channel: "C1", ts: "4.0", text: "newest", user: "U1", threadTs: undefined },
    ]);
  });

  it("walks a thread's reply pages to return its tail", async () => {
    const replies = vi.fn(async ({ cursor }: { cursor?: string }) =>
      cursor
        ? { messages: [{ ts: "1.3", text: "c", user: "U1", thread_ts: "1.0" }] }
        : {
            messages: [
              { ts: "1.0", text: "parent", user: "U1", thread_ts: "1.0" },
              { ts: "1.1", text: "a", user: "U2", thread_ts: "1.0" },
              { ts: "1.2", text: "b", user: "U1", thread_ts: "1.0" },
            ],
            response_metadata: { next_cursor: "page-2" },
          }
    );
    const client = clientWith({ conversations: { replies } });
    const messages = await client.listRecentMessages("C1", { threadTs: "1.0", limit: 2 });
    expect(replies).toHaveBeenCalledTimes(2);
    expect(messages.map((m) => m.text)).toEqual(["b", "c"]);
  });
});
