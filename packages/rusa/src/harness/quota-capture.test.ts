import { describe, expect, it } from "vitest";

import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import {
  captureQuota,
  diffQuota,
  isProbeableProvider,
  type QuotaCapture,
  quotaEvidence,
} from "./quota-capture.js";

const AT_LAUNCH = "2026-08-06T09:10:00.000Z";
const AT_EXIT = "2026-08-06T09:35:00.000Z";

/** The g2v3d shape: a real kimi panel with both windows numbered. */
function kimiSnapshot(scrapedAt: string, fiveHour: number, weekly: number): ProviderQuotaSnapshot {
  return {
    provider: "kimi",
    status: "available",
    scrapedAt,
    limits: [
      { label: "5h limit", kind: "five_hour", percentLeft: fiveHour },
      { label: "Weekly limit", kind: "weekly", percentLeft: weekly },
    ],
  };
}

/** What the kimi probe actually returns from a read-only worker plane . */
const UNREADABLE: ProviderQuotaSnapshot = {
  provider: "kimi",
  status: "unknown",
  message: "kimi /usage panel could not be identified semantically",
};

function reading(snapshot: ProviderQuotaSnapshot) {
  return { readQuota: async () => snapshot, now: () => new Date(AT_LAUNCH) };
}

describe("captureQuota — a reading never ends the run ", () => {
  it("records a throwing probe as a result instead of propagating it", async () => {
    const capture = await captureQuota("exit", "kimi", {
      readQuota: async () => {
        throw new Error("403 exhausted");
      },
      now: () => new Date(AT_EXIT),
    });

    expect(capture.outcome).toBe("probe-failed");
    // The failure path is the whole point of the issue: the run that dies is the run whose
    // window reading matters, so the error text has to survive into the artifact.
    expect(capture.message).toContain("403 exhausted");
    expect(capture.requestedAt).toBe(AT_EXIT);
    expect(capture.windows).toEqual([]);
  });

  it("distinguishes UNREADABLE from a reading of zero", async () => {
    const capture = await captureQuota("launch", "kimi", reading(UNREADABLE));

    expect(capture.outcome).toBe("unreadable");
    expect(capture.status).toBe("unknown");
    expect(capture.message).toContain("UNREADABLE");
    expect(capture.message).toContain("could not be identified semantically");
    // No window may be invented for a screen nobody could read.
    expect(capture.windows).toEqual([]);
  });

  it("says NOT CAPTURED for a provider get_quota cannot probe, without calling anything", async () => {
    let called = false;
    const capture = await captureQuota("launch", "gemini", {
      readQuota: async () => {
        called = true;
        throw new Error("should not be reached");
      },
      now: () => new Date(AT_LAUNCH),
    });

    expect(called).toBe(false);
    expect(capture.outcome).toBe("not-probeable");
    expect(capture.message).toContain("NOT CAPTURED");
    expect(isProbeableProvider("gemini")).toBe(false);
    expect(isProbeableProvider("kimi")).toBe(true);
  });

  it("flattens a real snapshot's windows verbatim", async () => {
    const capture = await captureQuota("launch", "kimi", reading(kimiSnapshot(AT_LAUNCH, 100, 46)));

    expect(capture.outcome).toBe("read");
    expect(capture.scrapedAt).toBe(AT_LAUNCH);
    expect(capture.windows).toEqual([
      { label: "5h limit", kind: "five_hour", percentLeft: 100 },
      { label: "Weekly limit", kind: "weekly", percentLeft: 46 },
    ]);
  });

  it("treats a snapshot whose limits carry no numbers as unreadable, not as read", async () => {
    const capture = await captureQuota("launch", "codex", {
      readQuota: async () => ({
        provider: "codex",
        status: "available",
        scrapedAt: AT_LAUNCH,
        limits: [
          {
            label: "5h limit",
            kind: "five_hour",
            percentLeft: undefined as unknown as number,
          },
        ],
      }),
      now: () => new Date(AT_LAUNCH),
    });

    expect(capture.outcome).toBe("unreadable");
    // The window is still listed — it was seen, it just had no number.
    expect(capture.windows).toHaveLength(1);
    expect(capture.windows[0]?.percentLeft).toBeNull();
  });
});

