import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJevApiKeyFile } from "./jev.js";

function home(): string {
  return mkdtempSync(join(tmpdir(), "rusa-jev-"));
}

describe("readJevApiKeyFile", () => {
  it("leaves the feature off when no config key is set", () => {
    expect(readJevApiKeyFile(undefined, home())).toBeUndefined();
  });

  it("reads and trims one contained host-plane credential file", () => {
    const root = home();
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets", "synthetic-jev-key"), " synthetic-test-key \n");
    expect(readJevApiKeyFile("synthetic-jev-key", root)).toBe("synthetic-test-key");
  });

  it("fails soft for a missing or escaping credential file", () => {
    const root = home();
    expect(readJevApiKeyFile("missing-key", root)).toBeUndefined();
    expect(readJevApiKeyFile("../outside", root)).toBeUndefined();
  });
});
