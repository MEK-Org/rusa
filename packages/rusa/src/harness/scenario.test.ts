import { describe, expect, it } from "vitest";
import { PORTABLE_CONTEXT_MAX_RUNS } from "../actor/portable-context.js";
import { intentWindows } from "./ab-metrics.js";
import type { QuotaCapture } from "./quota-capture.js";
import {
  assertWindowFit,
  assertWindowHeadroom,
  assertWindowPairing,
  buildTodoScenario,
  buildTodoScenarioV2,
  buildTodoScenarioV3,
  checkWindowFit,
  checkWindowHeadroom,
  checkWindowPairing,
  cumulativeRubricAt,
  DEFAULT_SCENARIO_NAME,
  decisionStepIds,
  finalRubric,
  languagePinMessage,
  MEASURED_RUNS_PER_FRESH_WINDOW,
  minFillerGapSteps,
  plannedProviderRuns,
  type RubricCheck,
  SCENARIO_BUILDERS,
  type Scenario,
  selectScenario,
  TODO_APP_SCENARIO,
} from "./scenario.js";

const allChecks = (s: Scenario): RubricCheck[] => s.steps.flatMap((step) => step.addChecks);

describe("TODO_APP_SCENARIO", () => {
  it("has the three shapes Operator required: an initial task, a refinement, and pivots", () => {
    const kinds = decisionStepIds(TODO_APP_SCENARIO).map(
      (id) => TODO_APP_SCENARIO.steps.find((s) => s.id === id)?.kind
    );
    expect(kinds[0]).toBe("initial");
    expect(kinds).toContain("refinement");
    expect(kinds.filter((k) => k === "pivot").length).toBeGreaterThanOrEqual(2);
  });

  it("has unique step ids and unique check ids", () => {
    const stepIds = TODO_APP_SCENARIO.steps.map((s) => s.id);
    expect(new Set(stepIds).size).toBe(stepIds.length);
    const checkIds = allChecks(TODO_APP_SCENARIO).map((c) => c.id);
    expect(new Set(checkIds).size).toBe(checkIds.length);
  });

  it("only retires checks that were actually introduced earlier", () => {
    const introduced = new Set<string>();
    for (const step of TODO_APP_SCENARIO.steps) {
      for (const id of step.retireChecks ?? []) {
        expect(introduced.has(id)).toBe(true);
      }
      for (const c of step.addChecks) introduced.add(c.id);
    }
  });

  it("carries both must-have and must-not-have criteria (catches leaked/abandoned design)", () => {
    const polarities = allChecks(TODO_APP_SCENARIO).map((c) => c.polarity);
    expect(polarities).toContain("mustHave");
    expect(polarities).toContain("mustNotHave");
  });

  it("filler steps carry no rubric checks (intent-neutral)", () => {
    for (const step of TODO_APP_SCENARIO.steps) {
      if (step.kind === "filler") {
        expect(step.addChecks).toHaveLength(0);
        expect(step.retireChecks ?? []).toHaveLength(0);
      }
    }
  });
});

describe("language pin (cloudy's ruling (b) on ISSUE_NUM)", () => {
  const built = [buildTodoScenario(2), buildTodoScenarioV2(2), buildTodoScenarioV3(2)];

  it("declares exactly one language per scenario", () => {
    for (const s of built) expect(s.language).toBe("javascript");
  });

  it("restates the pin in EVERY step, filler included", () => {
    // A precondition stated once at s1-initial can age out of the portable arm's window
    // exactly like a decision, and an arm that switches language mid-run would corrupt
    // the measurement rather than produce a reading of it.
    for (const s of built) {
      for (const step of s.steps) {
        expect(step.message, `${s.id}/${step.id}`).toContain(languagePinMessage(s.language));
      }
    }
  });

  it("generates the pin text from the declared language so the two cannot drift", () => {
    expect(languagePinMessage("javascript")).toContain("JavaScript running on Node.js");
    expect(languagePinMessage("python")).toContain("Python");
    // Stated as a precondition, not a preference — the soft wording is what the G2-v3
    // arm ignored when it built Python under "use the Node.js standard library only".
    expect(languagePinMessage("javascript")).toContain("Hard precondition");
  });

  it("leaves the steps otherwise untouched (the pin appends, it does not rewrite)", () => {
    const v3 = buildTodoScenarioV3(2);
    const airgap = v3.steps.find((s) => s.id === "s2-pivot-airgap");
    expect(airgap?.message).toContain("air-gapped, offline site");
    expect(airgap?.addChecks.map((c) => c.id)).toEqual(["c-no-new-deps"]);
  });
});

