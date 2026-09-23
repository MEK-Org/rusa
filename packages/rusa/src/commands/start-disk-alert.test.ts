import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { buildE2EConfig } from "../e2e/provision.js";
import type { Logger } from "../observability/logger.js";
import type { DurableEventDelivery } from "../runtime/event-manager.js";
import {
  configuredRootEventSources,
  deliverHostAlarm,
  diskAlertUncovered,
  hostAlarmProducerActive,
} from "./start.js";

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
  it("keeps an explicitly configured E2E Slack source while dropping system:events", () => {
    // The interference #574 reports was observed in the Slack integration e2e:
    // the root owned `system:events` only because the sensor defaults on, and an
    // unrelated host `system.disk` alert woke it mid-run. Slack is the branch
    // that shows the fix end to end, because Slack raises no host alarms of its
    // own — the explicitly requested source survives and the host one is gone.
    // There is deliberately no chat twin of this case: chat configures a second
    // `system:events` producer (#578's lapse alert), so a generated chat root
    // keeps the subscription and cannot show the drop. The rule that it must
    // keep it is already pinned below, on a config built by hand so the failure
    // localizes to start.ts rather than to the E2E generator.
    const config = buildE2EConfig({
      scratchPath: "/tmp/rusa-e2e-scratch",
      slack: { appTokenPath: "/dev/null", botTokenPath: "/dev/null" },
    });

    expect(config.observability?.diskAlert).toEqual({ enabled: false });
    const sources = configuredRootEventSources(config);
    expect(sources).toContain("slack:channels");
    expect(sources).not.toContain("system:events");
  });

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
    expect(hostAlarmProducerActive(config)).toBe(false);
    // Nothing produces the events, so nothing is uncovered either.
    expect(diskAlertUncovered(config, configuredRootEventSources(config))).toBe(false);
  });

  it("keeps system:events covered for the chat lapse alert when the disk sensor is off", () => {
    // Chat configured, disk alerts explicitly disabled: the subscription keeper
    // still raises host alarms into system:events, so root must still own it —
    // otherwise the lapse alert reproduces the uncovered-producer shape of #481.
    const config = {
      ...withObservability({ diskAlert: { enabled: false } }),
      chat: { gchatConfigDir: "/tmp/gchat", projectId: "p" },
    } as unknown as RusaConfig;
    expect(hostAlarmProducerActive(config)).toBe(true);
    expect(configuredRootEventSources(config)).toEqual(
      expect.arrayContaining(["gchat:spaces", "system:events"])
    );
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

  it("falls back to errorChat and logs when mesh delivery rejects", async () => {
    const sent: string[] = [];
    const logged: Array<{ event: string; fields?: unknown }> = [];
    const mockLog = {
      warn: (event: string, fields?: unknown) => logged.push({ event, fields }),
    } as unknown as Logger;
    const deliveryError = new Error("disk full: SQLITE_FULL");

    const outcome = await deliverHostAlarm({
      deliver: async () => {
        throw deliveryError;
      },
      message: "disk is full",
      sendToErrorChat: (text) => sent.push(text),
      log: mockLog,
    });
    expect(outcome).toBe("errorChat");
    expect(sent).toEqual(["disk is full"]);
    expect(logged).toEqual([
      {
        event: "disk_alert_delivery_failed",
        fields: { err: deliveryError },
      },
    ]);
  });

  it("reports a drop when mesh delivery rejects and there is no errorChat", async () => {
    const logged: Array<{ event: string; fields?: unknown }> = [];
    const mockLog = {
      warn: (event: string, fields?: unknown) => logged.push({ event, fields }),
    } as unknown as Logger;
    const deliveryError = new Error("disk full: SQLITE_FULL");

    const outcome = await deliverHostAlarm({
      deliver: async () => {
        throw deliveryError;
      },
      message: "disk is full",
      sendToErrorChat: null,
      log: mockLog,
    });
    expect(outcome).toBe("dropped");
    expect(logged).toEqual([
      {
        event: "disk_alert_delivery_failed",
        fields: { err: deliveryError },
      },
    ]);
  });

  it("uses the alarm name when another host alarm falls back to errorChat", async () => {
    const logged: Array<{ event: string; fields?: unknown }> = [];
    const log = {
      warn: (event: string, fields?: unknown) => logged.push({ event, fields }),
    } as unknown as Logger;
    const error = new Error("delivery unavailable");

    const outcome = await deliverHostAlarm({
      deliver: async () => {
        throw error;
      },
      message: "subscription lapsed",
      sendToErrorChat: () => {},
      log,
      alarmName: "chat_subscription_lapse",
    });

    expect(outcome).toBe("errorChat");
    expect(logged).toEqual([
      { event: "chat_subscription_lapse_delivery_failed", fields: { err: error } },
    ]);
  });
});
