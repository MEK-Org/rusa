import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { DEFAULT_ROOT_PROVIDER, resolveProvider, resolveRootProvider } from "./registry.js";

// resolveRootProvider reads only providers / root / geminiApiKey and never the
// DB, so a partial config is sufficient.
function configWith(rootActor?: RusaConfig["rootActor"]): RusaConfig {
  return {
    providers: {
      antigravity: { cliCommand: "agy" },
      claude: { cliCommand: "claude" },
    },
    geminiApiKey: "test-key",
    rootActor,
  } as unknown as RusaConfig;
}

describe("resolveRootProvider", () => {
  it("defaults to agy (antigravity) with no model when rootActor is unset", () => {
    const provider = resolveRootProvider(configWith());
    expect(provider.providerName).toBe(DEFAULT_ROOT_PROVIDER);
    expect(provider.providerName).toBe("antigravity");
    expect(provider.model).toBeUndefined();
  });

  it("honors an explicit provider and model", () => {
    const provider = resolveRootProvider(
      configWith({ provider: "claude", model: "claude-opus-4-8" })
    );
    expect(provider.providerName).toBe("claude");
    expect(provider.model).toBe("claude-opus-4-8");
    expect(provider.name).toBe("claude-opus-4-8 (claude)");
  });

  it("uses the provider's default model when only a provider is given", () => {
    const provider = resolveRootProvider(configWith({ provider: "claude" }));
    expect(provider.providerName).toBe("claude");
    expect(provider.model).toBeUndefined();
    expect(provider.name).toBe("claude");
  });

  it("throws when root.provider is not declared under providers", () => {
    expect(() => resolveRootProvider(configWith({ provider: "bogus" }))).toThrow(/not configured/);
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
  });

  it("hard-errors on an empty requested model instead of silently using the provider default ", () => {
    expect(() => resolveProvider(configWith(), "claude", "")).toThrow(/empty model slug/);
    expect(() => resolveProvider(configWith(), "claude", "   ")).toThrow(/empty model slug/);
  });
});