describe("vacuous-pass guard (aging decisions past the tail)", () => {
  it("inserts enough filler between the refinement and the CRDT pivot to age it out of the last-N window", () => {
    const s = TODO_APP_SCENARIO;
    const refIdx = s.steps.findIndex((x) => x.id === "s2-refinement");
    const pivotIdx = s.steps.findIndex((x) => x.id === "s3-pivot-crdt");
    const between = pivotIdx - refIdx - 1;
    // Strictly more than the last-N window, so the refinement's run_end is pushed
    // out of the portable tail even at one-run-per-step (byte cap can age it sooner).
    expect(between).toBeGreaterThan(PORTABLE_CONTEXT_MAX_RUNS);
  });

  it("also ages the CRDT pivot out before the infinite-nesting pivot", () => {
    const s = TODO_APP_SCENARIO;
    const crdtIdx = s.steps.findIndex((x) => x.id === "s3-pivot-crdt");
    const infIdx = s.steps.findIndex((x) => x.id === "s4-pivot-infinite");
    expect(infIdx - crdtIdx - 1).toBeGreaterThan(PORTABLE_CONTEXT_MAX_RUNS);
  });

  it("filler count is tunable via buildTodoScenario", () => {
    const small = buildTodoScenario(2);
    expect(small.steps.filter((x) => x.kind === "filler")).toHaveLength(4); // 2 gaps × 2
    expect(decisionStepIds(small)).toEqual([
      "s1-initial",
      "s2-refinement",
      "s3-pivot-crdt",
      "s4-pivot-infinite",
    ]);
  });
});

describe("cumulativeRubricAt", () => {
  it("returns only the initial checks at the initial step", () => {
    const ids = cumulativeRubricAt(TODO_APP_SCENARIO, "s1-initial").map((c) => c.id);
    expect(ids).toEqual(["c-rest-crud", "c-add-complete"]);
  });

  it("accumulates the refinement check while keeping the initial functional intent", () => {
    const ids = cumulativeRubricAt(TODO_APP_SCENARIO, "s2-refinement").map((c) => c.id);
    expect(ids).toContain("c-add-complete");
    expect(ids).toContain("c-nest-one-layer");
  });

  it("retires the CRUD-shape check at the CRDT pivot but preserves add/complete + one-layer nesting", () => {
    const ids = cumulativeRubricAt(TODO_APP_SCENARIO, "s3-pivot-crdt").map((c) => c.id);
    expect(ids).not.toContain("c-rest-crud");
    expect(ids).toContain("c-add-complete");
    expect(ids).toContain("c-nest-one-layer");
    expect(ids).toContain("c-event-sourced");
    expect(ids).toContain("c-no-mutable-crud");
  });

  it("final rubric: infinite nesting supersedes the one-layer cap; CRDT model stands", () => {
    const ids = finalRubric(TODO_APP_SCENARIO).map((c) => c.id);
    expect(ids).not.toContain("c-rest-crud");
    expect(ids).not.toContain("c-nest-one-layer");
    expect(ids).toContain("c-infinite-nesting");
    expect(ids).toContain("c-no-one-layer-cap");
    expect(ids).toContain("c-event-sourced");
    expect(ids).toContain("c-crdt-merge");
  });

  it("throws on an unknown step id", () => {
    expect(() => cumulativeRubricAt(TODO_APP_SCENARIO, "nope")).toThrow(/unknown step id/);
  });
});

