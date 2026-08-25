import { describe, expect, it, vi } from "vitest";
import { WebhookSilenceDetector } from "./silence-detector.js";

const THRESHOLD_MS = 45 * 60 * 1000;

describe("WebhookSilenceDetector", () => {
  it("alerts when outbound GitHub writes are newer than a silent inbound edge", async () => {
    let now = 0;
    const notify = vi.fn();
    const detector = new WebhookSilenceDetector({
      now: () => now,
      thresholdMs: THRESHOLD_MS,
      notify,
    });

    detector.recordInboundEvent(0);
    detector.recordOutboundWrite(10 * 60 * 1000);
    now = 46 * 60 * 1000;

    expect(await detector.check()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain(
      "Last inbound webhook event: 1970-01-01T00:00:00.000Z"
    );
    expect(notify.mock.calls[0][0]).toContain("Silent for 46 minute(s)");
    expect(notify.mock.calls[0][0]).toContain("Recovery runbook: Rusa-Org/rusaISSUE_NUM.");
  });

  it("does not alert when silence has no outbound activity probe", async () => {
    const notify = vi.fn();
    const detector = new WebhookSilenceDetector({
      now: () => 60 * 60 * 1000,
      thresholdMs: THRESHOLD_MS,
      notify,
    });

    detector.recordInboundEvent(0);

    expect(await detector.check()).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("re-arms after a recovered inbound event", async () => {
    let now = 0;
    const notify = vi.fn();
    const detector = new WebhookSilenceDetector({
      now: () => now,
      thresholdMs: THRESHOLD_MS,
      notify,
    });

    detector.recordInboundEvent(0);
    detector.recordOutboundWrite(1);
    now = 46 * 60 * 1000;
    expect(await detector.check()).toBe(true);

    detector.recordInboundEvent(50 * 60 * 1000);
    detector.recordOutboundWrite(51 * 60 * 1000);
    now = 97 * 60 * 1000;

    expect(await detector.check()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate alerts during the same outage", async () => {
    const notify = vi.fn();
    const detector = new WebhookSilenceDetector({
      now: () => 60 * 60 * 1000,
      thresholdMs: THRESHOLD_MS,
      notify,
    });

    detector.recordInboundEvent(0);
    detector.recordOutboundWrite(1);

    expect(await detector.check()).toBe(true);
    expect(await detector.check()).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("logs instead of throwing when error chat is unconfigured", async () => {
    const log = vi.fn();
    const detector = new WebhookSilenceDetector({
      now: () => 60 * 60 * 1000,
      thresholdMs: THRESHOLD_MS,
      log,
    });

    detector.recordInboundEvent(0);
    detector.recordOutboundWrite(1);

    expect(await detector.check()).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("[webhook-silence]");
  });

  it("does not alarm if probe is echoed before window expires", async () => {
    let now = 0;
    const notify = vi.fn();
    const probe = vi.fn().mockResolvedValue(undefined);
    const detector = new WebhookSilenceDetector({
      now: () => now,
      thresholdMs: THRESHOLD_MS,
      notify,
      proberTarget: { repo: "org/repo", issueNumber: 123 },
      probe,
      probeWindowMs: 10,
    });

    detector.recordInboundEvent(0);
    detector.recordOutboundWrite(1);
    now = 46 * 60 * 1000;

    // Simulate echo by calling recordInboundEvent while check is waiting
    setTimeout(() => {
      detector.recordInboundEvent(now + 1);
    }, 2);

    expect(await detector.check()).toBe(false);
    expect(probe).toHaveBeenCalledWith("org/repo", 123);
    expect(notify).not.toHaveBeenCalled();
  });

  it("alarms if probe goes unechoed", async () => {
    let now = 0;
    const notify = vi.fn();
    const probe = vi.fn().mockResolvedValue(undefined);
    const detector = new WebhookSilenceDetector({
      now: () => now,
      thresholdMs: THRESHOLD_MS,
      notify,
      proberTarget: { repo: "org/repo", issueNumber: 123 },
      probe,
      probeWindowMs: 10,
    });

    detector.recordInboundEvent(0);
    detector.recordOutboundWrite(1);
    now = 46 * 60 * 1000;

    expect(await detector.check()).toBe(true);
    expect(probe).toHaveBeenCalledWith("org/repo", 123);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("Active probe went unechoed");
  });

  it("alarms immediately if probe throws", async () => {
    let now = 0;
    const notify = vi.fn();
    const probe = vi.fn().mockRejectedValue(new Error("Network Error"));
    const detector = new WebhookSilenceDetector({
      now: () => now,
      thresholdMs: THRESHOLD_MS,
      notify,
      proberTarget: { repo: "org/repo", issueNumber: 123 },
      probe,
      probeWindowMs: 10,
    });

    detector.recordInboundEvent(0);
    detector.recordOutboundWrite(1);
    now = 46 * 60 * 1000;

    expect(await detector.check()).toBe(true);
    expect(probe).toHaveBeenCalledWith("org/repo", 123);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("Active probe failed: Network Error");
  });

  it("skips check during quiet hours", async () => {
    // 22:30 NY time is quiet hours
    let now = Date.parse("2023-01-01T22:30:00-05:00");
    const notify = vi.fn();
    const detector = new WebhookSilenceDetector({
      now: () => now,
      thresholdMs: THRESHOLD_MS,
      notify,
    });

    // Event is way in the past so it should alarm, EXCEPT it's quiet hours
    detector.recordInboundEvent(now - 46 * 60 * 1000);
    detector.recordOutboundWrite(now - 1000);

    expect(await detector.check()).toBe(false);
    expect(notify).not.toHaveBeenCalled();

    // 04:30 NY time is quiet hours
    now = Date.parse("2023-01-02T04:30:00-05:00");
    expect(await detector.check()).toBe(false);

    // 05:45 NY time is NOT quiet hours
    now = Date.parse("2023-01-02T05:45:00-05:00");
    expect(await detector.check()).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
