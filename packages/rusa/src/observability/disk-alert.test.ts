import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiskUsageAlert, type DiskUsageAlertDeps } from "./disk-alert.js";

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

  it("fires alert below default 2G threshold when no config is provided", async () => {
    const alert = new DiskUsageAlert(undefined, emit, log, {
      statfs: mockStatfs as unknown as DiskUsageAlertDeps["statfs"],
      now: () => now,
    });
    // 1.5 GB free (below 2 GB)
    mockStatfs.mockResolvedValue({
      bavail: 1.5 * 1024 * 1024,
      blocks: 10 * 1024 * 1024,
      bsize: 1024,
    });
    await alert.check();
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain("1.50 GB");
  });

  it("stays silent above default 2G threshold when no config is provided", async () => {
    const alert = new DiskUsageAlert(undefined, emit, log, {
      statfs: mockStatfs as unknown as DiskUsageAlertDeps["statfs"],
      now: () => now,
    });
    // 2.5 GB free (above 2 GB)
    mockStatfs.mockResolvedValue({
      bavail: 2.5 * 1024 * 1024,
      blocks: 10 * 1024 * 1024,
      bsize: 1024,
    });
    await alert.check();
    expect(events).toHaveLength(0);
  });
});
