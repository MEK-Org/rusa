import { afterEach, describe, expect, it, vi } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { clearProviderModelCatalog } from "./model-catalog.js";
import { validateProviderSelection } from "./provider-selection.js";

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
  const { validateModelConfigPool } = await import("./model-config.js");
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
