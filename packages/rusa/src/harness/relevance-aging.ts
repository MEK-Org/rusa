import { assemblePortableContext, portableContextMaxRuns } from "../actor/portable-context.js";
import { type IntentWindow, intentWindows, type StepInjectLog } from "./ab-metrics.js";
import type { Scenario } from "./scenario.js";

/**
 * Relevance-aware aging probe (an issue, Concern 3). The first real run taught us
 * that `--filler-per-gap 2` did NOT evict the s2 decision by the time s3 tested it —
 * and `agedOut=FALSE` there was GENUINE, not a bug. The reason: the injector does not
 * age by pure last-N tail position. Each run it SELECTs the newest {@link
 * PORTABLE_CONTEXT_MAX_RUNS} run_ends and then byte-caps them (`assemblePortableContext`
 * keeps the newest that fit under the budget). A decision can therefore be kept alive
 * past the raw last-N window — or evicted *earlier* than N by the byte cap — depending
 * on the run bodies.
 *
 * {@link verifyAging} (ab-metrics.ts) already checks the decision against the injector's
 * ACTUAL injected `sourceEventIds`, but it depends on the driver capturing
 * `firstInjectSourceIds` live per step — which the stall corrupted at s4 (Concern 2).
 * This probe instead RECONSTRUCTS the injector's SELECT set deterministically from the
 * event log + the per-step run_end boundaries, so it is robust to a live-capture miss
 * and self-explaining: it emits the reconstructed SELECT set and *why* each decision
 * was kept or evicted (rolled past the window vs. dropped by the byte cap).
 *
 * The reconstruction mirrors the injector exactly: at the tested step's FIRST run, the
 * candidate run_ends are all of the actor's prior-step run_ends (oldest→newest); the
 * injector takes the newest {@link PORTABLE_CONTEXT_MAX_RUNS} of them and byte-caps via
 * `assemblePortableContext`. The result's `sourceEventIds` IS the SELECT set.
 */

/** A prior run's identity + body, needed to replay the injector's byte cap faithfully. */
export interface RunEndBody {
  ts: string;
  body: string | null;
}

/** Why a decision's run_end is (or isn't) in the reconstructed SELECT set at the probe step. */
export type AgingReason =
  | "in-select" // survived: still injected at the probe step → NOT aged out (raise filler)
  | "evicted-by-window" // rolled past the newest-N window entirely
  | "evicted-by-byte-cap" // was within the newest-N window but dropped by the 32KB cap
  | "no-decision-runs" // the decision step produced no run_ends to age (inconclusive)
  | "no-prior-runs"; // nothing existed to select at the probe step (inconclusive)

/** The measured outcome for one aging pair on the portable variant, reconstructed not captured. */
export interface RelevanceAgingCheck extends IntentWindow {
  /** The decision step's `run_end` ids — what must be absent from the SELECT set to age out. */
  decisionRunEndIds: string[];
  /** The injector's reconstructed SELECT set (`sourceEventIds`) at the tested step's first run. */
  selectSet: string[];
  /** Count of the actor's run_ends newer than the decision's newest run at probe time. */
  windowDepthAtTest: number;
  /**
   * true  — the decision is ABSENT from the reconstructed SELECT set: the thesis is
   *         genuinely exercised (the variant had to preserve intent without the raw run).
   * false — the decision is still in the SELECT set: vacuous for this pair — raise filler.
   * null  — inconclusive (no decision runs, or no prior runs to select from). Reported.
   */
  agedOut: boolean | null;
  reason: AgingReason;
}

/** The full probe report for the portable variant, including a re-run filler recommendation. */
export interface RelevanceAgingReport {
  checks: RelevanceAgingCheck[];
  /** Mean `run_end` count per filler step this run — how fast filler pushes the window. */
  observedRunEndsPerFillerStep: number;
  /** True if any pair came back `agedOut === false` (a decision survived to its probe). */
  underEvicted: boolean;
  /**
   * Window-safe filler floor: enough filler steps that their run_ends alone exceed the
   * last-N window, guaranteeing the decision rolls out even before the byte cap helps.
   * Conservative — the byte cap can evict earlier, so this is an upper bound.
   */
  recommendedFillerPerGap: number;
}

