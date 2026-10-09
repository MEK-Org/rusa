import { describe, expect, it } from "vitest";
import { inferQuotaState, type ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import { extractedNoQuotaValues, parseParsedState, serializeParsedState } from "./parsed-state.js";

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

  it("round-trips limit.scrapedAt timestamp through the versioned blob", () => {
    const withLimitScrapedAt = {
      ...snapshot,
      limits: [
        {
          ...snapshot.limits[0],
          scrapedAt: "2029-12-31T23:30:00.000Z",
        },
      ],
    };
    expect(parseParsedState(serializeParsedState(withLimitScrapedAt))).toEqual(withLimitScrapedAt);
    expect(
      parseParsedState(
        JSON.stringify({
          version: 1,
          snapshot: {
            ...snapshot,
            limits: [{ ...snapshot.limits[0], scrapedAt: "not-a-date" }],
          },
        })
      )
    ).toBeNull();
  });

  it("round-trips failed extraction attempt diagnostics through the versioned blob (#774)", () => {
    const withFailures = {
      ...snapshot,
      extractionFailures: [
        {
          attempt: 1,
          model: "gemini-3.5-flash-lite",
          elapsedMs: 4_210,
          error: "Quota parse failed: response truncated by model output token limit",
          finishReason: "MAX_TOKENS",
          responseHead: '{"status":"available","windows":[{"usedPercent":"43.0000',
          responseLength: 32_760,
        },
      ],
    };
    expect(parseParsedState(serializeParsedState(withFailures))).toEqual(withFailures);
  });

  it("accepts a fully valid legacy bare snapshot, normalising provider scope and discarding old model strings", () => {
    expect(
      parseParsedState(
        JSON.stringify({
          ...snapshot,
          limits: [
            { ...snapshot.limits[0], scope: "provider" },
            { ...snapshot.limits[0], label: "Legacy model", scope: "model" },
          ],
        })
      )
    ).toEqual({
      ...snapshot,
      limits: [{ ...snapshot.limits[0], scope: { provider: "claude" } }],
    });
  });

  it("rejects malformed legacy snapshots instead of taking a permissive compatibility path", () => {
    expect(
      parseParsedState(
        JSON.stringify({
          ...snapshot,
          limits: [{ ...snapshot.limits[0], percentLeft: 101, scope: "provider" }],
        })
      )
    ).toBeNull();
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

describe("extractedNoQuotaValues (#982)", () => {
  const scrapedAt = "2030-01-01T01:00:00.000Z";
  const prev: ProviderQuotaSnapshot = {
    provider: "agy",
    status: "available",
    scrapedAt: "2030-01-01T00:00:00.000Z",
    limits: [
      {
        label: "Weekly Limit",
        kind: "weekly",
        percentLeft: 70,
        resetAtIso: "2030-01-05T00:00:00.000Z",
      },
      {
        label: "Five Hour Limit",
        kind: "five_hour",
        percentLeft: 40,
        resetAtIso: "2030-01-01T03:00:00.000Z",
      },
    ],
  };
  // Judged on the stored blob, as listScrapeOutcomesSince reads it.
  const judge = (raw: ProviderQuotaSnapshot) => {
    const stored = parseParsedState(serializeParsedState(inferQuotaState(raw, prev, scrapedAt)));
    if (!stored) throw new Error("stored state did not round-trip");
    return extractedNoQuotaValues(stored);
  };

  it("fails a read whose windows were all carried over an empty parse", () => {
    expect(judge({ provider: "agy", status: "unknown", scrapedAt, limits: [] })).toBe(true);
  });

  it("does not flag an unknown read with nothing to carry as a carried bad read", () => {
    expect(extractedNoQuotaValues({ provider: "agy", status: "unknown", scrapedAt })).toBe(false);
  });

  it("keeps a read that extracted model-only limits with status unknown", () => {
    expect(
      extractedNoQuotaValues({
        provider: "claude",
        status: "unknown",
        scrapedAt,
        limits: [{ label: "Fable", kind: "five_hour", percentLeft: 50 }],
      })
    ).toBe(false);
  });

  it("keeps a read that extracted values but carried a missing reset", () => {
    const raw: ProviderQuotaSnapshot = {
      provider: "agy",
      status: "available",
      scrapedAt,
      limits: [
        { label: "Weekly Limit", kind: "weekly", percentLeft: 68 },
        { label: "Five Hour Limit", kind: "five_hour", percentLeft: 35 },
      ],
    };
    // Both resets were carried, under the same rule name.
    expect(inferQuotaState(raw, prev, scrapedAt).explanations?.map((e) => e.rule)).toEqual([
      "carried_forward_bad_read",
      "carried_forward_bad_read",
    ]);
    expect(judge(raw)).toBe(false);
  });

  it("keeps a clean read", () => {
    expect(judge({ ...prev, scrapedAt })).toBe(false);
  });
});
