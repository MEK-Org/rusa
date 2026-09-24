import { describe, expect, it } from "vitest";
import { compareCoordinatorThrottle } from "./compare-only-client.js";
import type { PublishedThrottleProviderStatus } from "./coordinator-protocol.js";
import type { PersistedQuotaProviderStatus } from "./shared-store.js";

const legacy: PersistedQuotaProviderStatus = {
  provider: "claude",
  intervalSeconds: 300,
  uncappedIntervalSeconds: 300,
  governingBucketKey: "claude:weekly",
  capped: false,
  expired: false,
  exhaustedUntil: null,
  updatedAt: new Date(0).toISOString(),
  buckets: [],
};

const coordinator = (
  overrides: Partial<PublishedThrottleProviderStatus> = {}
): PublishedThrottleProviderStatus => ({
  ...legacy,
  freshness: { ageMs: 0, buckets: {}, stale: false, hardStale: false },
  ...overrides,
});

describe("compare-only coordinator throttle records (#503)", () => {
  it.each([
    ["match", coordinator(), legacy],
    ["mismatch", coordinator({ intervalSeconds: 301 }), legacy],
    ["cold", "cold", legacy],
    [
      "stale",
      coordinator({ freshness: { ageMs: 1, buckets: {}, stale: true, hardStale: false } }),
      legacy,
    ],
    ["unavailable", "unavailable", legacy],
    ["incompatible", "incompatible", legacy],
  ] as const)("emits the bounded %s outcome", (outcome, published, persisted) => {
    const record = compareCoordinatorThrottle(published, persisted);
    expect(record.outcome).toBe(outcome);
    expect(Object.keys(record).sort()).toEqual(
      ["coordinatorState", "intervalMatch", "legacyState", "outcome", "stateMatch"].sort()
    );
  });

  it("does not call a warm publication a match when the legacy controller is cold", () => {
    expect(compareCoordinatorThrottle(coordinator(), null)).toMatchObject({
      outcome: "cold",
      coordinatorState: "active",
      legacyState: "cold",
      intervalMatch: null,
      stateMatch: null,
    });
  });
});