describe("buildTodoScenarioV2 (G2-v2 short single-pivot run)", () => {
  it("is a 5-step run: initial → CRDT pivot → 2 filler → undo probe", () => {
    const s = buildTodoScenarioV2();
    expect(s.steps.map((st) => st.id)).toEqual([
      "s1-initial",
      "s3-pivot-crdt",
      "gap-c-filler-1",
      "gap-c-filler-2",
      "s3-probe-undo",
    ]);
    expect(s.steps.map((st) => st.kind)).toEqual([
      "initial",
      "pivot",
      "filler",
      "filler",
      "refinement",
    ]);
  });

  it("honors the fillerPerGap argument (the shrink-the-window rig can bump it)", () => {
    const fillers = buildTodoScenarioV2(3).steps.filter((st) => st.kind === "filler");
    expect(fillers).toHaveLength(3);
  });

  it("has exactly one aging window — the pivot tested at the undo probe", () => {
    expect(intentWindows(buildTodoScenarioV2())).toEqual([
      { decisionStepId: "s3-pivot-crdt", testedAtStepId: "s3-probe-undo" },
    ]);
  });

  it("keeps the pivot's checks live at the probe and drops the retired CRUD-shape check", () => {
    const ids = cumulativeRubricAt(buildTodoScenarioV2(), "s3-probe-undo").map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "c-add-complete",
        "c-event-sourced",
        "c-crdt-merge",
        "c-no-mutable-crud",
        "c-undo-eventlog",
      ])
    );
    expect(ids).not.toContain("c-rest-crud"); // retired by the pivot
  });

  it("has unique step ids and unique check ids", () => {
    const s = buildTodoScenarioV2();
    const stepIds = s.steps.map((st) => st.id);
    expect(new Set(stepIds).size).toBe(stepIds.length);
    const checkIds = s.steps.flatMap((st) => st.addChecks).map((c) => c.id);
    expect(new Set(checkIds).size).toBe(checkIds.length);
  });

  it("filler steps stay intent-neutral (no rubric checks)", () => {
    for (const step of buildTodoScenarioV2().steps) {
      if (step.kind === "filler") expect(step.addChecks).toHaveLength(0);
    }
  });
});

describe("buildTodoScenarioV3 (G2-v2 run 1 / primary — non-artifact-embodied)", () => {
  it("is a 5-step run: initial → air-gap constraint → 2 filler → fuzzy-search probe", () => {
    const s = buildTodoScenarioV3();
    expect(s.steps.map((st) => st.id)).toEqual([
      "s1-initial",
      "s2-pivot-airgap",
      "gap-air-filler-1",
      "gap-air-filler-2",
      "s-probe-fuzzy",
    ]);
    expect(s.steps.map((st) => st.kind)).toEqual([
      "initial",
      "pivot",
      "filler",
      "filler",
      "refinement",
    ]);
  });

  it("honors the fillerPerGap argument (the shrink-the-window rig can bump it)", () => {
    const fillers = buildTodoScenarioV3(3).steps.filter((st) => st.kind === "filler");
    expect(fillers).toHaveLength(3);
  });

  it("has exactly one aging window — the air-gap constraint tested at the fuzzy probe", () => {
    expect(intentWindows(buildTodoScenarioV3())).toEqual([
      { decisionStepId: "s2-pivot-airgap", testedAtStepId: "s-probe-fuzzy" },
    ]);
  });

  it("accumulates the constraint + probe checks at the probe (nothing retired — overlays CRUD)", () => {
    const ids = cumulativeRubricAt(buildTodoScenarioV3(), "s-probe-fuzzy").map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining(["c-rest-crud", "c-add-complete", "c-no-new-deps", "c-fuzzy-stdlib"])
    );
  });

  it("guards the constraint with a mustNotHave and the probe with a mustHave", () => {
    const byId = new Map(
      buildTodoScenarioV3()
        .steps.flatMap((st) => st.addChecks)
        .map((c) => [c.id, c])
    );
    expect(byId.get("c-no-new-deps")?.polarity).toBe("mustNotHave");
    expect(byId.get("c-fuzzy-stdlib")?.polarity).toBe("mustHave");
  });

  it("has unique step ids and unique check ids", () => {
    const s = buildTodoScenarioV3();
    const stepIds = s.steps.map((st) => st.id);
    expect(new Set(stepIds).size).toBe(stepIds.length);
    const checkIds = s.steps.flatMap((st) => st.addChecks).map((c) => c.id);
    expect(new Set(checkIds).size).toBe(checkIds.length);
  });

  it("filler steps stay intent-neutral (no rubric checks)", () => {
    for (const step of buildTodoScenarioV3().steps) {
      if (step.kind === "filler") expect(step.addChecks).toHaveLength(0);
    }
  });
});

