import { describe, expect, it } from "vitest";
import {
  aggregateInboxMetricSamples,
  type InboxMetricActorSample,
  inboxMetricWindowBounds,
} from "./inbox-metrics.js";

const at = "2026-10-19T12:00:00.000Z";

function sample(unhandledCount: number, oldestDeliveredAt: string | null): InboxMetricActorSample {
  return { unhandledCount, oldestDeliveredAt };
}

describe("aggregateInboxMetricSamples", () => {
  it("computes cross-actor median and max with known-empty actors contributing zero", () => {
    expect(
      aggregateInboxMetricSamples(at, [
        sample(0, null),
        sample(2, "2026-10-19T11:58:00.000Z"),
        sample(6, "2026-10-19T11:54:00.000Z"),
        sample(8, "2026-10-19T11:52:00.000Z"),
      ])
    ).toEqual({
      actorCount: 4,
      inboxSizeMedian: 4,
      inboxSizeMax: 8,
      oldestAgeSecondsMedian: 240,
      oldestAgeSecondsMax: 480,
    });
  });

  it("takes the middle value for an odd population", () => {
    expect(
      aggregateInboxMetricSamples(at, [
        sample(9, "2026-10-19T11:00:00.000Z"),
        sample(0, null),
        sample(3, "2026-10-19T11:59:30.000Z"),
      ])
    ).toMatchObject({ inboxSizeMedian: 3, oldestAgeSecondsMedian: 30 });
  });

  it("has no statistic, rather than a zero, when no actor is live", () => {
    expect(aggregateInboxMetricSamples(at, [])).toEqual({
      actorCount: 0,
      inboxSizeMedian: null,
      inboxSizeMax: null,
      oldestAgeSecondsMedian: null,
      oldestAgeSecondsMax: null,
    });
  });

  it("rejects an inconsistent sample before it can corrupt a chart", () => {
    expect(() => aggregateInboxMetricSamples(at, [sample(1, null)])).toThrow(
      "oldestDeliveredAt is required"
    );
    expect(() => aggregateInboxMetricSamples(at, [sample(0, at)])).toThrow(
      "must be null for an empty inbox"
    );
    expect(() => aggregateInboxMetricSamples(at, [sample(1, "2026-10-19T12:00:01.000Z")])).toThrow(
      "at or before observedAt"
    );
  });
});

describe("inboxMetricWindowBounds", () => {
  it("ends at the current UTC minute and starts exactly three days earlier", () => {
    const { startMs, endMs } = inboxMetricWindowBounds(Date.parse("2026-10-19T12:34:56.789Z"));
    expect(new Date(endMs).toISOString()).toBe("2026-10-19T12:34:00.000Z");
    expect(new Date(startMs).toISOString()).toBe("2026-10-16T12:34:00.000Z");
  });
});
