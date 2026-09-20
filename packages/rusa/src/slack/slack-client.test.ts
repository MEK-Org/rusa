import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSlackToken } from "./slack-client.js";

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
