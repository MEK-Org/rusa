import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import type { DurableEventDelivery } from "../runtime/event-manager.js";
import { configuredRootEventSources, deliverHostAlarm, diskAlertUncovered } from "./start.js";

/** The minimum a loaded config carries; every case below varies only observability. */
const baseConfig = {
  github: { account: "mock-bot" },
  providers: { antigravity: { cliCommand: "agy" } },
  rootActor: { provider: "antigravity", model: "Gemini 3.7 Flash", effort: "high" },
} as unknown as RusaConfig;

const withObservability = (observability: RusaConfig["observability"]): RusaConfig =>
  ({ ...baseConfig, observability }) as RusaConfig;

const delivered: DurableEventDelivery = {
  entries: [
    {
      id: "entry-1",
      actorId: "root",
      source: "system:events",
      payload: { type: "system.disk" },
      deliveredAt: "2026-09-15T00:00:00.000Z",
    },
  ] as unknown as DurableEventDelivery["entries"],
  ownerIds: ["root"],
};
const uncovered: DurableEventDelivery = { entries: [], ownerIds: [] };

describe("configuredRootEventSources and the disk sensor agree", () => {
  it("covers system:events when no observability block is configured at all", () => {
    // The production shape that dropped every alert: sensor on by default, and
    // the subscription only implied when the block was present.
    expect(configuredRootEventSources(baseConfig)).toContain("system:events");
    expect(diskAlertUncovered(baseConfig, configuredRootEventSources(baseConfig))).toBe(false);
  });

  it("covers system:events for an empty observability block", () => {
    const config = withObservability({});
    expect(configuredRootEventSources(config)).toContain("system:events");
    expect(diskAlertUncovered(config, configuredRootEventSources(config))).toBe(false);
  });

  it("covers system:events for a block that only tunes thresholds", () => {
    const config = withObservability({ diskAlert: { thresholdPercent: 10 } });
    expect(configuredRootEventSources(config)).toContain("system:events");
  });

  it("drops the subscription exactly when the operator disables the sensor", () => {
    const config = withObservability({ diskAlert: { enabled: false } });
    expect(configuredRootEventSources(config)).not.toContain("system:events");
    // Nothing produces the events, so nothing is uncovered either.
    expect(diskAlertUncovered(config, configuredRootEventSources(config))).toBe(false);
  });
});

describe("diskAlertUncovered", () => {
  it("is the loud case: an active sensor whose events nobody covers", () => {
    expect(diskAlertUncovered(baseConfig, ["github:dummy-org"])).toBe(true);
  });

  it("accepts an ancestor source as coverage", () => {
    expect(diskAlertUncovered(baseConfig, ["system:events"])).toBe(false);
  });
});

describe("deliverHostAlarm", () => {
  it("leaves a covered alarm to the mesh and sends no chat message", async () => {
    const sent: string[] = [];
    const outcome = await deliverHostAlarm({
      deliver: async () => delivered,
      message: "disk is full",
      sendToErrorChat: (text) => sent.push(text),
    });
    expect(outcome).toBe("delivered");
    expect(sent).toEqual([]);
  });

  it("falls back to errorChat when the delivery resolves zero destinations", async () => {
    const sent: string[] = [];
    const outcome = await deliverHostAlarm({
      deliver: async () => uncovered,
      message: "disk is full",
      sendToErrorChat: (text) => sent.push(text),
    });
    expect(outcome).toBe("errorChat");
    expect(sent).toEqual(["disk is full"]);
  });

  it("reports a drop when there is no errorChat to fall back to", async () => {
    const outcome = await deliverHostAlarm({
      deliver: async () => uncovered,
      message: "disk is full",
      sendToErrorChat: null,
    });
    expect(outcome).toBe("dropped");
  });
});
