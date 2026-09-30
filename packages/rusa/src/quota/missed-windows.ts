import type { PublishedHistoryRecord, PublishedScrapeOutcome } from "./coordinator-protocol.js";
import { quotaLaneKey } from "./lane-estimate.js";
import { QUOTA_OBSERVATION_SLOT_MS } from "./quota-cycle.js";

/** A window one scrape carried and the next scrape did not. */
export interface MissedQuotaWindow {
  provider: string;
  lane: string;
  label: string;
  /** The last reading the window had before the scrape that dropped it. */
  lastReadingAt: string;
  /** When the scrape that dropped it was observed. */
  missedAt: string;
  /**
   * Whether that scrape's output threw while parsing, rather than parsing
   * without the window. A parser that gave up and recorded an `unknown`
   * snapshot counts as parsed with no windows, so its alarm reads as the
   * window no longer showing.
   */
  scrapeFailed: boolean;
}

interface ScrapeLanes {
  slot: number;
  /** The newest scrape stamp in the slot, and the windows that scrape carried. */
  observedAt: string;
  observedMs: number;
  failed: boolean;
  lanes: Map<string, PublishedHistoryRecord>;
  /** Windows an earlier scrape in the same slot carried and its newest scrape did not. */
  dropped: Map<string, PublishedHistoryRecord>;
}

/**
 * Finds quota windows that drop out of a provider's scrapes (#759), so root
 * hears about each gap once. The dashboard keeps drawing such a lane from its
 * dead-reckoned estimate, which hides the missing reading from anyone looking
 * at the ring; this is what says out loud that the scrape stopped seeing it.
 *
 * Fed the published history after every refresh, it walks each scrape newer
 * than the last one it saw and compares it with the scrape before. A window
 * present in one and absent in the next is reported, and the absence is then
 * the baseline, so later scrapes that still lack it report nothing until the
 * window returns and drops out again. The first history seen for a provider is
 * a silent baseline: a restart does not re-raise a gap this process never
 * watched open.
 *
 * A scrape is its `observedAt` stamp: the store writes every row of one
 * snapshot with that one stamp, and keeps one row per window per observation
 * slot, the later scrape overwriting. So a slot's rows stamped before its
 * newest stamp are windows an earlier scrape in that slot carried and the
 * newest one dropped. A scrape that parsed to no window, or failed to parse,
 * leaves no row; the scrape outcomes carry its stamp, so it is a scrape with no
 * windows and drops every window the scrape before it had.
 */
export class MissedQuotaWindowDetector {
  private readonly lastScrape = new Map<string, ScrapeLanes>();

  observe(
    provider: string,
    records: readonly PublishedHistoryRecord[],
    scrapeOutcomes: readonly PublishedScrapeOutcome[] = []
  ): MissedQuotaWindow[] {
    const scrapes = groupByScrape(records, scrapeOutcomes);
    if (scrapes.length === 0) return [];
    let previous = this.lastScrape.get(provider);
    const missed: MissedQuotaWindow[] = [];
    if (!previous) {
      this.lastScrape.set(provider, scrapes[scrapes.length - 1]);
      return missed;
    }
    for (const scrape of scrapes) {
      if (scrape.slot < previous.slot) continue;
      if (scrape.slot === previous.slot && scrape.observedMs <= previous.observedMs) {
        // The scrape the last pass saw; any rows it has gained are no gap.
        for (const [lane, record] of scrape.lanes) previous.lanes.set(lane, record);
        continue;
      }
      const carried = new Map(previous.lanes);
      for (const [lane, record] of scrape.dropped) {
        if (Date.parse(record.observedAt) > previous.observedMs) carried.set(lane, record);
      }
      for (const [lane, record] of carried) {
        if (scrape.lanes.has(lane)) continue;
        missed.push({
          provider,
          lane,
          label: record.label,
          lastReadingAt: record.observedAt,
          missedAt: scrape.observedAt,
          scrapeFailed: scrape.failed,
        });
      }
      previous = scrape;
    }
    this.lastScrape.set(provider, previous);
    return missed;
  }
}

function groupByScrape(
  records: readonly PublishedHistoryRecord[],
  scrapeOutcomes: readonly PublishedScrapeOutcome[]
): ScrapeLanes[] {
  const slotOf = (ms: number) => Math.floor(ms / QUOTA_OBSERVATION_SLOT_MS);
  const bySlot = new Map<number, PublishedHistoryRecord[]>();
  for (const record of records) {
    const observedMs = Date.parse(record.observedAt);
    if (!Number.isFinite(observedMs)) continue;
    const slot = slotOf(observedMs);
    const rows = bySlot.get(slot);
    if (rows) rows.push(record);
    else bySlot.set(slot, [record]);
  }
  // The newest finished scrape in each slot, whether or not it wrote a row.
  const newestOutcome = new Map<number, { observedAt: string; ms: number; failed: boolean }>();
  for (const scrape of scrapeOutcomes) {
    const ms = Date.parse(scrape.observedAt);
    if (!Number.isFinite(ms)) continue;
    const slot = slotOf(ms);
    const current = newestOutcome.get(slot);
    if (current && current.ms > ms) continue;
    newestOutcome.set(slot, {
      observedAt: scrape.observedAt,
      ms,
      failed: scrape.outcome === "failed",
    });
    if (!bySlot.has(slot)) bySlot.set(slot, []);
  }
  return [...bySlot]
    .map(([slot, rows]) => {
      let observedAt = "";
      let observedMs = Number.NEGATIVE_INFINITY;
      for (const record of rows) {
        const ms = Date.parse(record.observedAt);
        if (ms > observedMs) {
          observedMs = ms;
          observedAt = record.observedAt;
        }
      }
      const outcome = newestOutcome.get(slot);
      let failed = false;
      if (outcome && outcome.ms >= observedMs) {
        observedMs = outcome.ms;
        observedAt = outcome.observedAt;
        failed = outcome.failed;
      }
      const lanes = new Map<string, PublishedHistoryRecord>();
      const dropped = new Map<string, PublishedHistoryRecord>();
      for (const record of rows) {
        const lane = quotaLaneKey(record.scope, record.models ?? [], record.kind);
        if (Date.parse(record.observedAt) === observedMs) lanes.set(lane, record);
        else dropped.set(lane, record);
      }
      for (const lane of lanes.keys()) dropped.delete(lane);
      return { slot, observedAt, observedMs, failed, lanes, dropped };
    })
    .sort((a, b) => a.slot - b.slot);
}
