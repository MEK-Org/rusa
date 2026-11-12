import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { resolveProvider } from "./registry.js";

function testConfig(): RusaConfig {
  return {
    providers: {
      antigravity: { cliCommand: "agy" },
      claude: { cliCommand: "claude" },
      codex: { cliCommand: "codex" },
    },
    geminiApiKey: "test-key",
  } as unknown as RusaConfig;
}

describe("resolveProvider", () => {
  it("resolves a configured provider with a trimmed model", () => {
    const provider = resolveProvider(testConfig(), "claude", " claude-opus-4-8 ");
    expect(provider.providerName).toBe("claude");
    expect(provider.model).toBe("claude-opus-4-8");
  });

  it("resolves with the provider's default model when none is requested", () => {
    const provider = resolveProvider(testConfig(), "claude");
    expect(provider.model).toBeUndefined();
    expect(provider.effort).toBeUndefined();
  });

  it("hard-errors on an empty requested model instead of silently using the provider default ", () => {
    expect(() => resolveProvider(testConfig(), "claude", "")).toThrow(/empty model slug/);
    expect(() => resolveProvider(testConfig(), "claude", "   ")).toThrow(/empty model slug/);
  });

  it("migrates legacy Codex qualifiers and rejects unsupported effort combinations", () => {
    const provider = resolveProvider(testConfig(), "codex", "gpt-5.6-sol extra-high");
    expect(provider.model).toBe("gpt-5.6-sol");
    expect(provider.effort).toBe("xhigh");
    expect(() => resolveProvider(testConfig(), "claude", "claude-opus-4-8", "ultra")).toThrow(
      /reasoning effort validation failed/
    );
  });

  it("uses the configured CLI capability family for logical provider aliases", () => {
    const config = testConfig();
    config.providers.strong = { cliCommand: "claude" };
    const provider = resolveProvider(config, "strong", "claude-opus-4-8", "max");
    expect(provider.providerName).toBe("claude");
    expect(provider.effort).toBe("max");
  });
});
