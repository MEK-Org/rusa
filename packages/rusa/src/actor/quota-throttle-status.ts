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
}

export interface QuotaThrottleStatus extends QuotaThrottleTick {
  updatedAt: string;
}
