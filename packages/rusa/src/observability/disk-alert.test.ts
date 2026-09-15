import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DiskUsageAlert,
  type DiskUsageAlertDeps,
  describeDiskAlertConfig,
  diskAlertActive,
  resolveDiskAlertConfig,
} from "./disk-alert.js";

describe("DiskUsageAlert", () => {
  let events: Parameters<ConstructorParameters<typeof DiskUsageAlert>[1]>[0][];
  let now: number;
  let mockStatfs: ReturnType<typeof vi.fn>;
  const emit = (event: Parameters<ConstructorParameters<typeof DiskUsageAlert>[1]>[0]) => {
    events.push(event);
  };
  const log = vi.fn();

  beforeEach(() => {
    events = [];
    now = 1000000;
    mockStatfs = vi.fn();
    log.mockClear();
  });

  it("does nothing if disabled", async () => {
    const alert = new DiskUsageAlert({ enabled: false }, emit, log, {
      statfs: mockStatfs as unknown as DiskUsageAlertDeps["statfs"],
      now: () => now,
    });
    await alert.check();
    expect(mockStatfs).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("fires alert when crossing threshold percent", async () => {
    const alert = new DiskUsageAlert({ enabled: true, thresholdPercent: 10 }, emit, log, {
      statfs: mockStatfs as unknown as DiskUsageAlertDeps["statfs"],
      now: () => now,
    });
    // 5% free
    mockStatfs.mockResolvedValue({ bavail: 5, blocks: 100, bsize: 1024 });
    await alert.check();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "system.disk",
      priority: "responsive",
      freePercent: 5,
      thresholdPercent: 10,
      volume: "/",
    });
    expect(events[0]?.message).toContain("5.0%");
  });

  it("does not fire when above threshold", async () => {
    const alert = new DiskUsageAlert({ enabled: true, thresholdPercent: 10 }, emit, log, {
      statfs: mockStatfs as unknown as DiskUsageAlertDeps["statfs"],
      now: () => now,
    });
    // 15% free
    mockStatfs.mockResolvedValue({ bavail: 15, blocks: 100, bsize: 1024 });
    await alert.check();
    expect(events).toHaveLength(0);
  });

  it("debounces repeated calls until cooldown", async () => {
    const alert = new DiskUsageAlert(
      { enabled: true, thresholdPercent: 10, cooldownSeconds: 3600 },
      emit,
      log,
      { statfs: mockStatfs as unknown as DiskUsageAlertDeps["statfs"], now: () => now }
    );
    // 5% free
    mockStatfs.mockResolvedValue({ bavail: 5, blocks: 100, bsize: 1024 });

    // First call fires
    await alert.check();
    expect(events).toHaveLength(1);

    // Second call immediately does not fire
    now += 1000;
    await alert.check();
    expect(events).toHaveLength(1);

    // Call after cooldown fires again
    now += 3600 * 1000 + 100;
    await alert.check();
    expect(events).toHaveLength(2);
  });

  it("recovers and can fire again immediately if crossed", async () => {
    const alert = new DiskUsageAlert({ enabled: true, thresholdPercent: 10 }, emit, log, {
      statfs: mockStatfs as unknown as DiskUsageAlertDeps["statfs"],
      now: () => now,
    });
    // 5% free
    mockStatfs.mockResolvedValue({ bavail: 5, blocks: 100, bsize: 1024 });
    await alert.check();
    expect(events).toHaveLength(1);

    // 15% free (recovery)
    mockStatfs.mockResolvedValue({ bavail: 15, blocks: 100, bsize: 1024 });
    await alert.check();
    expect(events).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("recovered"));

    // 5% free again (should fire immediately without waiting for cooldown)
    mockStatfs.mockResolvedValue({ bavail: 5, blocks: 100, bsize: 1024 });
    await alert.check();
    expect(events).toHaveLength(2);
  });

  it("fires below the default 10% free threshold when no config is provided", async () => {
    const alert = new DiskUsageAlert(undefined, emit, log, {
      statfs: mockStatfs as unknown as DiskUsageAlertDeps["statfs"],
      now: () => now,
    });
    // 8 GB free of 100 GB: comfortably above the old flat 2 GB default, and the
    // shape of the warning a large volume never used to get.
    mockStatfs.mockResolvedValue({
      bavail: 8 * 1024 * 1024,
      blocks: 100 * 1024 * 1024,
      bsize: 1024,
    });
    await alert.check();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ thresholdPercent: 10, thresholdBytes: undefined });
    expect(events[0]?.message).toContain("8.00 GB");
    expect(events[0]?.message).toContain("Threshold: 10%");
  });

  it("stays silent above the default 10% free threshold when no config is provided", async () => {
    const alert = new DiskUsageAlert(undefined, emit, log, {
      statfs: mockStatfs as unknown as DiskUsageAlertDeps["statfs"],
      now: () => now,
    });
    // 12 GB free of 100 GB.
    mockStatfs.mockResolvedValue({
      bavail: 12 * 1024 * 1024,
      blocks: 100 * 1024 * 1024,
      bsize: 1024,
    });
    await alert.check();
    expect(events).toHaveLength(0);
  });

  it("honours an explicit absolute byte threshold instead of the percentage default", async () => {
    const alert = new DiskUsageAlert({ thresholdBytes: 2 * 1024 * 1024 * 1024 }, emit, log, {
      statfs: mockStatfs as unknown as DiskUsageAlertDeps["statfs"],
      now: () => now,
    });
    // 8 GB free of 100 GB: under the 10% default, above the operator's 2 GB floor.
    mockStatfs.mockResolvedValue({
      bavail: 8 * 1024 * 1024,
      blocks: 100 * 1024 * 1024,
      bsize: 1024,
    });
    await alert.check();
    expect(events).toHaveLength(0);

    // 1.5 GB free: the absolute floor is what fires.
    mockStatfs.mockResolvedValue({
      bavail: 1.5 * 1024 * 1024,
      blocks: 100 * 1024 * 1024,
      bsize: 1024,
    });
    await alert.check();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ thresholdPercent: undefined, thresholdBytes: 2147483648 });
    expect(events[0]?.message).toContain("Threshold: 2.00 GB");
  });
});

