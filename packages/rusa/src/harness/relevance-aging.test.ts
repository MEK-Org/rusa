import { describe, expect, it } from "vitest";
import {
  PORTABLE_CONTEXT_MAX_BYTES,
  PORTABLE_CONTEXT_MAX_RUNS,
} from "../actor/portable-context.js";
import type { StepInjectLog } from "./ab-metrics.js";
import { type RunEndBody, verifyRelevanceAging } from "./relevance-aging.js";
import { buildTodoScenario } from "./scenario.js";

/**
 * Concern 3 of an issue: the relevance-aware aging probe. The first real run's
 * `agedOut=FALSE` at the s2→s3 pair was GENUINE — with `filler-per-gap 2`, s2's run_end
 * was still within the injector's newest-N SELECT window at s3. These tests pin the
 * probe's reconstruction of that SELECT set (window + byte cap) so the re-run price is
 * grounded in what the injector would actually inject, not raw tail position.
 */
describe("verifyRelevanceAging (ISSUE_NUM Concern 3)", () => {
  /** Build a run_end id + a StepInjectLog for a step that produced `n` runs. */
  const stepLog = (stepId: string, n: number, seq: { i: number }): StepInjectLog => {
    const runEndIds = Array.from({ length: n }, () => `re-${seq.i++}`);
    return { stepId, runEndIds, firstInjectSourceIds: null };
  };

  /** A full set of per-step logs for a scenario, `runsPerStep` run_ends each. */
  const buildLogs = (
    scenario: ReturnType<typeof buildTodoScenario>,
    runsPerStep: number
  ): { logs: StepInjectLog[]; bodies: Map<string, RunEndBody> } => {
    const seq = { i: 1 };
    const logs = scenario.steps.map((s) => stepLog(s.id, runsPerStep, seq));
    const bodies = new Map<string, RunEndBody>();
    for (const l of logs) {
      for (const id of l.runEndIds) {
        bodies.set(id, {
          ts: `2026-07-09T00:00:00.000Z`,
          body: `run ${id}: made a small change and committed.`,
        });
      }
    }
    return { logs, bodies };
  };

  it("reports agedOut=false with a small gap: the decision is still inside the SELECT window", () => {
    // filler=2, one run per step → s2 (decision) sits ~3 runs behind s3's first run:
    // well inside the newest-10 window and the byte budget. This is the FIRST run's finding.
    const scenario = buildTodoScenario(2);
    const { logs, bodies } = buildLogs(scenario, 1);
    const report = verifyRelevanceAging(scenario, logs, bodies);

    const s2s3 = report.checks.find((c) => c.decisionStepId === "s2-refinement");
    expect(s2s3?.agedOut).toBe(false);
    expect(s2s3?.reason).toBe("in-select");
    // The decision's run_end is present in the reconstructed SELECT set.
    expect(s2s3?.selectSet).toEqual(expect.arrayContaining(s2s3?.decisionRunEndIds ?? []));
    // Under-eviction is surfaced with a window-safe recommendation.
    expect(report.underEvicted).toBe(true);
    expect(report.recommendedFillerPerGap).toBeGreaterThan(2);
  });

  it("reports agedOut=true once filler pushes the decision past the newest-N window", () => {
    // filler=11 (> N), one run per step → s2's run_end rolls out of the newest-10 window
    // entirely before s3 tests it: evicted by window position, not merely the byte cap.
    const scenario = buildTodoScenario(PORTABLE_CONTEXT_MAX_RUNS + 1);
    const { logs, bodies } = buildLogs(scenario, 1);
    const report = verifyRelevanceAging(scenario, logs, bodies);

    const s2s3 = report.checks.find((c) => c.decisionStepId === "s2-refinement");
    expect(s2s3?.agedOut).toBe(true);
    expect(s2s3?.reason).toBe("evicted-by-window");
    // The decision's run_end is ABSENT from the SELECT set — the thesis is exercised.
    const selected = new Set(s2s3?.selectSet);
    expect((s2s3?.decisionRunEndIds ?? []).some((id) => selected.has(id))).toBe(false);
    expect(s2s3?.windowDepthAtTest).toBeGreaterThanOrEqual(PORTABLE_CONTEXT_MAX_RUNS);
    expect(report.underEvicted).toBe(false);
  });

  it("attributes eviction to the byte cap when the decision is within the window but too big to fit", () => {
    // A small gap keeps the decision INSIDE the newest-N window, but the intervening
    // runs carry huge bodies so the byte cap drops the decision before the window would.
    const scenario = buildTodoScenario(3);
    const { logs, bodies } = buildLogs(scenario, 1);
    // Inflate every run body well past the budget so only the newest 1-2 fit.
    const big = "x".repeat(PORTABLE_CONTEXT_MAX_BYTES);
    for (const [id, b] of bodies) bodies.set(id, { ...b, body: big });
    const report = verifyRelevanceAging(scenario, logs, bodies);

    const s2s3 = report.checks.find((c) => c.decisionStepId === "s2-refinement");
    // Still positioned inside the newest-N window (small gap)...
    expect(s2s3?.windowDepthAtTest).toBeLessThan(PORTABLE_CONTEXT_MAX_RUNS);
    // ...but the byte cap evicted it, so it aged out for a DIFFERENT reason than window.
    expect(s2s3?.agedOut).toBe(true);
    expect(s2s3?.reason).toBe("evicted-by-byte-cap");
  });

  it("keeps the three-state guard: no prior runs at the tested step ⇒ null (inconclusive)", () => {
    // Zero runs before the decision's own step can't happen, but a decision step that
    // produced NO run_ends must not vacuously report aged-out.
    const scenario = buildTodoScenario(2);
    const seq = { i: 1 };
    const logs = scenario.steps.map((s) =>
      // s2 (the first decision) produces zero runs → no decision runs to age.
      s.id === "s2-refinement"
        ? { stepId: s.id, runEndIds: [], firstInjectSourceIds: null }
        : stepLog(s.id, 1, seq)
    );
    const bodies = new Map<string, RunEndBody>();
    for (const l of logs) for (const id of l.runEndIds) bodies.set(id, { ts: "t", body: "x" });

    const report = verifyRelevanceAging(scenario, logs, bodies);
    const s2s3 = report.checks.find((c) => c.decisionStepId === "s2-refinement");
    expect(s2s3?.agedOut).toBeNull();
    expect(s2s3?.reason).toBe("no-decision-runs");
    // A null pair is NOT counted as under-eviction.
    expect(report.underEvicted && s2s3?.agedOut === false).toBe(false);
  });

  it("scales the filler recommendation to observed run_ends per filler step", () => {
    // 2 runs per filler step means each filler pushes the window twice as fast, so the
    // window-safe floor is roughly halved vs. the one-run-per-step assumption.
    const scenario = buildTodoScenario(2);
    const { logs, bodies } = buildLogs(scenario, 2);
    const report = verifyRelevanceAging(scenario, logs, bodies);

    expect(report.observedRunEndsPerFillerStep).toBe(2);
    // ceil((10+1)/2) = 6 filler steps of 2 runs each = 12 run_ends > window of 10.
    expect(report.recommendedFillerPerGap).toBe(Math.ceil((PORTABLE_CONTEXT_MAX_RUNS + 1) / 2));
  });
});
