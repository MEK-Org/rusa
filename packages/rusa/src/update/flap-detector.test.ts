import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFlapping, recordRestart, recordRestartAndCheckFlap } from "./flap-detector.js";

const HOUR = 3_600_000;

describe("recordRestart", () => {
  it("appends now and prunes entries older than the window", () => {
    const old = [0, 1000]; // both ancient relative to `now`
    const out = recordRestart(old, HOUR + 5000, HOUR);
    expect(out).toEqual([HOUR + 5000]); // the two old ones pruned, now kept
  });

  it("keeps entries inside the window", () => {
    const out = recordRestart([10_000, 20_000], 30_000, HOUR);
    expect(out).toEqual([10_000, 20_000, 30_000]);
  });
});

describe("isFlapping", () => {
  it("false below threshold, true at threshold (within window)", () => {
    const ts = [0, 1000, 2000, 3000]; // 4 restarts
    expect(isFlapping(ts, 3000, HOUR, 5)).toBe(false);
    expect(isFlapping([...ts, 4000], 4000, HOUR, 5)).toBe(true);
  });

  it("ignores restarts OUTSIDE the window (the slow-flap case still resolves)", () => {
    // 5 restarts but spaced 2h apart → never 5-in-an-hour → not flapping
    const ts = [0, 2 * HOUR, 4 * HOUR, 6 * HOUR, 8 * HOUR];
    expect(isFlapping(ts, 8 * HOUR, HOUR, 5)).toBe(false);
  });

  it("CATCHES the slow flap StartLimit misses: 5 restarts ~61s apart within the hour", () => {
    // Spaced 61s — just over a hypothetical fast window, but 5 land inside an hour.
    const ts = [0, 61_000, 122_000, 183_000, 244_000];
    expect(isFlapping(ts, 244_000, HOUR, 5)).toBe(true);
  });
});

describe("recordRestartAndCheckFlap (file-backed)", () => {
  it("accumulates across calls and flips to flapping at the threshold", () => {
    const path = join(mkdtempSync(join(tmpdir(), "flap-")), "restart-log.json");
    const policy = { windowMs: HOUR, threshold: 3 };
    expect(recordRestartAndCheckFlap(path, 1000, policy).flapping).toBe(false);
    expect(recordRestartAndCheckFlap(path, 2000, policy).flapping).toBe(false);
    const third = recordRestartAndCheckFlap(path, 3000, policy);
    expect(third.flapping).toBe(true);
    expect(third.count).toBe(3);
  });

  it("a corrupt/missing log never throws — boot is never blocked", () => {
    const path = join(mkdtempSync(join(tmpdir(), "flap-")), "nope.json");
    expect(() =>
      recordRestartAndCheckFlap(path, 1000, { windowMs: HOUR, threshold: 5 })
    ).not.toThrow();
  });
});
