import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSecretContainment,
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

describe("assertSecretContainment", () => {
  it("rejects empty or whitespace filename", () => {
    const home = makeHome();
    const secretsDir = secretsDirPath(home);
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    expect(() => assertSecretContainment("", secretsDir)).toThrow("secret filename is required");
    expect(() => assertSecretContainment("   ", secretsDir)).toThrow("secret filename is required");
  });

  it("rejects absolute paths (absolute path containment rule)", () => {
    const home = makeHome();
    const secretsDir = secretsDirPath(home);
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    expect(() => assertSecretContainment("/etc/passwd", secretsDir)).toThrow(
      /must not be an absolute path/
    );
    expect(() => assertSecretContainment("/tmp/secret", secretsDir)).toThrow(
      /must not be an absolute path/
    );
  });

  it("rejects path traversal (traversal containment rule)", () => {
    const home = makeHome();
    const secretsDir = secretsDirPath(home);
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    expect(() => assertSecretContainment("../etc/passwd", secretsDir)).toThrow(
      /path traversal is not allowed/
    );
    expect(() => assertSecretContainment("..", secretsDir)).toThrow(
      /path traversal is not allowed/
    );
    expect(() => assertSecretContainment(".", secretsDir)).toThrow(/path traversal is not allowed/);
    expect(() => assertSecretContainment("sub/../../escape", secretsDir)).toThrow(
      /path traversal is not allowed/
    );
    expect(() => assertSecretContainment("sub/secret", secretsDir)).toThrow(
      /path traversal is not allowed/
    );
  });

  it("rejects missing or unknown secret files (fail loudly at grant time)", () => {
    const home = makeHome();
    const secretsDir = secretsDirPath(home);
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    expect(() => assertSecretContainment("nonexistent-key", secretsDir)).toThrow(
      /secret file does not exist/
    );
  });

  it("rejects when secrets directory does not exist", () => {
    const home = makeHome();
    const secretsDir = join(home, "nonexistent-dir");
    expect(() => assertSecretContainment("gemini-api-key", secretsDir)).toThrow(
      /secret file does not exist/
    );
  });

  it("rejects symlinks that escape the secrets directory (symlink escape rule)", () => {
    const home = makeHome();
    const secretsDir = secretsDirPath(home);
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

    const outsideFile = join(home, "outside-secret.txt");
    writeFileSync(outsideFile, "outside-secret-data\n");

    const symlinkPath = join(secretsDir, "escaping-link");
    symlinkSync(outsideFile, symlinkPath);

    expect(() => assertSecretContainment("escaping-link", secretsDir)).toThrow(
      /secret symlink escapes secrets directory/
    );
  });

  it("rejects broken symlinks", () => {
    const home = makeHome();
    const secretsDir = secretsDirPath(home);
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

    const brokenLinkPath = join(secretsDir, "broken-link");
    symlinkSync(join(secretsDir, "does-not-exist"), brokenLinkPath);

    expect(() => assertSecretContainment("broken-link", secretsDir)).toThrow(
      /secret file does not exist or broken symlink/
    );
  });

  it("rejects non-regular files such as subdirectories (non-regular file rule)", () => {
    const home = makeHome();
    const secretsDir = secretsDirPath(home);
    const subDir = join(secretsDir, "nested-directory");
    mkdirSync(subDir, { recursive: true, mode: 0o700 });

    expect(() => assertSecretContainment("nested-directory", secretsDir)).toThrow(
      /secret must resolve to a regular file/
    );
  });

  it("accepts a regular file directly inside secrets directory and returns canonical path", () => {
    const home = makeHome();
    const secretsDir = secretsDirPath(home);
    const secretPath = writeHostSecret("synthetic-api-key", "synthetic-secret-value", home);

    const resolved = assertSecretContainment("synthetic-api-key", secretsDir);
    expect(resolved).toBe(secretPath);
  });

  it("accepts a symlink pointing to a regular file directly inside secrets directory", () => {
    const home = makeHome();
    const secretsDir = secretsDirPath(home);
    const secretPath = writeHostSecret("target-key", "secret-content", home);

    const internalLink = join(secretsDir, "internal-link");
    symlinkSync(secretPath, internalLink);

    const resolved = assertSecretContainment("internal-link", secretsDir);
    expect(resolved).toBe(secretPath);
  });
});