describe("selectScenario (--scenario allow-list; seal's reject-unknown hardening)", () => {
  it("resolves each known scenario name to its builder", () => {
    expect(selectScenario("todo-evolving").id).toBe("todo-app-evolving");
    expect(selectScenario("short-pivot").id).toBe("todo-app-short-pivot");
    expect(selectScenario("constraint-airgap").id).toBe("todo-app-constraint-airgap");
  });

  it("defaults to the evolving scenario when the name is omitted", () => {
    expect(selectScenario(undefined).id).toBe("todo-app-evolving");
    expect(DEFAULT_SCENARIO_NAME).toBe("todo-evolving");
  });

  it("threads fillerPerGap through to the builder", () => {
    const s = selectScenario("constraint-airgap", 3);
    expect(s.steps.filter((st) => st.kind === "filler")).toHaveLength(3);
  });

  it("THROWS on an unknown scenario name rather than silently falling back", () => {
    // The operator-error class the pre-arm checklist guards against: a typo must fail loudly
    // before the rig burns a provider window on the wrong test.
    expect(() => selectScenario("short-pivvot")).toThrow(/unknown --scenario "short-pivvot"/);
    expect(() => selectScenario("")).toThrow(/unknown --scenario/);
    // The error names the valid set so the operator can self-correct.
    expect(() => selectScenario("nope")).toThrow(/todo-evolving, short-pivot, constraint-airgap/);
  });

  it("keeps the allow-list and the builder registry in sync", () => {
    expect(Object.keys(SCENARIO_BUILDERS).sort()).toEqual(
      ["constraint-airgap", "short-pivot", "todo-evolving"].sort()
    );
  });
});

