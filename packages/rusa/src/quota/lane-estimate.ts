import { quotaCycleChanged } from "./quota-cycle.js";

/**
 * How recent a lane's last real reading must be when its window ends for the
 * next window to be estimated (#759): "if at the end of the quota period it has
 * been more than two hours since a reading, only then stop showing a value".
 * A window that ends with an older reading reads unknown rather than guessing
 * across a gap the scrapes cannot explain. The dashboard's warning triangle
 * uses the same span.
 */
export const LANE_ESTIMATE_ROLLOVER_HOLD_MS = 2 * 60 * 60 * 1000;

/** One real reading of one lane (provider or model scope, one window kind). */
export interface LaneReading {
  observedAt: string;
  percentLeft: number;
  resetAtIso: string | null;
}

/** A read-time estimate of a lane's remaining quota. Never persisted. */
export interface LaneEstimate {
  percentLeft: number;
  /** The window the estimate describes; null after a rollover, whose next reset is unread. */
  resetAtIso: string | null;
  /** The last real reading the estimate extends. */
  lastReadingAt: string;
}

/** The identity a lane's readings share across scrapes, from scope, models, and window kind. */
export function quotaLaneKey(scope: "provider" | "model", models: readonly string[], kind: string) {
  return scope === "provider"
    ? `provider:${kind}`
    : `model:${[...models].sort().join(",")}:${kind}`;
}

/**
 * Dead-reckon a lane's remaining quota at `nowMs` from its real readings
 * (#759). The readings of the current window — those after the latest cycle
 * boundary the pacing controller would also see (`quotaCycleChanged`) —
 * establish a consumption pace from the first to the last of them, and the
 * last reading is carried forward at that pace. Once the window has reset, the
 * new window starts full and is drawn down at the same pace until a reading
 * arrives or that window, too, would have ended — provided the last reading was
 * no more than {@link LANE_ESTIMATE_ROLLOVER_HOLD_MS} old when the old window
 * ended. With `rollover: false` the estimate stops at the reset instead.
 *
 * Null when there is nothing honest to extend: fewer than two readings in the
 * window, no known reset to bound it, or a window that ended more than the
 * rollover hold after its last reading.
 */
export function estimateLane(
  readings: readonly LaneReading[],
  windowMs: number,
  nowMs: number,
  { rollover = true }: { rollover?: boolean } = {}
): LaneEstimate | null {
  const ordered = readings
    .filter((reading) => Number.isFinite(Date.parse(reading.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const last = ordered.at(-1);
  if (!last?.resetAtIso) return null;
  const resetMs = Date.parse(last.resetAtIso);
  if (!Number.isFinite(resetMs)) return null;

  let start = ordered.length - 1;
  while (start > 0 && !quotaCycleChanged(ordered[start - 1], ordered[start], windowMs)) start -= 1;
  const first = ordered[start];
  const lastMs = Date.parse(last.observedAt);
  const spanMs = lastMs - Date.parse(first.observedAt);
  if (spanMs <= 0) return null;
  const pacePerMs = Math.max(0, (first.percentLeft - last.percentLeft) / spanMs);

  const clamp = (percent: number) => Math.min(100, Math.max(0, percent));
  if (nowMs < resetMs) {
    return {
      percentLeft: clamp(last.percentLeft - pacePerMs * Math.max(0, nowMs - lastMs)),
      resetAtIso: last.resetAtIso,
      lastReadingAt: last.observedAt,
    };
  }
  if (!rollover || resetMs - lastMs > LANE_ESTIMATE_ROLLOVER_HOLD_MS) return null;
  if (nowMs >= resetMs + windowMs) return null;
  return {
    percentLeft: clamp(100 - pacePerMs * (nowMs - resetMs)),
    resetAtIso: null,
    lastReadingAt: last.observedAt,
  };
}
