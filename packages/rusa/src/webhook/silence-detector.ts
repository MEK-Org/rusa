export const WEBHOOK_SILENCE_THRESHOLD_MS = 45 * 60 * 1000;
export const WEBHOOK_SILENCE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const PROBE_WINDOW_MS = 2 * 60 * 1000;

export interface WebhookSilenceDetectorDeps {
  now?: () => number;
  thresholdMs?: number;
  notify?: (text: string) => void;
  log?: (message: string) => void;
  proberTarget?: { repo: string; issueNumber: number };
  probe?: (repo: string, issueNumber: number) => Promise<void>;
  probeWindowMs?: number;
}

export class WebhookSilenceDetector {
  private readonly now: () => number;
  private readonly thresholdMs: number;
  private readonly notify: ((text: string) => void) | null;
  private readonly log: (message: string) => void;
  private readonly proberTarget?: { repo: string; issueNumber: number };
  private readonly probe?: (repo: string, issueNumber: number) => Promise<void>;
  private readonly probeWindowMs: number;

  private lastInboundEventAt: number;
  private lastOutboundWriteAt: number | null = null;
  private alerted = false;
  private probing = false;

  constructor(deps: WebhookSilenceDetectorDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.thresholdMs = deps.thresholdMs ?? WEBHOOK_SILENCE_THRESHOLD_MS;
    this.notify = deps.notify ?? null;
    this.log = deps.log ?? ((message) => console.warn(message));
    this.proberTarget = deps.proberTarget;
    this.probe = deps.probe;
    this.probeWindowMs = deps.probeWindowMs ?? PROBE_WINDOW_MS;
    this.lastInboundEventAt = this.now();
  }

  recordInboundEvent(at = this.now()): void {
    this.lastInboundEventAt = at;
    this.alerted = false;
  }

  recordOutboundWrite(at = this.now()): void {
    this.lastOutboundWriteAt = at;
  }

  async check(at = this.now()): Promise<boolean> {
    if (this.alerted || this.probing || this.lastOutboundWriteAt == null) return false;
    if (this.lastOutboundWriteAt <= this.lastInboundEventAt) return false;

    // Overnight disable: Operator's quiet hours 10:00pm–5:30am America/New_York
    if (this.isQuietHours(at)) {
      return false;
    }

    const silentMs = at - this.lastInboundEventAt;
    if (silentMs <= this.thresholdMs) return false;

    if (this.proberTarget && this.probe) {
      this.probing = true;
      try {
        this.log(
          `[webhook-silence] Suspicion met. Initiating active probe to ${this.proberTarget.repo}#${this.proberTarget.issueNumber}`
        );
        try {
          await this.probe(this.proberTarget.repo, this.proberTarget.issueNumber);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.fireAlarm(`Active probe failed: ${errMsg}`);
          return true;
        }

        // Wait for echo
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, this.probeWindowMs);
          if (timer.unref) timer.unref();
        });

        if (this.lastInboundEventAt > at) {
          this.log(`[webhook-silence] Probe echoed back successfully. Pipe is healthy.`);
          return false;
        }

        this.fireAlarm(
          this.formatAlert(this.lastInboundEventAt, silentMs) +
            ` Active probe went unechoed for ${Math.round(this.probeWindowMs / 1000)}s.`
        );
        return true;
      } finally {
        this.probing = false;
      }
    }

    this.fireAlarm(this.formatAlert(this.lastInboundEventAt, silentMs));
    return true;
  }

  private isQuietHours(atMs: number): boolean {
    const tzTime = new Date(atMs).toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      hour: "numeric",
      minute: "numeric",
    });
    const parts = tzTime.split(":");
    if (parts.length !== 2) return false;

    let h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (h === 24) h = 0;

    if (h >= 22) return true;
    if (h < 5) return true;
    if (h === 5 && m <= 30) return true;

    return false;
  }

  private fireAlarm(alert: string): void {
    if (this.notify) {
      try {
        this.notify(alert);
      } catch (err) {
        this.log(
          `[webhook-silence] alert send failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else {
      this.log(`[webhook-silence] ${alert}`);
    }
    this.alerted = true;
  }

  private formatAlert(lastInboundAt: number, silentMs: number): string {
    const silentMinutes = Math.floor(silentMs / 60_000);
    return [
      "⚠️ GitHub webhook delivery silence suspected.",
      `Last inbound webhook event: ${new Date(lastInboundAt).toISOString()}.`,
      `Silent for ${silentMinutes} minute(s) while the mesh has made outbound GitHub writes.`,
      "Recovery runbook: Rusa-Org/rusaISSUE_NUM.",
    ].join(" ");
  }
}
