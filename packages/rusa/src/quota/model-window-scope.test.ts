import { describe, expect, it } from "vitest";
import type { QuotaLimit } from "../mcp/quota-mcp.js";
import {
  configuredModelRefs,
  keepWindowLaneModels,
  resolveWindowModels,
} from "./model-window-scope.js";

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

  it("rejects a normalized identifier/display-label collision", () => {
    const identifierLabelCollision = [
      { identifier: "claude-fable", displayLabel: "Fable" },
      { identifier: "claude-sonnet", displayLabel: "claude-fable" },
    ];

    expect(resolveWindowModels(["claude-fable"], identifierLabelCollision)).toEqual([]);
    expect(resolveWindowModels(["Fable"], identifierLabelCollision)).toEqual(["claude-fable"]);
  });

  it("keeps a wildcard that covers a configured model, in place of the models it covers (#1282)", () => {
    const fable = [
      { identifier: "claude-fable-5", displayLabel: "Claude Fable 5" },
      { identifier: "claude-fable-5-1", displayLabel: "Claude Fable 5.1" },
      { identifier: "claude-opus-5-5", displayLabel: "Claude Opus 5.5" },
    ];
    const grown = [...fable, { identifier: "claude-fable-5-2", displayLabel: "Claude Fable 5.2" }];

    // The list, and so the lane's identity, is the same whatever the catalog holds.
    expect(resolveWindowModels(["claude-fable-*"], fable)).toEqual(["claude-fable-*"]);
    expect(resolveWindowModels(["claude-fable-*"], grown)).toEqual(["claude-fable-*"]);
    // A covered model named beside the pattern adds nothing; an uncovered one stays.
    expect(resolveWindowModels(["Claude Fable 5.1", "claude-fable-*"], fable)).toEqual([
      "claude-fable-*",
    ]);
    expect(resolveWindowModels(["claude-opus-5-5", "claude-fable-*"], fable)).toEqual([
      "claude-fable-*",
      "claude-opus-5-5",
    ]);
    // A pattern covering nothing configured is no model scope at all.
    expect(resolveWindowModels(["claude-haiku-*"], fable)).toEqual([]);
    expect(resolveWindowModels(["claude-fable-*"], [])).toEqual([]);
  });
});

describe("keepWindowLaneModels (#1078)", () => {
  const FABLE = ["claude-fable-5", "claude-fable-5-1"];
  const catalog = configuredModelRefs([
    { identifier: "claude-fable-5", displayLabel: "Claude Fable 5" },
    { identifier: "claude-fable-5-1", displayLabel: "Claude Fable 5.1" },
    { identifier: "claude-opus-5-5", displayLabel: "Claude Opus 5.5" },
  ]);
  const window = (models: string[] | null, label = "Current week (Fable)"): QuotaLimit => ({
    label,
    kind: "weekly",
    percentLeft: 46,
    resetAtIso: "2026-10-19T03:00:00.000Z",
    scope: models ? { provider: "claude", models } : { provider: "claude" },
  });
  const modelsOf = (limits: readonly QuotaLimit[]) =>
    limits.map((limit) => (typeof limit.scope === "object" ? (limit.scope.models ?? null) : null));

  it("keeps the established lane when the same label and kind name a subset of its models", () => {
    const kept = keepWindowLaneModels(
      [window(null, "Current week (all models)"), window(["claude-fable-5"])],
      [window(null, "Current week (all models)"), window(FABLE)],
      catalog
    );
    expect(modelsOf(kept)).toEqual([null, FABLE]);
    expect(kept[1]).toMatchObject({ label: "Current week (Fable)", percentLeft: 46 });
  });

  it("preserves a wildcard reading through the Claude lane guard with listed or wildcard history", () => {
    const current = window(["claude-fable-*"]);
    for (const history of [[], [window(FABLE)], [window(["claude-fable-*"])]]) {
      expect(keepWindowLaneModels([current], history, catalog)).toEqual([current]);
    }
  });

  it("takes a reading that names more models, or different ones, as read", () => {
    expect(
      modelsOf(keepWindowLaneModels([window(FABLE)], [window(["claude-fable-5"])], catalog))
    ).toEqual([FABLE]);
    expect(
      modelsOf(keepWindowLaneModels([window(["claude-opus-5-5"])], [window(FABLE)], catalog))
    ).toEqual([["claude-opus-5-5"]]);
  });

  it("narrows the lane once a dropped model has left the catalog", () => {
    const withoutFable51 = configuredModelRefs([
      { identifier: "claude-fable-5", displayLabel: "" },
    ]);
    expect(
      modelsOf(keepWindowLaneModels([window(["claude-fable-5"])], [window(FABLE)], withoutFable51))
    ).toEqual([["claude-fable-5"]]);
  });

  it("matches only one earlier window of the same label and kind", () => {
    expect(
      modelsOf(
        keepWindowLaneModels(
          [window(["claude-fable-5"])],
          [window(FABLE, "Fable reserve")],
          catalog
        )
      )
    ).toEqual([["claude-fable-5"]]);
    expect(
      modelsOf(
        keepWindowLaneModels(
          [window(["claude-fable-5"])],
          [{ ...window(FABLE), kind: "five_hour" }],
          catalog
        )
      )
    ).toEqual([["claude-fable-5"]]);
    expect(
      modelsOf(
        keepWindowLaneModels(
          [window(["claude-fable-5"])],
          [window(FABLE), window(["claude-fable-5", "claude-opus-5-5"])],
          catalog
        )
      )
    ).toEqual([["claude-fable-5"]]);
  });

  it("takes two current windows of the same label and kind as read", () => {
    const split = keepWindowLaneModels(
      [
        { ...window(["claude-fable-5"]), percentLeft: 40 },
        { ...window(["claude-fable-5-1"]), percentLeft: 70 },
      ],
      [window(FABLE)],
      catalog
    );
    expect(modelsOf(split)).toEqual([["claude-fable-5"], ["claude-fable-5-1"]]);
    expect(split.map((limit) => limit.percentLeft)).toEqual([40, 70]);
  });
});
