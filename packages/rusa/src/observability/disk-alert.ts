import { statfs } from "node:fs/promises";
import type { DiskAlertConfig } from "../config/types.js";

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
    if (this.config?.enabled === false) return;

    const volume = this.config?.volume ?? "/";
    const thresholdPercent = this.config?.thresholdPercent;
    let thresholdBytes = this.config?.thresholdBytes;

    if (thresholdPercent === undefined && thresholdBytes === undefined) {
      thresholdBytes = 2 * 1024 * 1024 * 1024;
    }

    const cooldownMs = (this.config?.cooldownSeconds ?? 21600) * 1000;

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

        let thresholdStr = "";
        if (thresholdPercent !== undefined) {
          thresholdStr += `${thresholdPercent}%`;
        }
        if (thresholdBytes !== undefined) {
          if (thresholdStr) thresholdStr += " / ";
          thresholdStr += `${(thresholdBytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
        }

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
