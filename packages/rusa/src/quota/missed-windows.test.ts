import { describe, expect, it } from "vitest";
import type { PublishedHistoryRecord } from "./coordinator-protocol.js";
import { MissedQuotaWindowDetector } from "./missed-windows.js";

function weekly(observedAt: string, percentLeft = 80): PublishedHistoryRecord {
  return {
    scope: "provider",
    kind: "weekly",
    label: "Current week (all models)",
    observedAt,
    percentLeft,
    resetAtIso: "2026-10-02T00:00:00.000Z",
    controllerError: null,
    intervalSeconds: null,
  };
}

function fable(observedAt: string, percentLeft = 60): PublishedHistoryRecord {
  return {
    scope: "model",
    models: ["claude-fable-5-1"],
    kind: "weekly",
    label: "Current week (Fable)",
    observedAt,
    percentLeft,
    resetAtIso: "2026-10-02T00:00:00.000Z",
    controllerError: null,
    intervalSeconds: null,
  };
}

const at = (minute: number) => new Date(Date.UTC(2026, 8, 29, 12, minute)).toISOString();

describe("MissedQuotaWindowDetector (#759)", () => {
  it("raises a window absent from the next scrape once per gap, not on every later scrape", () => {
    const detector = new MissedQuotaWindowDetector();
    const history: PublishedHistoryRecord[] = [weekly(at(0)), fable(at(0))];
    expect(detector.observe("claude", history)).toEqual([]);

    history.push(weekly(at(15)));
    expect(detector.observe("claude", history)).toEqual([
      {
        provider: "claude",
        lane: "model:claude-fable-5-1:weekly",
        label: "Current week (Fable)",
        lastReadingAt: at(0),
        missedAt: at(15),
      },
    ]);

    // The gap stays open across later scrapes and refreshes without re-raising.
    history.push(weekly(at(30)));
    expect(detector.observe("claude", history)).toEqual([]);
    history.push(weekly(at(45)));
    expect(detector.observe("claude", history)).toEqual([]);
    expect(detector.observe("claude", history)).toEqual([]);
  });

  it("re-arms once the window returns, so the next gap raises again", () => {
    const detector = new MissedQuotaWindowDetector();
    const history: PublishedHistoryRecord[] = [weekly(at(0)), fable(at(0))];
    detector.observe("claude", history);
    history.push(weekly(at(15)));
    expect(detector.observe("claude", history)).toHaveLength(1);
    history.push(weekly(at(30)), fable(at(30)));
    expect(detector.observe("claude", history)).toEqual([]);
    history.push(weekly(at(45)));
    expect(detector.observe("claude", history)).toEqual([
      expect.objectContaining({ lane: "model:claude-fable-5-1:weekly", lastReadingAt: at(30) }),
    ]);
  });

  it("finds a gap that opened and closed between two refreshes", () => {
    const detector = new MissedQuotaWindowDetector();
    const history: PublishedHistoryRecord[] = [weekly(at(0)), fable(at(0))];
    detector.observe("claude", history);
    history.push(weekly(at(15)), weekly(at(30)), fable(at(30)));
    expect(detector.observe("claude", history)).toEqual([
      expect.objectContaining({ lane: "model:claude-fable-5-1:weekly", missedAt: at(15) }),
    ]);
  });

  it("takes the first history it sees as a silent baseline", () => {
    const detector = new MissedQuotaWindowDetector();
    // A gap already open before this process started is not raised on restart.
    expect(detector.observe("claude", [weekly(at(0)), fable(at(0)), weekly(at(15))])).toEqual([]);
    expect(
      detector.observe("claude", [weekly(at(0)), fable(at(0)), weekly(at(15)), weekly(at(30))])
    ).toEqual([]);
  });

  it("reads a window the newest scrape in a slot overwrote as still carried", () => {
    const detector = new MissedQuotaWindowDetector();
    detector.observe("claude", [weekly(at(0)), fable(at(0))]);
    // The store keeps one row per window per slot: a second scrape at 12:02
    // overwrites the rows it carried and leaves the rest stamped 12:00.
    expect(detector.observe("claude", [weekly(at(2)), fable(at(0))])).toEqual([
      expect.objectContaining({ lane: "model:claude-fable-5-1:weekly", missedAt: at(2) }),
    ]);
    expect(detector.observe("claude", [weekly(at(2)), fable(at(0)), weekly(at(15))])).toEqual([]);
  });

  it("finds a window an unseen scrape carried and the later scrape in its slot dropped", () => {
    const detector = new MissedQuotaWindowDetector();
    detector.observe("claude", [weekly(at(0))]);
    expect(detector.observe("claude", [weekly(at(0)), fable(at(15)), weekly(at(17))])).toEqual([
      expect.objectContaining({
        lane: "model:claude-fable-5-1:weekly",
        lastReadingAt: at(15),
        missedAt: at(17),
      }),
    ]);
  });

  it("takes rows of one scrape that arrive across refreshes as that scrape", () => {
    const detector = new MissedQuotaWindowDetector();
    detector.observe("claude", [weekly(at(0))]);
    expect(detector.observe("claude", [weekly(at(0)), fable(at(0))])).toEqual([]);
    expect(detector.observe("claude", [weekly(at(0)), fable(at(0)), weekly(at(15))])).toEqual([
      expect.objectContaining({ lane: "model:claude-fable-5-1:weekly", missedAt: at(15) }),
    ]);
  });

  it("keeps providers apart and ignores a refresh with no new scrape", () => {
    const detector = new MissedQuotaWindowDetector();
    detector.observe("claude", [weekly(at(0)), fable(at(0))]);
    detector.observe("codex", [weekly(at(0))]);
    expect(detector.observe("codex", [weekly(at(0)), weekly(at(15))])).toEqual([]);
    expect(detector.observe("claude", [])).toEqual([]);
    expect(detector.observe("claude", [weekly(at(0)), fable(at(0))])).toEqual([]);
  });
});
