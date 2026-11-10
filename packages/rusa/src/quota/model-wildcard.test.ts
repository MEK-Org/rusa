import { describe, expect, it } from "vitest";
import type { QuotaLimit } from "../mcp/quota-mcp.js";
import {
  joinWildcardLanes,
  modelEntryCovers,
  modelListCovers,
  modelListsOverlap,
} from "./model-wildcard.js";

const FABLE_LANE = ["claude-fable-*"];

function window(models: string[] | undefined): QuotaLimit {
  return {
    label: "Current week (Fable)",
    kind: "weekly",
    scope: models ? { provider: "claude", models } : { provider: "claude" },
    percentLeft: 70,
  };
}

describe("model wildcards (#1282)", () => {
  it("covers a model by exact ID or by pattern", () => {
    expect(modelEntryCovers("claude-fable-5", "claude-fable-5")).toBe(true);
    expect(modelEntryCovers("claude-fable-5", "claude-fable-5-1")).toBe(false);
    expect(modelEntryCovers("claude-fable-*", "claude-fable-5")).toBe(true);
    expect(modelEntryCovers("claude-fable-*", "claude-fable-5-2")).toBe(true);
    expect(modelEntryCovers("claude-fable-*", "claude-opus-5-5")).toBe(false);
    expect(modelEntryCovers("claude-fable-*", "claude-fable")).toBe(false);
    expect(modelEntryCovers("claude-*-5", "claude-fable-5")).toBe(true);
    expect(modelEntryCovers("claude-*-5", "claude-5")).toBe(false);
    expect(modelEntryCovers("*-fable-*-1", "claude-fable-5-1")).toBe(true);
    expect(modelEntryCovers("*-fable-*-1", "claude-fable-1")).toBe(false);
    // The pattern is literal apart from the star: no regular-expression syntax.
    expect(modelEntryCovers("gpt-5.3-*", "gpt-5x3-codex")).toBe(false);
  });

  it("covers a model when any entry of a list does", () => {
    expect(modelListCovers(["claude-opus-5-5", "claude-fable-*"], "claude-fable-5-2")).toBe(true);
    expect(modelListCovers(FABLE_LANE, "claude-sonnet-5")).toBe(false);
    expect(modelListCovers([], "claude-fable-5")).toBe(false);
  });

  it("finds an overlap between explicit and wildcard lists in either order", () => {
    expect(modelListsOverlap(FABLE_LANE, ["claude-fable-5", "claude-opus-5-5"])).toBe(true);
    expect(modelListsOverlap(["claude-fable-5"], FABLE_LANE)).toBe(true);
    expect(modelListsOverlap(FABLE_LANE, FABLE_LANE)).toBe(true);
    expect(modelListsOverlap(FABLE_LANE, ["claude-opus-5-5"])).toBe(false);
    expect(modelListsOverlap(["claude-fable-5"], ["claude-fable-5-1"])).toBe(false);
  });

  it("puts a window on the wildcard lane that covers every one of its models", () => {
    const grown = window(["claude-fable-5", "claude-fable-5-1", "claude-fable-5-2"]);
    const [joined] = joinWildcardLanes([grown], [["claude-opus-5-5"], FABLE_LANE]);
    expect(joined.scope).toEqual({ provider: "claude", models: FABLE_LANE });
    const [one] = joinWildcardLanes([window(["claude-fable-5"])], [FABLE_LANE]);
    expect(one.scope).toEqual({ provider: "claude", models: FABLE_LANE });
  });

  it("leaves a window as read when no single wildcard lane covers all of it", () => {
    const mixed = window(["claude-fable-5", "claude-opus-5-5"]);
    const provider = window(undefined);
    const already = window(FABLE_LANE);
    const explicitLaneOnly = window(["claude-fable-5"]);
    expect(joinWildcardLanes([mixed, provider, already], [FABLE_LANE])).toEqual([
      mixed,
      provider,
      already,
    ]);
    // An explicit lane is not a wildcard lane: it claims nothing here.
    expect(joinWildcardLanes([explicitLaneOnly], [["claude-fable-5", "claude-fable-5-1"]])).toEqual(
      [explicitLaneOnly]
    );
    // Two wildcard lanes covering the same window are ambiguous.
    expect(joinWildcardLanes([explicitLaneOnly], [FABLE_LANE, ["claude-*"]])).toEqual([
      explicitLaneOnly,
    ]);
  });
});