describe("window pairing preflight", () => {
  it("counts the SHORTEST filler gap, not the total or the last", () => {
    // The v1 arc has two gaps; the short runs have one. The shortest is what decides
    // vacuousness, because a decision only needs one under-filled gap to survive.
    expect(minFillerGapSteps(buildTodoScenarioV3(2))).toBe(2);
    expect(minFillerGapSteps(buildTodoScenarioV3(7))).toBe(7);
    expect(minFillerGapSteps(buildTodoScenario(4))).toBe(4);
  });

  it("returns 0 for a scenario with no filler at all", () => {
    const bare: Scenario = {
      id: "bare",
      title: "no filler",
      language: "javascript",
      steps: [{ id: "only", kind: "initial", message: "go", addChecks: [] }],
    };
    expect(minFillerGapSteps(bare)).toBe(0);
    // Nothing to age ⇒ nothing to pair ⇒ must not block the run.
    expect(checkWindowPairing(bare, 10).ok).toBe(true);
  });

  it("REJECTS the exact G2-v3 mispairing: short run against the default window", () => {
    // The real 2026-08-06 launch. `--filler-per-gap 2` with the window left at its
    // default 10 completed all five steps on both arms, reported invalid=false, and
    // measured nothing — the pivot sat at depth 2/10 and never left the tail. One full
    // kimi 5h window to learn that from the report. This is that launch, refused.
    const scenario = buildTodoScenarioV3(2);
    const verdict = checkWindowPairing(scenario, PORTABLE_CONTEXT_MAX_RUNS);
    expect(verdict.ok).toBe(false);
    expect(verdict.fillerGapSteps).toBe(2);
    expect(verdict.windowSize).toBe(10);
    expect(() => assertWindowPairing(scenario, { windowSize: PORTABLE_CONTEXT_MAX_RUNS })).toThrow(
      /cannot age a decision out of the portable tail/
    );
  });

  it("names BOTH remedies, cheap one first, with the real cost ratio", () => {
    // The rig's own recommendedFillerPerGap can only ever suggest raising filler — it
    // reads the window as fixed. On this rig that is ~5x the provider burn, so the
    // message has to volunteer the free alternative or an operator will pay for it.
    const { message } = checkWindowPairing(buildTodoScenarioV3(2), 10);
    expect(message).toContain("PORTABLE_CONTEXT_MAX_RUNS=2");
    expect(message).toContain("--filler-per-gap 10");
    expect(message).toContain("5.0x the runs");
    expect(message.indexOf("PORTABLE_CONTEXT_MAX_RUNS=2")).toBeLessThan(
      message.indexOf("--filler-per-gap 10")
    );
    expect(message).toContain("--allow-under-evicted");
  });

  it("ACCEPTS the pairing the short run was designed for (filler 2, window 2)", () => {
    // verifyRelevanceAging evicts on position once depth >= window, and depth advances
    // ~1 run_end per filler step, so filler 2 clears a window of 2 exactly.
    const verdict = checkWindowPairing(buildTodoScenarioV3(2), 2);
    expect(verdict.ok).toBe(true);
    expect(() => assertWindowPairing(buildTodoScenarioV3(2), { windowSize: 2 })).not.toThrow();
  });

  it("ACCEPTS the v1 arc at its own default, which is already window+1", () => {
    expect(checkWindowPairing(buildTodoScenario(), PORTABLE_CONTEXT_MAX_RUNS).ok).toBe(true);
  });

  it("REJECTS the v1 arc when the env override RAISES the window past its filler", () => {
    // DEFAULT_FILLER_PER_GAP is computed from the CONSTANT, not from the runtime override,
    // so shrinking is safe but growing silently under-fills. The guard reads the runtime value.
    expect(checkWindowPairing(buildTodoScenario(), PORTABLE_CONTEXT_MAX_RUNS + 5).ok).toBe(false);
  });

  it("lets --allow-under-evicted through, and still reports it as not-ok", () => {
    const verdict = assertWindowPairing(buildTodoScenarioV3(2), {
      allowUnderEvicted: true,
      windowSize: 10,
    });
    // The override suppresses the throw; it must NOT launder the verdict, because the
    // report records this field and a laundered `ok` would read as a valid measurement.
    expect(verdict.ok).toBe(false);
  });

  it("reads the runtime window from the env override by default", () => {
    const prev = process.env.PORTABLE_CONTEXT_MAX_RUNS;
    try {
      process.env.PORTABLE_CONTEXT_MAX_RUNS = "2";
      expect(checkWindowPairing(buildTodoScenarioV3(2)).ok).toBe(true);
      process.env.PORTABLE_CONTEXT_MAX_RUNS = "";
      expect(checkWindowPairing(buildTodoScenarioV3(2)).ok).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.PORTABLE_CONTEXT_MAX_RUNS;
      else process.env.PORTABLE_CONTEXT_MAX_RUNS = prev;
    }
  });
});