describe("resolveDiskAlertConfig", () => {
  it("defaults an absent block to an active 10%-free sensor", () => {
    expect(resolveDiskAlertConfig(undefined)).toEqual({
      enabled: true,
      volume: "/",
      thresholdPercent: 10,
      thresholdBytes: undefined,
      intervalSeconds: 600,
      cooldownSeconds: 21600,
    });
  });

  it("leaves the percentage default out when an absolute threshold is configured", () => {
    expect(resolveDiskAlertConfig({ thresholdBytes: 1024 })).toMatchObject({
      thresholdPercent: undefined,
      thresholdBytes: 1024,
    });
  });

  it("keeps both thresholds when an operator sets both", () => {
    expect(resolveDiskAlertConfig({ thresholdPercent: 5, thresholdBytes: 1024 })).toMatchObject({
      thresholdPercent: 5,
      thresholdBytes: 1024,
    });
  });
});

describe("describeDiskAlertConfig", () => {
  it("states the effective settings a boot log should carry", () => {
    expect(describeDiskAlertConfig(resolveDiskAlertConfig(undefined))).toBe(
      "volume /, threshold 10% free, interval 600s, cooldown 21600s"
    );
  });

  it("names both thresholds when both are configured", () => {
    expect(
      describeDiskAlertConfig(
        resolveDiskAlertConfig({ thresholdPercent: 5, thresholdBytes: 2 * 1024 * 1024 * 1024 })
      )
    ).toContain("threshold 5% free or 2.00 GB free");
  });
});

describe("diskAlertActive", () => {
  it("runs the sensor when no observability block is configured at all", () => {
    expect(diskAlertActive({})).toBe(true);
    expect(diskAlertActive({ observability: {} })).toBe(true);
    expect(diskAlertActive({ observability: { diskAlert: {} } })).toBe(true);
  });

  it("stays off only when an operator disables it explicitly", () => {
    expect(diskAlertActive({ observability: { diskAlert: { enabled: false } } })).toBe(false);
    expect(diskAlertActive({ observability: { diskAlert: { enabled: true } } })).toBe(true);
  });
});
