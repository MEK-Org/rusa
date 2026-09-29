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
  observedAt: string;
  lanes: Map<string, PublishedHistoryRecord>;
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
 * window returns and drops out again. A scrape is the observation slot its
 * readings share. The first history seen for a provider is a silent baseline:
 * a restart does not re-raise a gap this process never watched open.
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
      if (scrape.slot === previous.slot) {
        // A scrape the last pass saw may have gained windows since, from a
        // later read in the same slot; none of that is a gap.
        for (const [lane, record] of scrape.lanes) previous.lanes.set(lane, record);
        continue;
      }
      for (const [lane, record] of previous.lanes) {
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
  const bySlot = new Map<number, ScrapeLanes>();
  for (const record of records) {
    const observedMs = Date.parse(record.observedAt);
    if (!Number.isFinite(observedMs)) continue;
    const slot = Math.floor(observedMs / QUOTA_OBSERVATION_SLOT_MS);
    let scrape = bySlot.get(slot);
    if (!scrape) {
      scrape = { slot, observedAt: record.observedAt, lanes: new Map() };
      bySlot.set(slot, scrape);
    }
    if (record.observedAt > scrape.observedAt) scrape.observedAt = record.observedAt;
    scrape.lanes.set(quotaLaneKey(record.scope, record.models ?? [], record.kind), record);
  }
  return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
}
