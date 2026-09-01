import { describe, expect, it } from "vitest";
import {
  normalizeModelEffortSelection,
  normalizeReasoningEffort,
  validateReasoningEffort,
} from "./reasoning-effort.js";

describe("reasoning effort", () => {
  it("normalizes legacy Codex model qualifiers without changing effective effort", () => {
    expect(normalizeModelEffortSelection("codex", " gpt-5.6-sol extra-high ")).toEqual({
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });
    expect(normalizeModelEffortSelection("codex", "gpt-5.6-sol", "HIGH")).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(() => normalizeModelEffortSelection("codex", "gpt-5.6-sol medium", "high")).toThrow(
      /conflicting reasoning efforts/
    );
    expect(() => normalizeModelEffortSelection("codex", "gpt-5.6-sol unexpected")).toThrow(
      /unrecognized legacy Codex model qualifier/
    );
    expect(() => normalizeModelEffortSelection("codex", "gpt-5.6-sol unexpected high")).toThrow(
      /unrecognized legacy Codex model qualifier/
    );
    expect(() => normalizeModelEffortSelection("codex", "gpt-5.6-sol high unexpected")).toThrow(
      /unrecognized legacy Codex model qualifier/
    );
    expect(normalizeModelEffortSelection("codex", "gpt-5.6-sol ultra")).toEqual({
      model: "gpt-5.6-sol",
      effort: "ultra",
    });
    expect(() => normalizeModelEffortSelection("codex", "gpt-5.6-sol high", null)).toThrow(
      /conflicting reasoning efforts/
    );
  });

  it("leaves non-Codex model vocabulary intact", () => {
    expect(normalizeModelEffortSelection("antigravity", "Gemini 3.7 Flash (High)")).toEqual({
      model: "Gemini 3.7 Flash (High)",
      effort: undefined,
    });
  });

  it("validates against adapter-supplied provider capabilities", () => {
    expect(() =>
      validateReasoningEffort("claude", "claude-opus-4-8", "max", [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ])
    ).not.toThrow();
    expect(() =>
      validateReasoningEffort("antigravity", "gemini", "xhigh", ["low", "medium", "high"])
    ).toThrow(/acceptable values: "low", "medium", "high"/);
    expect(() =>
      validateReasoningEffort("codex", "gpt-5.6-sol", "ultra", [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
      ])
    ).not.toThrow();
    expect(() => validateReasoningEffort("kimi", "kimi-code", "high", undefined)).toThrow(
      /does not expose/
    );
  });

  it("normalizes provider aliases", () => {
    expect(normalizeReasoningEffort("extra-high")).toBe("xhigh");
  });
});
