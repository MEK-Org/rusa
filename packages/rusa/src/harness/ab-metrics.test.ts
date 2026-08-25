import { describe, expect, it } from "vitest";
import type { InjectRecord } from "../actor/portable-context.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import {
  assessArmsIntact,
  assessDiskHeadroom,
  assessProbeAnswered,
  assessRunValidity,
  computeVariantMetrics,
  intentWindows,
  mergeValidity,
  type StepInjectLog,
  type VariantKind,
  type VariantMetrics,
  verifyAging,
} from "./ab-metrics.js";
import {
  buildTodoScenario,
  buildTodoScenarioV3,
  decisionStepIds,
  TODO_APP_SCENARIO,
} from "./scenario.js";

let seq = 0;
const ev = (kind: string, actorId: string, extra: Partial<MeshEvent> = {}): MeshEvent => {
  seq += 1;
  return {
    id: extra.id ?? `e${seq}`,
    ts: `2026-07-08T00:00:${String(seq).padStart(2, "0")}.000Z`,
    kind,
    actorId,
    detail: null,
    body: null,
    payload: null,
    success: null,
    ...extra,
  };
};

const inject = (bytes: number, sourceEventIds: string[]): string =>
  JSON.stringify({
    bytes,
    hash: "h".repeat(64),
    sourceEventIds,
    runCount: sourceEventIds.length,
  } satisfies InjectRecord);

describe("computeVariantMetrics", () => {
  it("counts runs, failures, continuations and ignores other actors' events", () => {
    const events: MeshEvent[] = [
      ev("run_queued", "w1"),
      ev("run_end", "w1", { success: true }),
      ev("run_continued", "w1"),
      ev("run_end", "w1", { success: false }),
      ev("run_end", "other"), // different actor — must be ignored
    ];
    const m = computeVariantMetrics("native", "w1", events);
    expect(m.runCount).toBe(2);
    expect(m.runFailures).toBe(1);
    expect(m.continuations).toBe(1);
    expect(m.contextInjections).toBe(0);
    expect(m.injectedBytesTotal).toBe(0);
  });

  it("sums injected bytes and tracks the max for the portable variant", () => {
    // The inject record rides on run_start (design ISSUE_NUM): body = InjectRecord JSON.
    const events: MeshEvent[] = [
      ev("run_start", "w2", { body: inject(1000, ["a"]) }),
      ev("run_start", "w2", { body: inject(2500, ["a", "b"]) }),
      ev("run_start", "w2", { body: "not json" }), // ignored, not counted
    ];
    const m = computeVariantMetrics("portable", "w2", events);
    expect(m.contextInjections).toBe(2);
    expect(m.injectedBytesTotal).toBe(3500);
    expect(m.injectedBytesMax).toBe(2500);
  });

  it("is order-independent", () => {
    const a = [ev("run_end", "w"), ev("run_start", "w", { body: inject(10, ["x"]) })];
    const forward = computeVariantMetrics("portable", "w", a);
    const reversed = computeVariantMetrics("portable", "w", [...a].reverse());
    expect(forward).toEqual(reversed);
  });
});