describe("window fit preflight (does this config fit one fresh provider window?)", () => {
  it("counts one provider run per step per arm", () => {
    // The A/B runs both arms over the same scenario, so the cost is steps x arms — the
    // arithmetic nobody did before spending a whole window on run g2v3c.
    expect(plannedProviderRuns(buildTodoScenarioV3(2))).toBe(10);
    expect(plannedProviderRuns(buildTodoScenarioV3(1))).toBe(8);
    expect(plannedProviderRuns(buildTodoScenarioV3(1), 3)).toBe(12);
  });

  it("refuses the exact G2-v3 config that burned a full kimi window (10 runs vs 9)", () => {
    const verdict = checkWindowFit(buildTodoScenarioV3(2), { provider: "kimi" });
    expect(verdict.ok).toBe(false);
    expect(verdict.plannedRuns).toBe(10);
    expect(verdict.capacityRuns).toBe(9);
    expect(verdict.headroomRuns).toBe(-1);
    expect(() => assertWindowFit(buildTodoScenarioV3(2), { provider: "kimi" })).toThrow(
      /cannot fit one kimi window/
    );
  });

  it("names the cheap fix and warns off the report's filler recommendation", () => {
    // The rig's `Re-run filler recommendation` solves for filler with the window held
    // fixed, so on this failure it can only ever recommend MORE runs. It said 3 (= 12
    // runs) after the 403. The gate has to say so where the operator is already reading.
    const { message } = checkWindowFit(buildTodoScenarioV3(2), { provider: "kimi" });
    expect(message).toContain("PORTABLE_CONTEXT_MAX_RUNS=1");
    expect(message).toContain("--filler-per-gap 1");
    expect(message).toContain("Do NOT take the report's `Re-run filler recommendation`");
    expect(message).toContain("--allow-over-window");
  });

  it("passes the approved 8-run reconfig with headroom", () => {
    const verdict = checkWindowFit(buildTodoScenarioV3(1), { provider: "kimi" });
    expect(verdict.ok).toBe(true);
    expect(verdict.plannedRuns).toBe(8);
    expect(verdict.headroomRuns).toBe(1);
    expect(() => assertWindowFit(buildTodoScenarioV3(1), { provider: "kimi" })).not.toThrow();
  });

  it("does not claim the window is fresh — it only compares against a fresh one", () => {
    // The honest scope of this gate. It takes no live quota reading, so an 8-run config
    // launched into a half-spent window still passes. Saying so in the message is the
    // whole point: the recurring defect here is a check whose label outruns its
    // measurement, and a gate called "quota headroom" would be exactly that.
    const { message } = checkWindowFit(buildTodoScenarioV3(1), { provider: "kimi" });
    expect(message).toContain("Fresh window assumed, NOT verified.");
  });

  it("declines to judge an unmeasured provider instead of inventing a threshold", () => {
    for (const provider of ["claude", "codex", undefined]) {
      const verdict = checkWindowFit(buildTodoScenarioV3(2), { provider });
      expect(verdict.capacityRuns).toBeNull();
      expect(verdict.headroomRuns).toBeNull();
      expect(verdict.message).toContain("NOT CHECKED");
      // Passing is the right default: an unmeasured threshold that blocked launches
      // would be worse than no gate. But `capacityRuns: null` in the report keeps a
      // reader from mistaking this pass for one earned on merit.
      expect(verdict.ok).toBe(true);
    }
  });

  it("lets --allow-over-window through, and still reports it as not-ok", () => {
    const verdict = assertWindowFit(buildTodoScenarioV3(2), {
      allowOverWindow: true,
      provider: "kimi",
    });
    expect(verdict.ok).toBe(false);
  });

  it("carries the measured kimi capacity, not an estimate", () => {
    // 9 was measured on 2026-08-06: launched at a scrape-confirmed 5h 0% used, nine runs
    // succeeded, the tenth took `403 You've reached your usage limit`. If this number is
    // ever edited, it must be re-measured the same way — an estimate here silently turns
    // the gate into a guess wearing a measurement's name.
    const fiveHour = MEASURED_RUNS_PER_FRESH_WINDOW.kimi.find((w) => w.window === "five_hour");
    expect(fiveHour?.runs).toBe(9);
    // Every capacity states its own provenance, so a reader can see n=1 without going
    // to the git log for it.
    for (const w of MEASURED_RUNS_PER_FRESH_WINDOW.kimi) expect(w.measured).not.toBe("");
  });

  it("keeps the structural verdict on the TIGHTEST window, not the best-known one", () => {
    // Adding the weekly capacity must not loosen the structural gate: it takes the minimum,
    // so kimi is still judged against 9. A regression here would show up as a 10-run config
    // suddenly passing because someone's window covers 45.
    const verdict = checkWindowFit(buildTodoScenarioV3(2), { provider: "kimi" });
    expect(verdict.capacityRuns).toBe(9);
  });
});

