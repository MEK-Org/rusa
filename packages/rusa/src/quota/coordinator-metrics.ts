import type { Logger } from "../observability/logger.js";

/**
 * The quota coordinator's metric surface, carried on the structured logger.
 *
 * There is no metrics backend in this repository, and inventing one to serve
 * ten series would be the larger change. What the operations section of the
 * coordinator design actually asks for is that these ten series exist *with
 * conventions* rather than as ad-hoc prose lines, so they are emitted as
 * ordinary log records: one stable event name, `metric`/`type`/`value`, and the
 * labels the series is defined with. That makes a series selectable by field
 * from the journal — `journalctl --user -u rusa-quota-coordinator -o cat | jq
 * 'select(.metric == "quota_service_scrapes_total")'` — and lets an exporter be
 * added later reading the same records, without a second emission path having
 * to be migrated first.
 *
 * A counter record carries the increment in `value`, not a running total: the
 * record stream is the series, so a reader sums and a restart is visible as the
 * gap it is rather than as a counter that silently resets to zero.
 */
export const QUOTA_METRIC_EVENT = "quota_metric";

/** Metric kinds, matching the type column of the design's metric table. */
export type QuotaMetricType = "counter" | "histogram" | "gauge";

/** Label sets are low-cardinality by construction — provider, path, outcome. */
export type QuotaMetricLabels = Record<string, string | number | boolean | null>;

/**
 * Service-side series. The two client series are deliberately absent: they are
 * emitted by the instance, because a service cannot count the clients it cannot
 * see and a service-side "degraded clients" gauge would read zero in exactly
 * the partial failure that matters.
 */
export const QUOTA_SERVICE_METRICS = {
  scrapesTotal: "quota_service_scrapes_total",
  scrapeSeconds: "quota_service_scrape_seconds",
  parsesTotal: "quota_service_parses_total",
  observationsTotal: "quota_service_observations_total",
  controllerStepsTotal: "quota_service_controller_steps_total",
  publishedIntervalSeconds: "quota_service_published_interval_seconds",
  snapshotAgeSeconds: "quota_service_snapshot_age_seconds",
  readsTotal: "quota_service_reads_total",
} as const;

/** Instance-side series. Emitted by the client, never by the service. */
export const QUOTA_CLIENT_METRICS = {
  serviceConnected: "quota_client_service_connected",
  appliedIntervalSeconds: "quota_client_applied_interval_seconds",
} as const;

/** What a probe attempt did, as the `outcome` label of a scrape or parse. */
export type QuotaMetricOutcome = "success" | "failure";

/** What storing one observation did, as the `result` label. */
export type QuotaObservationResult = "recorded" | "superseded" | "rejected";

/**
 * The emitter domain code depends on. A caller with nothing to emit to passes
 * {@link nullQuotaMetrics}, so no site has to branch on whether metrics exist.
 */
export interface QuotaMetrics {
  counter(metric: string, labels?: QuotaMetricLabels, delta?: number): void;
  histogram(metric: string, value: number, labels?: QuotaMetricLabels): void;
  gauge(metric: string, value: number, labels?: QuotaMetricLabels): void;
}

/** A metrics sink that discards everything. */
export const nullQuotaMetrics: QuotaMetrics = {
  counter: () => {},
  histogram: () => {},
  gauge: () => {},
};

/**
 * Build the logger-backed emitter. Records go out at `debug`: a metric sample
 * is not a lifecycle transition, and at the five-minute service cadence a
 * default-level stream of them would bury the `info` records an operator reads
 * to see what the coordinator did. Alerting reads the record stream with
 * `RUSA_LOG_LEVEL=debug`, which the installed unit sets for exactly this
 * reason.
 */
export function createQuotaMetrics(logger: Logger): QuotaMetrics {
  const emit = (
    metric: string,
    type: QuotaMetricType,
    value: number,
    labels?: QuotaMetricLabels
  ): void => {
    if (!Number.isFinite(value)) return;
    logger.debug(QUOTA_METRIC_EVENT, { metric, type, value, ...labels });
  };
  return {
    counter: (metric, labels, delta = 1) => emit(metric, "counter", delta, labels),
    histogram: (metric, value, labels) => emit(metric, "histogram", value, labels),
    gauge: (metric, value, labels) => emit(metric, "gauge", value, labels),
  };
}
