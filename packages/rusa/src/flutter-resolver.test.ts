import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error
import { resolveFlutterCommand } from "../scripts/flutter-resolver.mjs";

describe("flutter-resolver", () => {
  let tempDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "flutter-resolver-test-"));
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    // Restore environment
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it("honors FLUTTER_CMD environment override", () => {
    process.env.FLUTTER_CMD = "my-custom-flutter --some-flag";
    const result = resolveFlutterCommand();
    expect(result).toEqual({
      cmd: "my-custom-flutter",
      args: ["--some-flag"],
    });
  });

  it("falls back to global flutter if no fvm is detected", () => {
    delete process.env.FLUTTER_CMD;
    const result = resolveFlutterCommand();
    expect(result.cmd).toBe("flutter");
  });
});
