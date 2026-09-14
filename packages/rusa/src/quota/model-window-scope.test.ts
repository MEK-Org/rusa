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

  it("rejects an ambiguous display label while retaining an unambiguous identifier", () => {
    const duplicateLabels = [
      { identifier: "claude-fable-a", displayLabel: "Fable" },
      { identifier: "claude-fable-b", displayLabel: "Fable" },
    ];

    expect(resolveWindowModels(["Fable"], duplicateLabels)).toEqual([]);
    expect(resolveWindowModels(["Fable", "claude-fable-a"], duplicateLabels)).toEqual([
      "claude-fable-a",
    ]);
  });
});
