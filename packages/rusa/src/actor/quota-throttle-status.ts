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
  held: boolean;
  expired: boolean;
  capped: boolean;
  learning: boolean;
  buckets: QuotaBucketError[];
  uncappedIntervalSeconds: number;
}

export interface QuotaThrottleStatus extends QuotaThrottleTick {
  updatedAt: string;
}
