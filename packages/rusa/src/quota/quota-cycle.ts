/**
 * A rise in remaining quota above this many points is read as a refill rather
 * than a measurement. Inside one window `percentLeft` only falls — consumption
 * is the only thing that moves it — so a genuine rise means the budget was
 * replenished under us.
 *
 * This is a noise floor, not a sensitivity knob. The reading is parsed from a
 * rendered percentage, so display rounding can move it by a point without any
 * underlying change; two points clears that with margin. Sensitivity is not the
 * binding constraint in the other direction, because a real refill moves tens
 * of points at once — a weekly window returns to ~100 from single digits.
 */
export const QUOTA_REFILL_EPSILON_POINTS = 2;

/**
 * The store keeps at most one observation per lane per slot of this width, so
 * a slot is the unit in which a scrape's windows land together. Readers that
 * ask which windows one scrape carried (#759) group by the same slot.
 */
export const QUOTA_OBSERVATION_SLOT_MS = 5 * 60 * 1000;

/** One reading of a window, as far as its cycle identity goes. */
export interface QuotaCycleReading {
  percentLeft: number;
  resetAtIso: string | null;
}

/**
 * Whether `next` belongs to a different window cycle than `previous`, the
 * reading before it on the same lane. There are two independent signals, and
 * either is sufficient:
 *
 *  1. the reset instant moved — we are budgeting against a different window;
 *  2. remaining quota rose — the budget refilled underneath us.
 *
 * (2) is not implied by (1). A refill whose `reset_at` did not move with it,
 * or one where the previous reading carried no `reset_at` at all, leaves (1)
 * false.
 *
 * The pacing controller uses this to decide when its memory is no longer
 * comparable, and the dashboard's read-time estimate (#759) uses it to decide
 * which readings establish the current window's consumption pace, so the two
 * never disagree about where a window begins.
 */
export function quotaCycleChanged(
  previous: QuotaCycleReading | null | undefined,
  next: QuotaCycleReading,
  windowMs: number
): boolean {
  if (!previous) return false;
  const nextResetMs = next.resetAtIso ? Date.parse(next.resetAtIso) : Number.NaN;
  const resetMoved =
    previous.resetAtIso != null &&
    Math.abs(Date.parse(previous.resetAtIso) - nextResetMs) >
      Math.min(60 * 60 * 1000, windowMs * 0.05);
  const quotaRefilled = next.percentLeft - previous.percentLeft > QUOTA_REFILL_EPSILON_POINTS;
  return resetMoved || quotaRefilled;
}
