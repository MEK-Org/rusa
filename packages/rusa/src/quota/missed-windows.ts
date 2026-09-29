import type { PublishedHistoryRecord } from "./coordinator-protocol.js";
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
}

interface ScrapeLanes {
  slot: number;
  /** The newest scrape stamp in the slot, and the windows that scrape carried. */
  observedAt: string;
  observedMs: number;
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
 * newest one dropped. A scrape that published no window at all leaves no row,
 * and so no gap to find here.
 */
export class MissedQuotaWindowDetector {
  private readonly lastScrape = new Map<string, ScrapeLanes>();

  observe(provider: string, records: readonly PublishedHistoryRecord[]): MissedQuotaWindow[] {
    const scrapes = groupByScrape(records);
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
        });
      }
      previous = scrape;
    }
    this.lastScrape.set(provider, previous);
    return missed;
  }
}

function groupByScrape(records: readonly PublishedHistoryRecord[]): ScrapeLanes[] {
  const bySlot = new Map<number, PublishedHistoryRecord[]>();
  for (const record of records) {
    const observedMs = Date.parse(record.observedAt);
    if (!Number.isFinite(observedMs)) continue;
    const slot = Math.floor(observedMs / QUOTA_OBSERVATION_SLOT_MS);
    const rows = bySlot.get(slot);
    if (rows) rows.push(record);
    else bySlot.set(slot, [record]);
  }
  return [...bySlot]
    .map(([slot, rows]) => {
      const newest = rows.reduce((a, b) =>
        Date.parse(b.observedAt) > Date.parse(a.observedAt) ? b : a
      );
      const observedMs = Date.parse(newest.observedAt);
      const lanes = new Map<string, PublishedHistoryRecord>();
      const dropped = new Map<string, PublishedHistoryRecord>();
      for (const record of rows) {
        const lane = quotaLaneKey(record.scope, record.models ?? [], record.kind);
        if (Date.parse(record.observedAt) === observedMs) lanes.set(lane, record);
        else dropped.set(lane, record);
      }
      for (const lane of lanes.keys()) dropped.delete(lane);
      return { slot, observedAt: newest.observedAt, observedMs, lanes, dropped };
    })
    .sort((a, b) => a.slot - b.slot);
}
