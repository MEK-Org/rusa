import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GLASS_GOALS_PASSWORD_SECRET_FILENAME,
  readHostSecret,
  resolveGlassGoalsPassword,
  secretsDirPath,
  writeHostSecret,
} from "./secrets.js";

const originalGlassGoalsPassword = process.env.GLASS_GOALS_PASSWORD;

afterEach(() => {
  if (originalGlassGoalsPassword === undefined) {
    delete process.env.GLASS_GOALS_PASSWORD;
  } else {
    process.env.GLASS_GOALS_PASSWORD = originalGlassGoalsPassword;
  }
});

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "rusa-secrets-"));
}

describe("readHostSecret", () => {
  it("reads and trims a secret file", () => {
    const home = makeHome();
    writeHostSecret("gemini-api-key", "AIza-test-key", home);
    expect(readHostSecret("gemini-api-key", home)).toBe("AIza-test-key");
  });

  it("trims surrounding whitespace/newlines", () => {
    const home = makeHome();
    mkdirSync(secretsDirPath(home), { recursive: true, mode: 0o700 });
    writeFileSync(join(secretsDirPath(home), "webhook-secret"), "  hook-value \n\n", {
      mode: 0o600,
    });
    expect(readHostSecret("webhook-secret", home)).toBe("hook-value");
  });

  it("returns undefined when the file is missing (no secrets dir at all)", () => {
    expect(readHostSecret("gemini-api-key", makeHome())).toBeUndefined();
  });

  it("returns undefined for an empty/whitespace-only file", () => {
    const home = makeHome();
    writeHostSecret("gemini-api-key", "   ", home);
    expect(readHostSecret("gemini-api-key", home)).toBeUndefined();
  });
});

describe("writeHostSecret", () => {
  it("creates the secrets dir 0700 and the file 0600", () => {
    const home = makeHome();
    const path = writeHostSecret("glass-goals-password", "hunter2", home);
    expect(path).toBe(join(home, "secrets", "glass-goals-password"));
    expect(statSync(secretsDirPath(home)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readHostSecret("glass-goals-password", home)).toBe("hunter2");
  });
});

describe("resolveGlassGoalsPassword", () => {
  it("prefers the secrets file over the env var", () => {
    const home = makeHome();
    writeHostSecret(GLASS_GOALS_PASSWORD_SECRET_FILENAME, "file-password", home);
    process.env.GLASS_GOALS_PASSWORD = "env-password";
    expect(resolveGlassGoalsPassword(home)).toBe("file-password");
  });

  it("falls back to the GLASS_GOALS_PASSWORD env var when the file is missing", () => {
    process.env.GLASS_GOALS_PASSWORD = "env-password";
    expect(resolveGlassGoalsPassword(makeHome())).toBe("env-password");
  });

  it("returns undefined when neither the file nor the env var is set", () => {
    delete process.env.GLASS_GOALS_PASSWORD;
    expect(resolveGlassGoalsPassword(makeHome())).toBeUndefined();
  });
});
