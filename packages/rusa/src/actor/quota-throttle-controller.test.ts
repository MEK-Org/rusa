import { describe, expect, it } from "vitest";
import { type ProviderQuotaSnapshot, parseClaudeQuota } from "../mcp/quota-mcp.js";
import { QuotaThrottleController, quotaBucketsFromState } from "./quota-throttle-controller.js";

const HOUR = 60 * 60 * 1000;
const _NOW = Date.parse("2026-07-22T12:00:00.000Z");

describe("QuotaThrottleController", () => {
  const HOUR = 3600 * 1000;
  const NOW = Date.parse("2026-07-22T12:00:00Z");

  it("returns configuredIntervalSeconds (base interval) if no learning is possible (0 or 1 scrapes)", () => {
    const controller = new QuotaThrottleController({ now: () => NOW, intervalSeconds: 60 });
    const tick = controller.update([]);
    expect(tick.intervalSeconds).toBe(60);

    const tick2 = controller.update([
      {
        key: "codex:five_hour",
        percentLeft: 50,
        resetAtIso: new Date(NOW + 2 * HOUR).toISOString(),
        windowMs: 5 * HOUR,
        observedAtIso: new Date(NOW).toISOString(),
      },
    ]);
    expect(tick2.intervalSeconds).toBe(60);
  });

  it("computes a stateless interval based on history and integrates over dt", () => {
    const controller = new QuotaThrottleController({ now: () => NOW, intervalSeconds: 0 });
    const first = {
      key: "codex:five_hour",
      percentLeft: 50,
      resetAtIso: new Date(NOW + 2 * HOUR).toISOString(), // 2h left of 5h (40% time remaining)
      windowMs: 5 * HOUR,
      observedAtIso: new Date(NOW - 30 * 60 * 1000).toISOString(), // 30 min ago
    };
    // 30 min ago, time remaining was 2.5h (50%). percentLeft was 50%. error = 0.

    const second = {
      key: "codex:five_hour",
      percentLeft: 30, // dropped 20% in 30 mins!
      resetAtIso: new Date(NOW + 2 * HOUR).toISOString(), // 2h left (40% time remaining)
      windowMs: 5 * HOUR,
      observedAtIso: new Date(NOW).toISOString(),
    };
    // Now time remaining is 40%, but percentLeft is 30%. error = 10%.

    // dt = 1800s. deltaError = 10%.
    // pTerm = 12 * 10 = 120s
    // iTerm = 0.05 * 10 * 10 * 1800 = 9000s
    // bucketInterval = 120 + 9000 = 9120s

    const tick = controller.update([first, second]);
    expect(tick.buckets[0].requiredIntervalSeconds).toBeGreaterThan(0);
    expect(tick.intervalSeconds).toBeGreaterThan(0);
  });

  it("yields 0 interval if on track or ahead (error <= 0)", () => {
    const controller = new QuotaThrottleController({ now: () => NOW });
    const first = {
      key: "codex:five_hour",
      percentLeft: 50,
      resetAtIso: new Date(NOW + 2 * HOUR).toISOString(), // 2h left (40% time remaining) -> 50% left -> error = -10 (ahead)
      windowMs: 5 * HOUR,
      observedAtIso: new Date(NOW - 60 * 60 * 1000).toISOString(), // 1 hr ago
    };
    const second = {
      key: "codex:five_hour",
      percentLeft: 45,
      resetAtIso: new Date(NOW + 2 * HOUR).toISOString(), // 2h left -> 40% time remaining -> 45% left -> error = -5 (ahead)
      windowMs: 5 * HOUR,
      observedAtIso: new Date(NOW).toISOString(),
    };

    const tick = controller.update([first, second]);
    expect(tick.buckets[0].requiredIntervalSeconds).toBe(0);
  });

  it("exhausts immediately when percentLeft <= 0", () => {
    const controller = new QuotaThrottleController({ now: () => NOW });
    const first = {
      key: "codex:five_hour",
      percentLeft: 0,
      resetAtIso: new Date(NOW + 2 * HOUR).toISOString(),
      windowMs: 5 * HOUR,
      observedAtIso: new Date(NOW).toISOString(),
    };
    const tick = controller.update([first]);
    // It should pace at the time remaining (2 hours = 7200s)
    expect(tick.intervalSeconds).toBe(7200);
    expect(tick.expired).toBe(true);
  });
});

describe("quotaBucketsFromState", () => {
  it("admits provider-scoped limits and ignores model-scoped limits", () => {
    const state: ProviderQuotaSnapshot = {
      provider: "agy",
      status: "available",
      scrapedAt: "2026-07-22T12:00:00.000Z",
      limits: [
        {
          label: "Weekly GEMINI MODELS",
          kind: "weekly",
          percentLeft: 70,
          resetAtIso: "2026-07-29T12:00:00Z",
          scope: "provider",
        },
        {
          label: "Five Hour GEMINI MODELS",
          kind: "five_hour",
          percentLeft: 30,
          resetAtIso: "2026-07-22T17:00:00Z",
          scope: "provider",
        },
        {
          label: "Session Model",
          kind: "session",
          percentLeft: 80,
          resetAtIso: "2026-07-23T12:00:00Z",
          scope: "model",
        },
        {
          label: "Missing Scope",
          kind: "five_hour",
          percentLeft: 50,
          resetAtIso: "2026-07-22T17:00:00Z",
          // no scope
        },
      ],
    };

    const buckets = quotaBucketsFromState(state);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      key: "agy:weekly:Weekly GEMINI MODELS",
      windowMs: 7 * 24 * HOUR,
    });
    expect(buckets[1]).toMatchObject({
      key: "agy:five_hour:Five Hour GEMINI MODELS",
      windowMs: 5 * HOUR,
    });
  });

  it("fail-closed: empty state.limits yields 0 buckets", () => {
    const state: ProviderQuotaSnapshot = {
      provider: "agy",
      status: "available",
      scrapedAt: "2026-07-22T12:00:00.000Z",
      limits: [],
    };
    expect(quotaBucketsFromState(state)).toHaveLength(0);
  });

  it("drops the no-key fallback state safely because it carries no limits at all", async () => {
    // ISSUE_NUM / ISSUE_NUM: The no-key fallback path produces no structured limits
    // (LLM-only parsing), meaning it cannot pace. Ensure it safely yields 0
    // buckets rather than guessing from raw output.
    const rawOutput = "Current week (all models): 50% used - resets in 2 hours";
    const parsed = await parseClaudeQuota(rawOutput);

    const state: ProviderQuotaSnapshot = {
      provider: "claude",
      status: parsed.status || "available",
      message: parsed.message,
      limits: parsed.limits,
      scrapedAt: "2026-07-22T12:00:00.000Z",
    };

    const buckets = quotaBucketsFromState(state);
    expect(buckets).toHaveLength(0);
  });

  it("drops limits on the LLM path that fail to resolve their own resetAtIso", () => {
    const state: ProviderQuotaSnapshot = {
      provider: "claude",
      status: "available",
      scrapedAt: "2026-07-22T12:00:00.000Z",
      limits: [
        {
          label: "Weekly (provider-wide)",
          kind: "weekly",
          scope: "provider",
          percentLeft: 50,
          // missing resetAtIso
        },
      ],
    };

    const buckets = quotaBucketsFromState(state);
    expect(buckets).toHaveLength(0);
  });
});
