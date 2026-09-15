import { statfs } from "node:fs/promises";
import type { DiskAlertConfig, ObservabilityConfig } from "../config/types.js";

/**
 * Free-space floor used when an operator sets neither threshold. A percentage
 * rather than a flat byte count: the previous 2 GB default bought four hours of
 * warning on a 158 GB volume and proportionally less on anything larger (#481).
 * An explicit `thresholdBytes` is still honoured for operators who want one.
 */
export const DEFAULT_DISK_THRESHOLD_PERCENT = 10;
export const DEFAULT_DISK_VOLUME = "/";
export const DEFAULT_DISK_INTERVAL_SECONDS = 600;
export const DEFAULT_DISK_COOLDOWN_SECONDS = 21600;

/** Every knob the sensor actually runs on, defaults already applied. */
export interface EffectiveDiskAlertConfig {
  enabled: boolean;
  volume: string;
  thresholdPercent?: number;
  thresholdBytes?: number;
  intervalSeconds: number;
  cooldownSeconds: number;
}

/**
 * The one predicate that decides whether the host disk sensor runs. The root's
 * `system:events` subscription is derived from this same call, so a running
 * sensor always has a receiver: an absent `observability` block leaves the
 * sensor on, and only an explicit `enabled: false` turns it off (#481).
 */
export function diskAlertActive(config: { observability?: ObservabilityConfig }): boolean {
  return config.observability?.diskAlert?.enabled !== false;
}

/** Resolve the configured knobs into the values a check will really use. */
export function resolveDiskAlertConfig(
  config: DiskAlertConfig | undefined
): EffectiveDiskAlertConfig {
  const thresholdPercent = config?.thresholdPercent;
  const thresholdBytes = config?.thresholdBytes;
  const neitherSet = thresholdPercent === undefined && thresholdBytes === undefined;
  return {
    enabled: config?.enabled !== false,
    volume: config?.volume ?? DEFAULT_DISK_VOLUME,
    thresholdPercent: neitherSet ? DEFAULT_DISK_THRESHOLD_PERCENT : thresholdPercent,
    thresholdBytes,
    intervalSeconds: config?.intervalSeconds ?? DEFAULT_DISK_INTERVAL_SECONDS,
    cooldownSeconds: config?.cooldownSeconds ?? DEFAULT_DISK_COOLDOWN_SECONDS,
  };
}

/** One boot-log line stating exactly what the sensor will do. */
export function describeDiskAlertConfig(effective: EffectiveDiskAlertConfig): string {
  const thresholds: string[] = [];
  if (effective.thresholdPercent !== undefined) {
    thresholds.push(`${effective.thresholdPercent}% free`);
  }
  if (effective.thresholdBytes !== undefined) {
    thresholds.push(`${(effective.thresholdBytes / 1024 / 1024 / 1024).toFixed(2)} GB free`);
  }
  return [
    `volume ${effective.volume}`,
    `threshold ${thresholds.join(" or ")}`,
    `interval ${effective.intervalSeconds}s`,
    `cooldown ${effective.cooldownSeconds}s`,
  ].join(", ");
}

export interface DiskUsageAlertDeps {
  statfs: typeof statfs;
  now: () => number;
}

export interface SystemDiskEvent {
  [key: string]: unknown;
  type: "system.disk";
  priority: "responsive";
  volume: string;
  freeBytes: number;
  freePercent: number;
  thresholdBytes?: number;
  thresholdPercent?: number;
  message: string;
}

export class DiskUsageAlert {
  private lastAlertTime = 0;
  private currentlyOver = false;

  constructor(
    private readonly config: DiskAlertConfig | undefined,
    private readonly emit: (event: SystemDiskEvent) => void | Promise<void>,
    private readonly log: (m: string) => void = console.log,
    private readonly deps: DiskUsageAlertDeps = { statfs, now: Date.now }
  ) {}

  async check(): Promise<void> {
    const effective = resolveDiskAlertConfig(this.config);
    if (!effective.enabled) return;

    const { volume, thresholdPercent, thresholdBytes } = effective;
    const cooldownMs = effective.cooldownSeconds * 1000;

    let stats: { bavail: number; blocks: number; bsize: number };
    try {
      stats = await this.deps.statfs(volume);
    } catch (err) {
      this.log(
        `[disk-alert] Failed to read statfs for volume ${volume}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    const freeBytes = stats.bavail * stats.bsize;
    const totalBytes = stats.blocks * stats.bsize;
    if (totalBytes === 0) return; // avoid NaN
    const freePercent = (freeBytes / totalBytes) * 100;

    const bytesCrossed = thresholdBytes !== undefined && freeBytes <= thresholdBytes;
    const percentCrossed = thresholdPercent !== undefined && freePercent <= thresholdPercent;

    if (bytesCrossed || percentCrossed) {
      if (!this.currentlyOver || this.deps.now() - this.lastAlertTime >= cooldownMs) {
        this.currentlyOver = true;
        this.lastAlertTime = this.deps.now();
        const freeGb = (freeBytes / 1024 / 1024 / 1024).toFixed(2);

        const thresholdParts: string[] = [];
        if (thresholdPercent !== undefined) thresholdParts.push(`${thresholdPercent}%`);
        if (thresholdBytes !== undefined) {
          thresholdParts.push(`${(thresholdBytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
        }
        const thresholdStr = thresholdParts.join(" / ");

        const message = `⚠️ **Disk Usage Alert** ⚠️\nVolume \`${volume}\` is running low on space.\n- Free Space: ${freeGb} GB (${freePercent.toFixed(1)}%)\n- Threshold: ${thresholdStr}`;
        await this.emit({
          type: "system.disk",
          priority: "responsive",
          volume,
          freeBytes,
          freePercent,
          thresholdBytes,
          thresholdPercent,
          message,
        });
      }
    } else {
      if (this.currentlyOver) {
        const freeGb = (freeBytes / 1024 / 1024 / 1024).toFixed(2);
        this.log(
          `[disk-alert] Volume ${volume} recovered. Free space is now ${freeGb} GB (${freePercent.toFixed(1)}%).`
        );
      }
      this.currentlyOver = false;
    }
  }
}