describe("checkWindowHeadroom — the live half of the window gate (ISSUE_NUM item 2)", () => {
  /** A launch capture shaped exactly like the real kimi one, at the given percentages. */
  function launchAt(fiveHourLeft: number | null, weeklyLeft: number | null): QuotaCapture {
    return {
      phase: "launch",
      provider: "kimi",
      requestedAt: "2026-08-07T06:00:00.000Z",
      outcome: "read",
      scrapedAt: "2026-08-07T06:00:01.000Z",
      status: "available",
      windows: [
        { label: "5h limit", kind: "five_hour", percentLeft: fiveHourLeft },
        { label: "Weekly limit", kind: "weekly", percentLeft: weeklyLeft },
      ],
      message: "quota read at launch",
    };
  }

  // The configuration g2v3d actually ran: one filler per gap → 4 steps → 8 provider runs,
  // the smallest run that still ages a decision out and the only one that fits a kimi window.
  const shortRun = buildTodoScenarioV3(1);

  it("passes an 8-run config launched into a fresh window", () => {
    const verdict = checkWindowHeadroom(shortRun, {
      provider: "kimi",
      launch: launchAt(100, 68),
    });
    expect(verdict.provenance).toBe("live");
    expect(verdict.fits).toBe(true);
    expect(verdict.plannedRuns).toBe(8);
    // 5h: floor(9 * 1.00) = 9, one spare. Weekly: floor(45 * 0.68) = 30. The 5h binds.
    expect(verdict.binding?.window).toBe("five_hour");
    expect(verdict.binding?.remainingRuns).toBe(9);
    expect(verdict.binding?.headroomRuns).toBe(1);
  });

  it("REFUSES the same 8-run config launched into a half-spent window", () => {
    // This is the case the structural gate passes and cannot see: identical configuration,
    // identical arithmetic against a fresh window, but the window is not fresh.
    expect(checkWindowFit(shortRun, { provider: "kimi" }).ok).toBe(true);

    const verdict = checkWindowHeadroom(shortRun, { provider: "kimi", launch: launchAt(50, 68) });
    expect(verdict.provenance).toBe("live");
    expect(verdict.fits).toBe(false);
    // floor(9 * 0.50) = 4 remaining vs 8 planned — short by 4.
    expect(verdict.binding?.remainingRuns).toBe(4);
    expect(verdict.binding?.headroomRuns).toBe(-4);
    expect(verdict.message).toContain("short by 4");
  });

  it("lets the WEEKLY window bind when it is the one about to run out", () => {
    // The false pass this gate would have shipped with if it read the 5h row alone: a
    // perfectly fresh 5h window sitting on a nearly-spent weekly pool.
    const verdict = checkWindowHeadroom(shortRun, { provider: "kimi", launch: launchAt(100, 4) });
    expect(verdict.fits).toBe(false);
    expect(verdict.binding?.window).toBe("weekly");
    // floor(45 * 0.04) = 1 remaining vs 8 planned.
    expect(verdict.binding?.remainingRuns).toBe(1);
  });

  it("reports NOT CHECKED — never a pass — when the probe could not read", () => {
    const unreadable: QuotaCapture = {
      phase: "launch",
      provider: "kimi",
      requestedAt: "2026-08-07T06:00:00.000Z",
      outcome: "unreadable",
      scrapedAt: "2026-08-07T06:00:01.000Z",
      status: "unknown",
      windows: [],
      message: "kimi /usage panel could not be identified semantically",
    };
    const verdict = checkWindowHeadroom(shortRun, { provider: "kimi", launch: unreadable });
    // The load-bearing assertion of this whole gate: `fits` is null, so no reader and no
    // later gate can turn "we could not look" into "there is room".
    expect(verdict.fits).toBeNull();
    expect(verdict.fits).not.toBe(true);
    expect(verdict.provenance).toBe("not-checked");
    expect(verdict.binding).toBeNull();
    // ...and it carries what it saw, so the reason is not lost the way ISSUE_NUM's was.
    expect(verdict.reason).toContain("unreadable");
    expect(verdict.reason).toContain("could not be identified semantically");
    expect(verdict.message).toContain("NOT CHECKED");
    expect(verdict.message).toContain("this is not a pass");
  });

  it("reports NOT CHECKED when no reading was taken at all, and when none was possible", () => {
    for (const launch of [null, undefined]) {
      const verdict = checkWindowHeadroom(shortRun, { provider: "kimi", launch });
      expect(verdict.fits).toBeNull();
      expect(verdict.reason).toContain("no launch quota reading");
    }
    // A provider with no measured capacity: nothing to compare against, so nothing is claimed.
    const unmeasured = checkWindowHeadroom(shortRun, {
      provider: "claude",
      launch: launchAt(100, 100),
    });
    expect(unmeasured.fits).toBeNull();
    expect(unmeasured.reason).toContain("no measured window capacity");
  });

  it("will not judge on a PARTIAL reading — a measured window with no number is NOT CHECKED", () => {
    // A panel that rendered the 5h row but not the weekly. Judging on the half we can see
    // would report a pass while the un-read window is the one that ends the run.
    const verdict = checkWindowHeadroom(shortRun, {
      provider: "kimi",
      launch: launchAt(100, null),
    });
    expect(verdict.fits).toBeNull();
    expect(verdict.reason).toContain("weekly");
    // What WAS compared is still reported — it just isn't a verdict.
    expect(verdict.rows.map((r) => r.window)).toEqual(["five_hour"]);
    expect(verdict.binding).toBeNull();
  });

  it("does not throw on NOT CHECKED, and does throw on a live refusal", () => {
    const unreadable = { ...launchAt(null, null), outcome: "probe-failed" as const };
    // Unreadable must not become a refusal: it would block valid launches on a probe fault,
    // which is the exact trade ISSUE_NUM item 3 names.
    expect(() =>
      assertWindowHeadroom(shortRun, { provider: "kimi", launch: unreadable })
    ).not.toThrow();
    expect(() =>
      assertWindowHeadroom(shortRun, { provider: "kimi", launch: launchAt(10, 68) })
    ).toThrow("does not have room");
  });

  it("lets --allow-over-window through, and still reports it as not fitting", () => {
    const verdict = assertWindowHeadroom(shortRun, {
      provider: "kimi",
      launch: launchAt(10, 68),
      allowOverWindow: true,
    });
    expect(verdict.fits).toBe(false);
  });

  it("floors the estimate rather than rounding it", () => {
    // floor(9 * 0.89) = 8, not 8.01 and not 9. Rounding up here would hand back exactly the
    // margin the gate exists to protect.
    const verdict = checkWindowHeadroom(shortRun, { provider: "kimi", launch: launchAt(89, 100) });
    expect(verdict.rows.find((r) => r.window === "five_hour")?.remainingRuns).toBe(8);
    expect(verdict.fits).toBe(true);
  });

  it("says out loud that the estimate is soft", () => {
    // The arc's recurring defect is a check whose label outruns its measurement. This one
    // scales an n=1 capacity linearly by percent; the message has to admit that, or the
    // number reads as a measurement.
    const verdict = checkWindowHeadroom(shortRun, { provider: "kimi", launch: launchAt(100, 68) });
    expect(verdict.message).toContain("not a promise");
  });
});
