import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoalescingNotifier } from "./coalescing-notifier.js";

describe("CoalescingNotifier", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends the first alert eagerly", () => {
    const sent: string[] = [];
    const n = new CoalescingNotifier({ send: (t) => sent.push(t), baseMs: 1000 });
    n.notify("fail 1");
    expect(sent).toEqual(["fail 1"]);
  });

  it("coalesces a burst into one summary at window end", async () => {
    const sent: string[] = [];
    const n = new CoalescingNotifier({ send: (t) => sent.push(t), baseMs: 1000 });
    n.notify("fail 1"); // eager
    n.notify("fail 2"); // suppressed
    n.notify("fail 3"); // suppressed
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("fail 3"); // latest
    expect(sent[1]).toContain("+2 more"); // the two suppressed
  });

  it("doubles the window while failures persist (exponential backoff)", async () => {
    const sent: string[] = [];
    const n = new CoalescingNotifier({ send: (t) => sent.push(t), baseMs: 1000, maxMs: 60_000 });
    n.notify("a"); // eager, opens 1s window
    n.notify("b"); // suppressed
    await vi.advanceTimersByTimeAsync(1000); // flush summary, window → 2s
    expect(sent).toHaveLength(2);
    n.notify("c"); // suppressed in the new 2s window
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(2); // not yet — window is now 2s
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent).toHaveLength(3); // flushed after the full 2s
  });

  it("resets the backoff after a quiet window (next alert is eager)", async () => {
    const sent: string[] = [];
    const n = new CoalescingNotifier({ send: (t) => sent.push(t), baseMs: 1000 });
    n.notify("a"); // eager, opens window
    await vi.advanceTimersByTimeAsync(1000); // quiet window → reset, go idle
    expect(sent).toHaveLength(1);
    n.notify("b"); // idle again → eager
    expect(sent).toEqual(["a", "b"]);
  });

  it("close cancels a pending flush", async () => {
    const sent: string[] = [];
    const n = new CoalescingNotifier({ send: (t) => sent.push(t), baseMs: 1000 });
    n.notify("a");
    n.notify("b"); // suppressed, flush scheduled
    n.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent).toEqual(["a"]); // no summary
  });
});
