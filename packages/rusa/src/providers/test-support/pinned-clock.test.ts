import { afterEach, describe, expect, it, vi } from "vitest";
import { pinClock } from "./pinned-clock";

describe("pinClock", () => {
  afterEach(() => vi.useRealTimers());

  it("pins Date to an explicit instant, advances via set(), and restores", () => {
    const clock = pinClock("2026-09-30T16:00:00.000Z");
    expect(new Date().toISOString()).toBe("2026-09-30T16:00:00.000Z");

    clock.set("2026-10-01T00:00:00.000Z");
    expect(new Date().toISOString()).toBe("2026-10-01T00:00:00.000Z");

    clock.restore();
    expect(Math.abs(Date.now() - Date.parse("2026-10-01T00:00:00.000Z"))).toBeGreaterThan(
      24 * 60 * 60 * 1000
    );
  });
});
