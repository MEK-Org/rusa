import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { resolveProvider, resolveRootProvider } from "./registry.js";

// resolveRootProvider reads only providers / root / geminiApiKey and never the
// DB, so a partial config is sufficient.
function configWith(rootActor?: RusaConfig["rootActor"]): RusaConfig {
  return {
    providers: {
      antigravity: { cliCommand: "agy" },
      claude: { cliCommand: "claude" },
      codex: { cliCommand: "codex" },
    },
    geminiApiKey: "test-key",
    rootActor,
  } as unknown as RusaConfig;
}

describe("resolveRootProvider", () => {
  it("requires an explicit root provider and model", () => {
    expect(() => resolveRootProvider(configWith())).toThrow(/rootActor/i);
  });

  it("honors an explicit provider and model", () => {
    const provider = resolveRootProvider(
      configWith({ provider: "claude", model: "claude-opus-4-8" })
    );
    expect(provider.providerName).toBe("claude");
    expect(provider.model).toBe("claude-opus-4-8");
    expect(provider.name).toBe("claude-opus-4-8 (claude)");
  });

  it("honors an explicit effort independently from model", () => {
    const provider = resolveRootProvider(
      configWith({ provider: "claude", model: "claude-opus-4-8", effort: "max" })
    );
    expect(provider.model).toBe("claude-opus-4-8");
    expect(provider.effort).toBe("max");
    expect(provider.name).toBe("claude-opus-4-8 @ max (claude)");
  });

  it("rejects a root provider without an explicit model", () => {
    expect(() => resolveRootProvider(configWith({ provider: "claude" } as never))).toThrow(
      /model/i
    );
  });

  it("throws when root.provider is not declared under providers", () => {
    expect(() =>
      resolveRootProvider(configWith({ provider: "bogus", model: "bogus-model" }))
    ).toThrow(/not configured/);
  });
});

describe("resolveProvider", () => {
  it("resolves a configured provider with a trimmed model", () => {
    const provider = resolveProvider(configWith(), "claude", " claude-opus-4-8 ");
    expect(provider.providerName).toBe("claude");
    expect(provider.model).toBe("claude-opus-4-8");
  });

  it("resolves with the provider's default model when none is requested", () => {
    const provider = resolveProvider(configWith(), "claude");
    expect(provider.model).toBeUndefined();
    expect(provider.effort).toBeUndefined();
  });

  it("hard-errors on an empty requested model instead of silently using the provider default ", () => {
    expect(() => resolveProvider(configWith(), "claude", "")).toThrow(/empty model slug/);
    expect(() => resolveProvider(configWith(), "claude", "   ")).toThrow(/empty model slug/);
  });

  it("migrates legacy Codex qualifiers and rejects unsupported effort combinations", () => {
    const provider = resolveProvider(configWith(), "codex", "gpt-5.6-sol extra-high");
    expect(provider.model).toBe("gpt-5.6-sol");
    expect(provider.effort).toBe("xhigh");
    expect(() => resolveProvider(configWith(), "claude", "claude-opus-4-8", "ultra")).toThrow(
      /reasoning effort validation failed/
    );
  });

  it("uses the configured CLI capability family for logical provider aliases", () => {
    const config = configWith();
    config.providers.strong = { cliCommand: "claude" };
    const provider = resolveProvider(config, "strong", "claude-opus-4-8", "max");
    expect(provider.providerName).toBe("claude");
    expect(provider.effort).toBe("max");
  });
});
