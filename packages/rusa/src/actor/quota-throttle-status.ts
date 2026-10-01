import type { QuotaFreshness } from "../quota/coordinator-protocol.js";

export interface QuotaBucketError {
  key: string;
  percentLeft: number;
  timeRemainingPct: number;
  error: number;
  requiredIntervalSeconds?: number;
  stale?: boolean;
}

export interface QuotaThrottleModelLaneStatus {
  models: string[];
  intervalSeconds: number;
  uncappedIntervalSeconds: number;
  expired: boolean;
  capped: boolean;
  buckets: QuotaBucketError[];
  freshness?: QuotaFreshness;
  updatedAt: string;
}

export interface QuotaThrottleTick {
  intervalSeconds: number;
  expired: boolean;
  capped: boolean;
  buckets: QuotaBucketError[];
  uncappedIntervalSeconds: number;
  freshness?: QuotaFreshness;
  modelLanes?: QuotaThrottleModelLaneStatus[];
}

export interface QuotaThrottleStatus extends QuotaThrottleTick {
  updatedAt: string;
}
