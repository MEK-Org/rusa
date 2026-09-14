import { describe, expect, it } from "vitest";
import { parseParsedState, serializeParsedState } from "./parsed-state.js";

describe("versioned parsed quota state", () => {
  const snapshot = {
    provider: "claude" as const,
    status: "available" as const,
    scrapedAt: "2030-01-01T00:00:00.000Z",
    limits: [
      {
        label: "Current Week",
        kind: "weekly" as const,
        percentLeft: 80,
        resetAtIso: "2030-01-08T00:00:00.000Z",
        scope: { provider: "claude", models: ["claude-fable"] },
      },
    ],
  };

  it("round-trips canonical model scopes through the versioned blob", () => {
    expect(parseParsedState(serializeParsedState(snapshot))).toEqual(snapshot);
  });

  it("rejects unsupported versions, foreign-provider scopes, and raw panel text", () => {
    expect(parseParsedState(JSON.stringify({ version: 2, snapshot }))).toBeNull();
    expect(
      parseParsedState(
        JSON.stringify({
          version: 1,
          snapshot: {
            ...snapshot,
            limits: [{ ...snapshot.limits[0], scope: { provider: "codex", models: ["x"] } }],
          },
        })
      )
    ).toBeNull();
    expect(
      parseParsedState(JSON.stringify({ version: 1, snapshot: { ...snapshot, raw: "secret" } }))
    ).toBeNull();
  });

  it("rejects malformed explanations before restart inference can trust them", () => {
    const validExplanation = {
      window: "Current Week",
      field: "resetAtIso",
      rule: "assumed_window_starts_now",
      detail: "assumed from the scrape instant",
    };
    expect(
      parseParsedState(
        JSON.stringify({ version: 1, snapshot: { ...snapshot, explanations: [validExplanation] } })
      )
    ).toEqual({ ...snapshot, explanations: [validExplanation] });

    for (const explanation of [
      { ...validExplanation, window: "" },
      { ...validExplanation, window: "Missing Window" },
      { ...validExplanation, field: "percentLeft" },
      { ...validExplanation, rule: "invented_rule" },
      { ...validExplanation, detail: null },
    ]) {
      expect(
        parseParsedState(
          JSON.stringify({ version: 1, snapshot: { ...snapshot, explanations: [explanation] } })
        )
      ).toBeNull();
    }
  });
});
