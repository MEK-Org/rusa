import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorProviderLanes } from "../commands/quota-coordinator.js";
import type { RusaConfig } from "../config/types.js";
import { clearProviderModelCatalog } from "./model-catalog.js";
import { validateModelConfigPool } from "./model-config.js";
import { providerCapabilityName, validateProviderSelection } from "./provider-selection.js";
import { providerThrottleKey } from "./registry.js";

const config = {
  providers: { codex: { cliCommand: "codex" } },
} as unknown as RusaConfig;

afterEach(() => {
  clearProviderModelCatalog();
  vi.restoreAllMocks();
});

describe("validateProviderSelection", () => {
  it("preserves the unknown-catalog warning while allowing the selected pin", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(validateProviderSelection(config, "codex", "gpt-5.6-sol", "high")).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[model-catalog] model catalog for provider "codex" is unknown; allowing pin "gpt-5.6-sol" without validation'
    );
  });
});

it("runs openrouter through the pi command with a model, portable context and no effort", async () => {
  // The minimal config: the provider name stays "openrouter" for routing while
  // cliCommand selects the Pi adapter and names its executable.
  const config = { providers: { openrouter: { cliCommand: "pi" } } } as unknown as RusaConfig;
  const entry = { provider: "openrouter", model: "vendor/model" };
  expect(validateProviderSelection(config, entry.provider, entry.model)).toEqual({
    model: entry.model,
  });
  expect(() => validateProviderSelection(config, entry.provider)).toThrow(/requires a model/);
  expect(() => validateModelConfigPool(config, entry, { portable: false })).toThrow(/portable/);
  expect(validateModelConfigPool(config, entry, { portable: true })[0]).toEqual(entry);
  expect(() => validateProviderSelection(config, entry.provider, entry.model, "high")).toThrow(
    /reasoning-effort/
  );
});

describe("harness vs provider identity", () => {
  const config = {
    providers: {
      openrouter: { cliCommand: "pi" },
      "custom-pi": { cliCommand: "pi" },
      antigravity: { cliCommand: "agy" },
      claude: { cliCommand: "claude" },
      codex: { cliCommand: "codex" },
      kimi: { cliCommand: "kimi" },
      gemini: { cliCommand: "agy" },
      strong: { cliCommand: "claude" },
    },
  } as unknown as RusaConfig;

  it("keys a pi-harness provider's lane on the configured provider", () => {
    expect(providerThrottleKey("openrouter", config)).toBe("openrouter");
    expect(providerThrottleKey("custom-pi", config)).toBe("custom-pi");
  });

  it("still selects the pi executable for both pi-harness providers", () => {
    expect(providerCapabilityName("openrouter", config)).toBe("pi");
    expect(providerCapabilityName("custom-pi", config)).toBe("pi");
  });

  it("keeps other cliCommand aliases on their CLI's lane", () => {
    expect(providerThrottleKey("antigravity", config)).toBe("agy");
    expect(providerThrottleKey("claude", config)).toBe("claude");
    expect(providerThrottleKey("codex", config)).toBe("codex");
    expect(providerThrottleKey("kimi", config)).toBe("kimi");
    expect(providerThrottleKey("gemini", config)).toBe("agy");
    expect(providerThrottleKey("strong", config)).toBe("claude");
  });

  it("gives the harness lane only to the exact pi capability that dispatch uses", () => {
    const shouty = { providers: { shouty: { cliCommand: "Pi" } } } as unknown as RusaConfig;
    expect(providerCapabilityName("shouty", shouty)).not.toBe("pi");
    expect(providerThrottleKey("shouty", shouty)).not.toBe("shouty");
  });

  it("gives the coordinator one lane per pi-harness provider and collects only quota-tracked lanes", () => {
    const { configuredProviders, collectionProviders } = coordinatorProviderLanes(config);
    expect(configuredProviders).toEqual([
      "openrouter",
      "custom-pi",
      "agy",
      "claude",
      "codex",
      "kimi",
    ]);
    expect(collectionProviders).toEqual(["agy", "claude", "codex", "kimi"]);
  });

  it("lets two pi-harness providers list the same model in one pool", () => {
    const pool = validateModelConfigPool(
      config,
      [
        { provider: "openrouter", model: "openai/gpt-4.1-mini" },
        { provider: "custom-pi", model: "openai/gpt-4.1-mini" },
      ],
      { portable: true }
    );
    expect(pool).toHaveLength(2);
  });

  it("rejects two aliases of one quota CLI listing the same model", () => {
    expect(() =>
      validateModelConfigPool(
        config,
        [
          { provider: "claude", model: "claude-sonnet-5" },
          { provider: "strong", model: "claude-sonnet-5" },
        ],
        { portable: true }
      )
    ).toThrow(/duplicate entry: provider "strong" model "claude-sonnet-5"/);
  });
});