describe("assessRunValidity", () => {
  // Minimal VariantMetrics for the two counters the guard reads; the rest are 0.
  const vm = (variant: VariantKind, runCount: number, runFailures: number): VariantMetrics => ({
    variant,
    actorId: variant,
    runCount,
    runFailures,
    continuations: 0,
    contextInjections: 0,
    injectedBytesTotal: 0,
    injectedBytesMax: 0,
  });
  const pair = (n: VariantMetrics, p: VariantMetrics): Record<VariantKind, VariantMetrics> => ({
    native: n,
    portable: p,
  });

  it("is valid with no warnings when both arms have only successful runs", () => {
    const v = assessRunValidity(pair(vm("native", 5, 0), vm("portable", 5, 0)));
    expect(v.valid).toBe(true);
    expect(v.fatal).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it("is FATAL when an arm logged runs but zero of them succeeded (the kimi EROFS shape)", () => {
    // 5/5 failed on both arms — error-only history; must not be blind-judged.
    const v = assessRunValidity(pair(vm("native", 5, 5), vm("portable", 5, 5)));
    expect(v.valid).toBe(false);
    expect(v.fatal).toHaveLength(2);
    expect(v.fatal[0]).toContain("native arm logged 0 successful runs");
  });

  it("is FATAL when an arm never dispatched a run", () => {
    const v = assessRunValidity(pair(vm("native", 3, 0), vm("portable", 0, 0)));
    expect(v.valid).toBe(false);
    expect(v.fatal).toEqual(["portable arm logged 0 runs — never dispatched"]);
  });

  it("stays VALID with a warning on partial failure (benign native watchdog stalls)", () => {
    // native stalled once but still produced successes — a signal, not an invalidation.
    const v = assessRunValidity(pair(vm("native", 5, 1), vm("portable", 5, 0)));
    expect(v.valid).toBe(true);
    expect(v.fatal).toEqual([]);
    expect(v.warnings).toEqual(["native arm had 1/5 run failures"]);
  });
});

describe("assessProbeAnswered", () => {
  // The G2-v2 constraint run: s1-initial, s2-pivot-airgap, filler×2, s-probe-fuzzy.
  const scenario = buildTodoScenarioV3(2);
  const decisions = decisionStepIds(scenario);
  const probeId = decisions[decisions.length - 1];

  const log = (stepId: string, successfulRunEnds: number, extra: Partial<StepInjectLog> = {}) =>
    ({
      stepId,
      runEndIds: Array.from({ length: Math.max(successfulRunEnds, 1) }, (_, i) => `${stepId}-${i}`),
      firstInjectSourceIds: null,
      successfulRunEnds,
      capped: false,
      idle: true,
      ...extra,
    }) satisfies StepInjectLog;

  const bothArms = (logs: StepInjectLog[]): Record<VariantKind, StepInjectLog[]> => ({
    native: logs,
    portable: logs,
  });

  const allAnswered = decisions.map((id) => log(id, 3));

  it("is valid when every decision step produced at least one successful run", () => {
    const v = assessProbeAnswered(scenario, bothArms(allAnswered));
    expect(v.valid).toBe(true);
    expect(v.fatal).toEqual([]);
  });

  it("is FATAL when the PROBE ran but every one of its runs failed (v2 run 2's shape)", () => {
    // Five of six steps green, the probe dispatched into a provider already refusing.
    // v2 exited 0 here and printed AGED-OUT ✓; there is nothing to judge.
    const logs = decisions.map((id) => log(id, id === probeId ? 0 : 3));
    const v = assessProbeAnswered(scenario, bothArms(logs));
    expect(v.valid).toBe(false);
    expect(v.fatal[0]).toContain("PROBE step");
    expect(v.fatal[0]).toContain(probeId);
  });

  it("is FATAL when an earlier decision step was never answered", () => {
    // The air-gap pivot is the constraint the probe TESTS — losing it is as fatal as
    // losing the probe, and names itself as a decision step rather than the probe.
    const logs = decisions.map((id) => log(id, id === "s2-pivot-airgap" ? 0 : 3));
    const v = assessProbeAnswered(scenario, bothArms(logs));
    expect(v.valid).toBe(false);
    expect(v.fatal[0]).toContain("decision step s2-pivot-airgap");
  });

  it("is FATAL when an arm never reached a decision step at all", () => {
    const logs = allAnswered.filter((l) => l.stepId !== probeId);
    const v = assessProbeAnswered(scenario, { native: allAnswered, portable: logs });
    expect(v.valid).toBe(false);
    expect(v.fatal).toEqual([`portable arm never ran PROBE step ${probeId}`]);
  });

  it("ignores filler steps — only decisions have to be answered", () => {
    const withFailedFiller = [...allAnswered, log("gap-air-1", 0)];
    expect(assessProbeAnswered(scenario, bothArms(withFailedFiller)).valid).toBe(true);
  });

  it("WARNS (does not invalidate) when a decision step was capped or timed out", () => {
    const logs = decisions.map((id) =>
      id === probeId ? log(id, 2, { capped: true, idle: false }) : log(id, 3)
    );
    const v = assessProbeAnswered(scenario, bothArms(logs));
    expect(v.valid).toBe(true);
    expect(v.warnings[0]).toContain("per-step run cap");
  });

  it("WARNS when the success count is missing — unknown is not a pass", () => {
    // Older reports have no successfulRunEnds. Treating absent as 0 would false-fail
    // them; treating it as a pass would re-create the v2 blind spot. Warn.
    const logs = decisions.map((id) => ({ ...log(id, 3), successfulRunEnds: undefined }));
    const v = assessProbeAnswered(scenario, bothArms(logs));
    expect(v.valid).toBe(true);
    expect(v.warnings.some((w) => w.includes("success count not recorded"))).toBe(true);
  });
});

describe("assessArmsIntact (ISSUE_NUM — a run that loses an arm is not half-scored)", () => {
  const ARMS = { native: "w-native", portable: "w-portable" } as const;
  const captures = (...counts: number[]) =>
    counts.map((capturedFileCount, i) => ({ stepId: `s${i + 1}`, capturedFileCount }));
  const bothCaptures = (...counts: number[]) => ({
    native: captures(...counts),
    portable: captures(...counts),
  });

  it("passes when both arms survived and every step captured files", () => {
    const v = assessArmsIntact(ARMS, [ev("run_end", "w-native")], bothCaptures(3, 5, 5));
    expect(v.valid).toBe(true);
    expect(v.fatal).toEqual([]);
  });

  it("is fatal when an arm was retired mid-run, and names who retired it", () => {
    const events = [
      ev("actor_retired", "w-portable", {
        payload: JSON.stringify({ parentId: "root" }),
      }),
    ];
    const v = assessArmsIntact(ARMS, events, bothCaptures(3, 5, 5));
    expect(v.valid).toBe(false);
    expect(v.fatal).toHaveLength(1);
    expect(v.fatal[0]).toContain("w-portable");
    expect(v.fatal[0]).toContain("RETIRED");
    expect(v.fatal[0]).toContain("by root");
  });

  it("ignores a retire of some OTHER thread — only the arms count", () => {
    const v = assessArmsIntact(ARMS, [ev("actor_retired", "some-other")], bothCaptures(3, 5));
    expect(v.valid).toBe(true);
  });

  it("is fatal on an empty capture at ANY step, not just the last", () => {
    // The fold keeps the last GOOD capture, so a run whose middle step captured
    // nothing still ends with a plausible tree — this is the check that sees it.
    const v = assessArmsIntact(ARMS, [], {
      native: captures(4, 0, 6),
      portable: captures(4, 5, 6),
    });
    expect(v.valid).toBe(false);
    expect(v.fatal).toHaveLength(1);
    expect(v.fatal[0]).toContain("native");
    expect(v.fatal[0]).toContain("s2");
  });

  it("is fatal when an arm captured no steps at all", () => {
    const v = assessArmsIntact(ARMS, [], { native: captures(4, 5), portable: [] });
    expect(v.valid).toBe(false);
    expect(v.fatal[0]).toContain("portable arm captured no steps");
  });

  it("reports BOTH losses when both arms are gone", () => {
    const events = [ev("actor_retired", "w-native"), ev("actor_retired", "w-portable")];
    const v = assessArmsIntact(ARMS, events, bothCaptures(0));
    expect(v.fatal).toHaveLength(4); // one retire + one empty capture per arm
  });
});

describe("mergeValidity", () => {
  it("is invalid if ANY input is, and keeps every reason from both", () => {
    const merged = mergeValidity(
      { valid: true, fatal: [], warnings: ["w1"] },
      { valid: false, fatal: ["f1"], warnings: ["w2"] }
    );
    expect(merged.valid).toBe(false);
    expect(merged.fatal).toEqual(["f1"]);
    expect(merged.warnings).toEqual(["w1", "w2"]);
  });
});

describe("intentWindows", () => {
  it("pairs the decision before each filler gap with the decision after it", () => {
    // TODO scenario: s2-refinement →(gap-a)→ s3-pivot-crdt →(gap-b)→ s4-pivot-infinite
    expect(intentWindows(TODO_APP_SCENARIO)).toEqual([
      { decisionStepId: "s2-refinement", testedAtStepId: "s3-pivot-crdt" },
      { decisionStepId: "s3-pivot-crdt", testedAtStepId: "s4-pivot-infinite" },
    ]);
  });

  it("returns the same two pairs regardless of filler count", () => {
    expect(intentWindows(buildTodoScenario(2))).toHaveLength(2);
    expect(intentWindows(buildTodoScenario(20))).toHaveLength(2);
  });
});

describe("verifyAging", () => {
  const scenario = TODO_APP_SCENARIO;

  it("reports agedOut=true when the decision's runs are absent from the tested injection", () => {
    const log: StepInjectLog[] = [
      { stepId: "s2-refinement", runEndIds: ["r-s2"], firstInjectSourceIds: null },
      // At s3, the injected tail is recent filler runs — s2's run has aged out.
      { stepId: "s3-pivot-crdt", runEndIds: ["r-s3"], firstInjectSourceIds: ["r-f9", "r-f10"] },
      { stepId: "s4-pivot-infinite", runEndIds: ["r-s4"], firstInjectSourceIds: ["r-g9", "r-g10"] },
    ];
    const checks = verifyAging(scenario, log);
    expect(checks.every((c) => c.agedOut === true)).toBe(true);
  });

  it("reports agedOut=false (vacuous for that pair) when the decision still sits in the tail", () => {
    const log: StepInjectLog[] = [
      { stepId: "s2-refinement", runEndIds: ["r-s2"], firstInjectSourceIds: null },
      // s2's run is STILL in the injected tail at s3 → not aged out → vacuous pair.
      { stepId: "s3-pivot-crdt", runEndIds: ["r-s3"], firstInjectSourceIds: ["r-s2", "r-f10"] },
    ];
    const pair = verifyAging(scenario, log).find((c) => c.decisionStepId === "s2-refinement");
    expect(pair?.agedOut).toBe(false);
  });

  it("reports agedOut=null (inconclusive) when no injection was recorded at the tested step", () => {
    const log: StepInjectLog[] = [
      { stepId: "s2-refinement", runEndIds: ["r-s2"], firstInjectSourceIds: null },
      { stepId: "s3-pivot-crdt", runEndIds: ["r-s3"], firstInjectSourceIds: null },
    ];
    const pair = verifyAging(scenario, log).find((c) => c.decisionStepId === "s2-refinement");
    expect(pair?.agedOut).toBeNull();
  });

  it("reports agedOut=null (not a vacuous true) when the decision step produced no runs", () => {
    const log: StepInjectLog[] = [
      // s2 timed out / was misattributed → NO run_end ids to age, even though s3
      // recorded an injection. `![].some(...)` would be `true` → falsely AGED-OUT.
      { stepId: "s2-refinement", runEndIds: [], firstInjectSourceIds: null },
      { stepId: "s3-pivot-crdt", runEndIds: ["r-s3"], firstInjectSourceIds: ["r-f9", "r-f10"] },
    ];
    const pair = verifyAging(scenario, log).find((c) => c.decisionStepId === "s2-refinement");
    expect(pair?.agedOut).toBeNull();
  });
});

describe("assessDiskHeadroom", () => {
  const floorBytes = 200 * 1024 * 1024;

  it("VOIDS the run on a breach — an aborted run must not read as a short clean one", () => {
    // The whole reason this is fatal rather than a warning: on a breach the driver stops
    // dispatching, so the scoring below runs over a PREFIX of the scenario. Every metric,
    // the aging check and the blind package are then computed from a truncated run that
    // looks exactly like a scenario which finished.
    const verdict = assessDiskHeadroom({
      state: "breached",
      floorBytes,
      enforcedSamples: 4,
      unmeasuredSamples: 0,
      minAvailableBytes: 50 * 1024 * 1024,
      breach: {
        availableBytes: 50 * 1024 * 1024,
        floorBytes,
        measuredPath: "/x",
        atSample: 3,
      },
      message: "INSUFFICIENT free space mid-run",
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.fatal).toEqual(["INSUFFICIENT free space mid-run"]);
    expect(verdict.warnings).toEqual([]);
  });

  it("WARNS but does not void when the watch could not measure anything", () => {
    // The third state has to land somewhere that is neither a pass nor a refusal. Voiding
    // the run would throw away good data because a probe failed; staying silent would let
    // "never breached" mean "never looked".
    const verdict = assessDiskHeadroom({
      state: "not-enforced",
      floorBytes,
      enforcedSamples: 0,
      unmeasuredSamples: 6,
      minAvailableBytes: null,
      breach: null,
      reason: "could not statfs /x: EACCES",
      message: "mid-run free-space watch NOT ENFORCED",
    });
    expect(verdict.valid).toBe(true);
    expect(verdict.fatal).toEqual([]);
    expect(verdict.warnings).toEqual(["mid-run free-space watch NOT ENFORCED"]);
  });

  it("says nothing at all when the watch held — the counter-assertion to both cells above", () => {
    const verdict = assessDiskHeadroom({
      state: "ok",
      floorBytes,
      enforcedSamples: 6,
      unmeasuredSamples: 0,
      minAvailableBytes: 900 * 1024 * 1024,
      breach: null,
      message: "mid-run free space held",
    });
    expect(verdict).toEqual({ valid: true, fatal: [], warnings: [] });
  });

  it("carries its breach through mergeValidity, which is how the report actually sees it", () => {
    // `assessDiskHeadroom` is only ever called inside the merge; a cell that tests it alone
    // would not catch a merge that drops a fatal reason on the floor.
    const merged = mergeValidity(
      { valid: true, fatal: [], warnings: ["something else"] },
      assessDiskHeadroom({
        state: "breached",
        floorBytes,
        enforcedSamples: 2,
        unmeasuredSamples: 1,
        minAvailableBytes: 10,
        breach: { availableBytes: 10, floorBytes, measuredPath: "/x", atSample: 2 },
        message: "INSUFFICIENT free space mid-run: 10 bytes",
      })
    );
    expect(merged.valid).toBe(false);
    expect(merged.fatal).toContain("INSUFFICIENT free space mid-run: 10 bytes");
    expect(merged.warnings).toContain("something else");
  });
});
