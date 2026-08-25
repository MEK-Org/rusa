import type { CaptureBounds } from "./artifact-provenance.js";
import type { FileSnapshot } from "./blind-package.js";

/**
 * Durable per-step capture for the A/B driver (an issue, Concern 1). The driver
 * used to read each arm's FINAL artifact from the LIVE worker workspace only at the
 * very end of the run. A teardown that races collection — the stall watchdog firing,
 * a cancel, a crash — wipes those workspaces, so collection saw empty `files` and a
 * `"[Task cancelled by user]"` summary: the run became unjudgeable despite valid
 * metrics (that is exactly what happened on the first real run, run-hgdIwu).
 *
 * The fix: the driver snapshots each arm's workdir into its own durable output dir
 * AFTER EVERY scenario step, and folds successive captures so the last GOOD artifact
 * survives a later empty/cancelled step. This module is the pure fold — unit-tested
 * against synthetic captures with no filesystem — so the durability guarantee is
 * verifiable without provisioning an instance. (Bonus: the per-step snapshots are the
 * mid-scenario checkpoints we wanted anyway for the second aging axis.)
 */

/**
 * A scan of the vendor directories the file snapshot deliberately skips — package paths
 * only, plus whether the scan actually saw them.
 *
 * `complete: false` means at least one vendor directory existed and could not be listed, so
 * `paths` is a LOWER BOUND. It is a separate bit because a missing vendor directory and an
 * unreadable one produce the same empty array, and callers use the array as a measured
 * dependency set — which turns a failed scan into "no dependencies".
 */
export interface VendorScan {
  /** Tree-relative package paths, e.g. `node_modules/express`, `node_modules/@scope/pkg`. */
  paths: string[];
  /** False when a vendor directory (or a scope inside one) existed but could not be listed. */
  complete: boolean;
}

/** One arm's captured state at the end of one scenario step. */
export interface StepCapture {
  /** Which scenario step produced the artifact we're keeping (provenance). */
  stepId: string;
  /** The arm's self-report for the kept artifact — its last GOOD run_end body. */
  summary: string;
  /** Bounded snapshot of the arm's workdir at the kept step. */
  files: FileSnapshot[];
  /**
   * What the walk that produced {@link files} left out. Folded in lockstep with `files`,
   * never independently: coverage that describes a different capture than the one being
   * judged is worse than no coverage at all.
   */
  bounds: CaptureBounds;
  /**
   * The vendor directories as they stood at the kept step. Folded in lockstep with `files`
   * for the same reason `bounds` is, and for a sharper one: the durable fold exists so an
   * artifact survives a later teardown, so after one the LIVE vendor tree is gone while the
   * kept tree still declares its packages. Reading the live tree at collection time then
   * reports every vendored package as withdrawn.
   */
  vendor: VendorScan;
}

/**
 * Provider markers for a run that was cancelled in flight rather than completing. A
 * cancelled s4 run reported `"[Task cancelled by user]"` (or `""`) on the real run;
 * those must never overwrite an earlier real self-report.
 */
const CANCEL_MARKERS = [
  "[task cancelled",
  "[cancelled]",
  "[aborted]",
  "[task killed by", // stall watchdog and run-ceiling kills (an issue)
  "[task terminated by sigterm", // external / unattributed SIGTERM kills (an issue)
];

/**
 * Sandbox / OS error signatures that leaked into the summary slot instead of a real
 * self-report (an issue). The G2 (b) run's ENOSPC abort filled s2's summary for BOTH
 * arms with the raw sandbox line `bwrap: Can't find source path .../run-.../home/... :
 * No such file or directory` — non-empty and not a cancel marker, so the floor scored it
 * GOOD and a vacuous env-error datum was nearly carried as signal. These markers are
 * matched with the same `startsWith` precision as the cancel markers: a summary that
 * *leads* with a tool/OS error line is not a real artifact self-report. This is the
 * high-precision code floor (won't reject real prose that merely mentions an error
 * mid-sentence); the run's operator-side tripwire is the high-recall backstop that
 * SIGTERMs on the same signatures appearing anywhere in a record.
 */
const ENV_ERROR_MARKERS = ["bwrap:", "enospc", "no space left on device"];

/**
 * A summary is GOOD if it's a real self-report — non-empty after trim, not a provider
 * cancel marker, and not a leading sandbox/OS error line. Used to keep a later cancel or
 * an env-error string from clobbering a good summary.
 */
export function isGoodSummary(summary: string | null | undefined): boolean {
  const s = (summary ?? "").trim();
  if (s.length === 0) return false;
  const lower = s.toLowerCase();
  return ![...CANCEL_MARKERS, ...ENV_ERROR_MARKERS].some((m) => lower.startsWith(m));
}

/**
 * Fold a new step capture into the running durable capture for one arm. The invariant
 * the real run violated: a later step that wiped the workspace (empty `files`) or got
 * cancelled (bad `summary`) must NOT destroy an earlier good capture.
 *  - files:   keep `next.files` only if non-empty; else retain `prev.files`.
 *  - summary: keep `next.summary` only if it's a good self-report; else retain prev's.
 *  - stepId:  tracks whichever artifact (`files`) we are actually keeping.
 *  - bounds:  moves WITH `files`, never on its own — the coverage record has to describe
 *             the capture that is actually being kept, or it understates what is missing.
 *  - vendor:  likewise. The kept tree and the vendor scan it is compared against must come
 *             from the same moment, or a package the kept tree still uses reads as removed.
 * Returns `prev` unchanged when `next` carries nothing worth keeping (so the accumulator
 * stays null until the first good capture).
 */
export function foldDurableCapture(
  prev: StepCapture | null,
  next: StepCapture
): StepCapture | null {
  const keepFiles = next.files.length > 0;
  const files = keepFiles ? next.files : (prev?.files ?? []);
  const bounds = keepFiles ? next.bounds : (prev?.bounds ?? next.bounds);
  const vendor = keepFiles ? next.vendor : (prev?.vendor ?? next.vendor);
  const stepId = keepFiles ? next.stepId : (prev?.stepId ?? next.stepId);
  const summary = isGoodSummary(next.summary) ? next.summary : (prev?.summary ?? "");
  if (files.length === 0 && summary.length === 0) return prev;
  return { stepId, summary, files, bounds, vendor };
}