/**
 * Reconstruct the injector SELECT set at each aging pair's probe step and report whether
 * each decision genuinely aged out of it. Pure over its inputs (event bodies + the
 * driver's per-step run_end ids); no db, no live inject records — so it survives a
 * corrupted live capture and is unit-testable against synthetic logs.
 */
export function verifyRelevanceAging(
  scenario: Scenario,
  stepLogs: readonly StepInjectLog[],
  runEndBodies: ReadonlyMap<string, RunEndBody>
): RelevanceAgingReport {
  const stepIndex = new Map(scenario.steps.map((s, i) => [s.id, i]));
  const logByStep = new Map(stepLogs.map((l) => [l.stepId, l]));

  const checks = intentWindows(scenario).map(
    ({ decisionStepId, testedAtStepId }): RelevanceAgingCheck => {
      const decisionRunEndIds = logByStep.get(decisionStepId)?.runEndIds ?? [];
      const testIdx = stepIndex.get(testedAtStepId) ?? -1;

      // Candidates that existed at the tested step's FIRST run = every run_end produced in
      // an EARLIER step, oldest→newest (scenario order is chronological).
      const priorRunEndIds: string[] = [];
      for (const step of scenario.steps) {
        if ((stepIndex.get(step.id) ?? -1) >= testIdx) break;
        priorRunEndIds.push(...(logByStep.get(step.id)?.runEndIds ?? []));
      }

      const base = { decisionStepId, testedAtStepId, decisionRunEndIds };
      if (decisionRunEndIds.length === 0) {
        return {
          ...base,
          selectSet: [],
          windowDepthAtTest: 0,
          agedOut: null,
          reason: "no-decision-runs",
        };
      }
      if (priorRunEndIds.length === 0) {
        return {
          ...base,
          selectSet: [],
          windowDepthAtTest: 0,
          agedOut: null,
          reason: "no-prior-runs",
        };
      }

      // Replay the injector: newest-N of the candidates, then the byte cap. `sourceEventIds`
      // of the assembled context IS the SELECT set the injector would have used here.
      const newestFirst = [...priorRunEndIds].reverse();
      const windowN = newestFirst.slice(0, portableContextMaxRuns());
      const portable = assemblePortableContext(
        windowN.map((id) => ({
          id,
          ts: runEndBodies.get(id)?.ts ?? "",
          body: runEndBodies.get(id)?.body ?? null,
        }))
      );
      const selectSet = portable?.record.sourceEventIds ?? [];

      // Window depth: how many of the actor's run_ends are newer than the decision's newest
      // run at probe time. ≥ N ⇒ the decision has rolled out of the window on position alone.
      const newestDecisionPos = Math.min(
        ...decisionRunEndIds.map((id) => newestFirst.indexOf(id)).filter((i) => i >= 0)
      );
      const windowDepthAtTest = Number.isFinite(newestDecisionPos)
        ? newestDecisionPos
        : priorRunEndIds.length;

      const selected = new Set(selectSet);
      const inWindow = new Set(windowN);
      const agedOut = !decisionRunEndIds.some((id) => selected.has(id));
      const reason: AgingReason = !agedOut
        ? "in-select"
        : decisionRunEndIds.some((id) => inWindow.has(id))
          ? "evicted-by-byte-cap"
          : "evicted-by-window";

      return { ...base, selectSet, windowDepthAtTest, agedOut, reason };
    }
  );

  const fillerLens = scenario.steps
    .filter((s) => s.kind === "filler")
    .map((s) => logByStep.get(s.id)?.runEndIds.length ?? 0);
  const observedRunEndsPerFillerStep =
    fillerLens.length > 0 ? fillerLens.reduce((a, b) => a + b, 0) / fillerLens.length : 0;

  const underEvicted = checks.some((c) => c.agedOut === false);
  // Enough filler steps that their run_ends alone exceed the window (N+1 to clear it).
  const perStep = Math.max(1, observedRunEndsPerFillerStep);
  const recommendedFillerPerGap = Math.ceil((portableContextMaxRuns() + 1) / perStep);

  return { checks, observedRunEndsPerFillerStep, underEvicted, recommendedFillerPerGap };
}
