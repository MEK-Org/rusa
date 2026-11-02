/**
 * Pinned test clock for dated fixtures (#1218).
 *
 * A fixture carrying a literal date fails the day the code under test
 * measures retention or expiry against the real clock and the calendar
 * crosses the fixture's window: both #1184 and #1210 shipped green and
 * went red weeks later with no code change. Pinning the test clock to the
 * fixture's own timeline makes the suite independent of the day it runs.
 *
 * pinClock fakes only `Date`. A test that also needs fake timers — anything
 * driving vi.advanceTimersByTime / vi.runAllTimersAsync, or a timer the code
 * under test must never really wait for — keeps vi.useFakeTimers() instead;
 * each such site carries a one-line reason.
 */

import { vi } from "vitest";

/** Handle for a clock pinned by {@link pinClock}. */
export interface PinnedClock {
  /** Move the pinned clock to an absolute instant. */
  set(at: string | number | Date): void;
  /** Restore the real clock. Idempotent. */
  restore(): void;
}

/**
 * Pin the test clock to `at` (an ISO string, epoch milliseconds, or Date;
 * defaults to freezing at the current real time) and return its handle.
 * Only `Date` is faked; timers stay real.
 */
export function pinClock(at: string | number | Date = new Date()): PinnedClock {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
  return {
    set: (next) => vi.setSystemTime(next),
    restore: () => vi.useRealTimers(),
  };
}

/**
 * Run `run` with the clock pinned to `at`, restoring the real clock on
 * success and on throw.
 */
export async function withPinnedClock<T>(
  at: string | number | Date,
  run: () => T | Promise<T>
): Promise<T> {
  const clock = pinClock(at);
  try {
    return await run();
  } finally {
    clock.restore();
  }
}
