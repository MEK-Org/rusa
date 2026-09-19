import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("standalone failure notifier", () => {
  it("sends to a Slack event source using the configured token file", () => {
    const home = mkdtempSync(join(tmpdir(), "rusa-notifier-"));
    const tokenPath = join(home, "bot-token");
    const fetchLog = join(home, "fetch.json");
    const preload = join(home, "mock-fetch.mjs");
    writeFileSync(tokenPath, "test-token\n");
    writeFileSync(
      preload,
      `import { writeFileSync } from "node:fs";
globalThis.fetch = async (url, options) => {
  writeFileSync(process.env.TEST_FETCH_LOG, JSON.stringify({ url, body: JSON.parse(options.body), authorization: options.headers.authorization }));
  return { ok: true, json: async () => ({ ok: true }) };
};`
    );
    const script = resolve("scripts/notify-failure.mjs");
    const result = spawnSync(process.execPath, ["--import", preload, script, "test failure"], {
      cwd: resolve("."),
      env: {
        ...process.env,
        RUSA_HOME: home,
        RUSA_ERROR_SOURCE: "slack:channels/C123",
        RUSA_SLACK_BOT_TOKEN_PATH: tokenPath,
        TEST_FETCH_LOG: fetchLog,
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(fetchLog, "utf8"))).toEqual({
      url: "https://slack.com/api/chat.postMessage",
      body: { channel: "C123", text: "❌ test failure" },
      authorization: "Bearer test-token",
    });
    expect(readFileSync(join(home, "alerts", "last-failure.txt"), "utf8")).toContain(
      "test failure"
    );
  });
});
