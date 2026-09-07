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