describe("diffQuota — the burn, or an explicit refusal ", () => {
  async function capture(phase: "launch" | "exit", snapshot: ProviderQuotaSnapshot) {
    return captureQuota(phase, "kimi", {
      readQuota: async () => snapshot,
      now: () => new Date(phase === "launch" ? AT_LAUNCH : AT_EXIT),
    });
  }

  it("computes points consumed per window", async () => {
    const burn = diffQuota(
      await capture("launch", kimiSnapshot(AT_LAUNCH, 100, 46)),
      await capture("exit", kimiSnapshot(AT_EXIT, 27, 32))
    );

    expect(burn.computed).toBe(true);
    expect(burn.windows.map((w) => [w.kind, w.consumedPoints])).toEqual([
      ["five_hour", 73],
      ["weekly", 14],
    ]);
    expect(burn.windows.every((w) => w.note === null)).toBe(true);
  });

  it("REFUSES when both readings carry the same scrapedAt — the TTL cache trap", async () => {
    // codex's quota TTL is 30 minutes, longer than a short A/B run. A before/after pair
    // through one cached service returns the identical snapshot twice.
    const cached = kimiSnapshot(AT_LAUNCH, 100, 46);
    const burn = diffQuota(await capture("launch", cached), await capture("exit", cached));

    expect(burn.computed).toBe(false);
    // The bug this guard exists for: subtracting a snapshot from itself yields a perfect,
    // entirely fictional burn of 0. Assert the NUMBER is absent, not merely that a flag is
    // set — a `0` left in the artifact is what a later reader would pick up.
    expect(burn.windows).toHaveLength(2);
    expect(burn.windows.every((w) => w.consumedPoints === null)).toBe(true);
    if (burn.computed) throw new Error("unreachable");
    expect(burn.reason).toContain("served from the quota TTL cache");
    expect(burn.reason).toContain(AT_LAUNCH);
  });

  it("does not mistake two genuinely identical readings for a cache hit", async () => {
    // Same percentages, different scrape moments: a real measurement of no burn.
    const burn = diffQuota(
      await capture("launch", kimiSnapshot(AT_LAUNCH, 100, 46)),
      await capture("exit", kimiSnapshot(AT_EXIT, 100, 46))
    );

    expect(burn.computed).toBe(true);
    expect(burn.windows.map((w) => w.consumedPoints)).toEqual([0, 0]);
  });

  it("refuses when either side is unreadable, and quotes what that side saw", async () => {
    const burn = diffQuota(
      await capture("launch", kimiSnapshot(AT_LAUNCH, 100, 46)),
      await capture("exit", UNREADABLE)
    );

    expect(burn.computed).toBe(false);
    if (burn.computed) throw new Error("unreachable");
    expect(burn.reason).toContain("exit=unreadable");
    expect(burn.reason).toContain("could not be identified semantically");
    // The launch numbers survive into the refusal — losing them is the loss ISSUE_NUM is about.
    expect(burn.windows.map((w) => w.beforePercentLeft)).toEqual([100, 46]);
    expect(burn.windows.every((w) => w.consumedPoints === null)).toBe(true);
  });

  it("refuses, rather than reporting nothing, when the run died before an exit reading", async () => {
    const burn = diffQuota(await capture("launch", kimiSnapshot(AT_LAUNCH, 100, 46)), null);

    expect(burn.computed).toBe(false);
    if (burn.computed) throw new Error("unreachable");
    expect(burn.reason).toContain("no exit reading");
  });

  it("keeps a one-sided window as an entry with a note instead of dropping it", async () => {
    const before = await capture("launch", kimiSnapshot(AT_LAUNCH, 100, 46));
    const after = await capture("exit", {
      provider: "kimi",
      status: "available",
      scrapedAt: AT_EXIT,
      limits: [{ label: "5h limit", kind: "five_hour", percentLeft: 27 }],
    });

    const burn = diffQuota(before, after);

    expect(burn.computed).toBe(true);
    expect(burn.windows).toHaveLength(2);
    const weekly = burn.windows.find((w) => w.kind === "weekly");
    expect(weekly?.consumedPoints).toBeNull();
    expect(weekly?.beforePercentLeft).toBe(46);
    // "Not captured" must not read as "not there".
    expect(weekly?.note).toContain("NOT CAPTURED");
  });

  it("matches windows on kind even when the provider reworded the label", async () => {
    const before = await capture("launch", kimiSnapshot(AT_LAUNCH, 100, 46));
    const after = await capture("exit", {
      provider: "kimi",
      status: "available",
      scrapedAt: AT_EXIT,
      limits: [
        { label: "5-hour limit", kind: "five_hour", percentLeft: 27 },
        { label: "Weekly", kind: "weekly", percentLeft: 32 },
      ],
    });

    const burn = diffQuota(before, after);

    expect(burn.computed).toBe(true);
    expect(burn.windows).toHaveLength(2);
    expect(burn.windows.map((w) => w.consumedPoints)).toEqual([73, 14]);
  });

  it("flags a window that reset mid-run rather than reporting a negative burn plainly", async () => {
    const burn = diffQuota(
      await capture("launch", kimiSnapshot(AT_LAUNCH, 10, 46)),
      await capture("exit", kimiSnapshot(AT_EXIT, 100, 32))
    );

    expect(burn.computed).toBe(true);
    const fiveHour = burn.windows.find((w) => w.kind === "five_hour");
    expect(fiveHour?.consumedPoints).toBe(-90);
    expect(fiveHour?.note).toContain("reset mid-run");
  });
});

describe("quotaEvidence — what the artifact carries", () => {
  it("carries the run's error alongside the readings when the run died", async () => {
    const launch = await captureQuota("launch", "kimi", reading(kimiSnapshot(AT_LAUNCH, 100, 46)));
    const exit: QuotaCapture = await captureQuota("exit", "kimi", {
      readQuota: async () => {
        throw new Error("403 quota exhausted");
      },
      now: () => new Date(AT_EXIT),
    });

    const evidence = quotaEvidence({
      provider: "kimi",
      launch,
      exit,
      runError: "provider run 10/10 failed: 403",
    });

    expect(evidence.runError).toContain("403");
    expect(evidence.launch?.windows.map((w) => w.percentLeft)).toEqual([100, 46]);
    expect(evidence.exit?.outcome).toBe("probe-failed");
    expect(evidence.burn.computed).toBe(false);
  });

  it("refuses without either reading rather than defaulting to a burn", () => {
    const evidence = quotaEvidence({ provider: "kimi", launch: null, exit: null, runError: null });

    expect(evidence.burn.computed).toBe(false);
    if (evidence.burn.computed) throw new Error("unreachable");
    expect(evidence.burn.reason).toContain("neither end");
  });
});
