/**
 * Shifted-clock harness for the second Checks vitest run (#1218).
 *
 * Loaded as the setup file of vitest.shifted.config.ts. Every test file in
 * that run sees `Date` faked SHIFT_MS ahead of the real clock, still
 * advancing (shouldAdvanceTime), so a dated fixture that only passes at
 * today's real date fails the day it is written instead of weeks later
 * (#1184, #1210). Tests that pin their own clock — via pinClock or
 * vi.useFakeTimers — override this shift, which is exactly what makes the
 * pinned sites calendar-independent.
 *
 * The shift must exceed every retention/expiry window the code measures
 * against Date.now(); the audit lives in the Checks workflow step that runs
 * this. 45 days clears the largest window (30 days).
 */

import { afterAll, beforeEach, vi } from "vitest";

const SHIFT_MS = 45 * 24 * 60 * 60 * 1000;

function installShiftedClock() {
  vi.useRealTimers();
  vi.useFakeTimers({
    toFake: ["Date"],
    now: Date.now() + SHIFT_MS,
    shouldAdvanceTime: true,
  });
}

// Install once at module load for any module-level evaluation or beforeAll.
installShiftedClock();

// Re-install before each test so a test running after an in-file
// `pinClock().restore()` or `afterEach(() => vi.useRealTimers())` still
// starts with the shifted clock (#1218 / PR #1219 review).
beforeEach(() => {
  installShiftedClock();
});

afterAll(() => {
  vi.useRealTimers();
});
