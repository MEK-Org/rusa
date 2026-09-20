import { describe, expect, it } from "vitest";
import type { RunResult } from "../providers/types.js";
import {
  appendFailedProviderStderr,
  PROVIDER_STDERR_MAX_CHARS,
  ProviderStderrCapture,
  redactProviderCredentials,
} from "./provider-stderr.js";

const failed: RunResult = { success: false, output: "", exitCode: 1 };

describe("provider stderr persistence (#565)", () => {
  it("keeps the head and tail of oversized stderr inside the bound", () => {
    const capture = new ProviderStderrCapture();
    capture.append(`request-id: head-marker\n${"a".repeat(30_000)}`);
    capture.append(`${"b".repeat(30_000)}\nfinal error: tail-marker`);
    const rendered = capture.render();
    expect(rendered).toContain("request-id: head-marker");
    expect(rendered).toContain("final error: tail-marker");
    expect(rendered).toContain("[provider stderr truncated]");
    expect(rendered.length).toBeLessThan(PROVIDER_STDERR_MAX_CHARS + 100);
  });

  it("redacts credential forms in the appended block and in the failed output itself", () => {
    const secretText =
      "Authorization: Bearer synthetic-token-1\napi_key=synthetic-key-2\n" +
      "https://example.invalid/x?token=synthetic-token-3&y=1";
    const result = appendFailedProviderStderr(
      { ...failed, output: `partial\n${secretText}` },
      redactProviderCredentials(secretText)
    );
    expect(result.output).toContain("partial");
    expect(result.output).toContain("--- provider stderr (sanitized) ---");
    expect(result.output).not.toContain("synthetic-token-1");
    expect(result.output).not.toContain("synthetic-key-2");
    expect(result.output).not.toContain("synthetic-token-3");
  });

  it("redacts failed output even when the provider emitted no stderr", () => {
    const result = appendFailedProviderStderr(
      { ...failed, output: "Authorization: Bearer synthetic-token-4" },
      ""
    );
    expect(result.output).toBe("Authorization: Bearer [redacted]");
  });

  it("returns successful results untouched, including credential-shaped text", () => {
    const success: RunResult = {
      success: true,
      output: "const header = 'Authorization: Bearer example-value';",
      exitCode: 0,
    };
    expect(appendFailedProviderStderr(success, "diagnostic")).toBe(success);
  });
});
