import type { QuotaFreshness } from "../quota/coordinator-protocol.js";

export interface QuotaBucketError {
  key: string;
  percentLeft: number;
  timeRemainingPct: number;
  error: number;
  requiredIntervalSeconds?: number;
  stale?: boolean;
}

export interface QuotaThrottleTick {
  intervalSeconds: number;
  expired: boolean;
  capped: boolean;
  buckets: QuotaBucketError[];
  uncappedIntervalSeconds: number;
  freshness?: QuotaFreshness;
}

export interface QuotaThrottleStatus extends QuotaThrottleTick {
  updatedAt: string;
}
