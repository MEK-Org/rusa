import { describe, expect, it } from "vitest";
import { configuredModelRefs, resolveWindowModels } from "./model-window-scope.js";

describe("catalog-aware model window scope", () => {
  const catalog = [
    { identifier: "claude-fable", displayLabel: "Fable", passable: true },
    { identifier: "claude-sonnet", displayLabel: "Sonnet", passable: true },
    { identifier: "heading", displayLabel: "Models", passable: false },
  ];

  it("intersects parser labels with configured models, canonicalizes and orders them", () => {
    expect(
      resolveWindowModels(
        ["SONNET", "foreign-model", "claude-fable", "Fable", "sonnet"],
        configuredModelRefs(catalog)
      )
    ).toEqual(["claude-fable", "claude-sonnet"]);
  });

  it("does not manufacture a model scope when the configured catalog is empty", () => {
    expect(resolveWindowModels(["Fable"], [])).toEqual([]);
  });
});
