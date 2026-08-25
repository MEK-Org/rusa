import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Slow-flap detector (ISSUE_NUM, elder fix #6). systemd's `StartLimitBurst=5` /
 * `StartLimitIntervalSec=300` only trips on a FAST crash-loop (5 restarts inside
 * 5 minutes); a service that boots, runs a while, then dies every ~61s flaps
 * forever WITHOUT ever tripping that window — so it never gives up and never
 * alerts. This adds a longer-window check: the mesh records each successful boot
 * and, if too many land inside the window (e.g. ≥5 in the last hour), raises an
 * alert regardless of spacing. Complementary to `StartLimit`, not a replacement.
 *
 * Pure record/prune/detect functions + a thin file-backed wrapper, so the policy
 * is unit-tested without real time or disk.
 */

/** Append `now`, then drop any timestamp older than the window. */
export function recordRestart(prev: number[], now: number, windowMs: number): number[] {
  const cutoff = now - windowMs;
  return [...prev, now].filter((t) => t >= cutoff).sort((a, b) => a - b);
}

/** True once the count within the window reaches `threshold`. */
export function isFlapping(
  restarts: number[],
  now: number,
  windowMs: number,
  threshold: number
): boolean {
  const cutoff = now - windowMs;
  return restarts.filter((t) => t >= cutoff).length >= threshold;
}

export interface FlapPolicy {
  windowMs: number;
  threshold: number;
}

export interface FlapCheck {
  flapping: boolean;
  /** Restart count within the window, including this boot. */
  count: number;
  windowMs: number;
  threshold: number;
}

function loadLog(path: string): number[] {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { restarts?: unknown };
    return Array.isArray(data.restarts)
      ? data.restarts.filter((t): t is number => typeof t === "number")
      : [];
  } catch {
    return [];
  }
}

/**
 * Record this boot in the persisted restart log and report whether the mesh is
 * flapping. Best-effort on I/O: a read/write failure never blocks boot (returns a
 * not-flapping result so a broken counter can't itself wedge startup).
 */
export function recordRestartAndCheckFlap(
  path: string,
  now: number,
  policy: FlapPolicy
): FlapCheck {
  const updated = recordRestart(loadLog(path), now, policy.windowMs);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ restarts: updated }), "utf8");
  } catch {
    /* best-effort: a persistence failure must not block startup */
  }
  return {
    flapping: isFlapping(updated, now, policy.windowMs, policy.threshold),
    count: updated.length,
    windowMs: policy.windowMs,
    threshold: policy.threshold,
  };
}
