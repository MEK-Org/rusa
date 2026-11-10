import { describe, expect, it } from "vitest";
import { modelEntryCovers, modelListCovers } from "./model-matchers.js";

const FABLE_LANE = ["claude-fable-*"];

describe("model matchers (#1282)", () => {
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
});
