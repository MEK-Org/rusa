import { afterEach, describe, expect, it, vi } from "vitest";
import { pinClock, withPinnedClock } from "./pinned-clock";

describe("pinClock", () => {
  afterEach(() => vi.useRealTimers());

  it("pins Date to the given instant, as string, number, or Date", () => {
    const clock = pinClock("2026-09-30T16:00:00.000Z");
    expect(new Date().toISOString()).toBe("2026-09-30T16:00:00.000Z");

    clock.set(Date.parse("2026-09-30T16:30:00.000Z"));
    expect(Date.now()).toBe(Date.parse("2026-09-30T16:30:00.000Z"));

    clock.set(new Date("2026-10-01T00:00:00.000Z"));
    expect(new Date().toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("freezes at the current real time when no instant is given", () => {
    const before = Date.now();
    pinClock();
    const first = Date.now();
    const second = Date.now();
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(before);
  });

  it("restore() puts the real clock back", () => {
    const clock = pinClock("2026-09-30T16:00:00.000Z");
    clock.restore();
    expect(Math.abs(Date.now() - Date.parse("2026-09-30T16:00:00.000Z"))).toBeGreaterThan(
      24 * 60 * 60 * 1000
    );
  });
});

describe("withPinnedClock", () => {
  afterEach(() => vi.useRealTimers());

  it("pins for the callback and restores afterwards", async () => {
    await withPinnedClock("2026-09-30T16:00:00.000Z", async () => {
      expect(new Date().toISOString()).toBe("2026-09-30T16:00:00.000Z");
    });
    expect(Math.abs(Date.now() - Date.parse("2026-09-30T16:00:00.000Z"))).toBeGreaterThan(
      24 * 60 * 60 * 1000
    );
  });

  it("restores when the callback throws", async () => {
    await expect(
      withPinnedClock("2026-09-30T16:00:00.000Z", async () => {
        throw new Error("fixture blew up");
      })
    ).rejects.toThrow("fixture blew up");
    expect(Math.abs(Date.now() - Date.parse("2026-09-30T16:00:00.000Z"))).toBeGreaterThan(
      24 * 60 * 60 * 1000
    );
  });
});
