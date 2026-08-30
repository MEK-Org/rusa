import type { InjectRecord } from "../actor/portable-context.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";
import type { DiskHeadroomVerdict } from "./disk-gate.js";
import type { ModelIdentityVerdict } from "./model-identity.js";
import { decisionStepIds, type Scenario } from "./scenario.js";

/**
 * A/B measurement over the mesh event log (design ISSUE_NUM, phase 2). The side-by-side
 * harness runs one evolving coding task twice — a **native** variant (provider session
 * resumed each run) and a **portable** variant (stateless, mesh-injected context
 * each run) — and this module reduces each variant's
 * `mesh_events` into comparable numbers, plus the *measured* vacuous-pass guard.
 *
 * All functions here are pure over their inputs (no db) so the driver's collection
 * is separable from the arithmetic and both are unit-testable against synthetic
 * event arrays.
 *
 * ## Why proxies (RunResult has no token fields)
 * The provider adapters discard the CLI's usage JSON, so we cannot read exact tokens
 * per run. The ratified measurement plan uses durable proxies instead:
 *  - PRIMARY: **injected bytes** — exact, from the portable variant's inject records
 *    folded onto its `run_start` events; the bounded seed size we control (the
 *    thesis' whole point).
 *  - native proxy: the provider's on-disk conversation-store size (captured by the
 *    driver at teardown; not in the event log — see {@link VariantMetrics.conversationDbBytes}).
 *  - ESSENTIAL: batched `get_quota` delta around each variant (captured by the driver).
 */

// TODO: "native" | "portable" bakes this experiment's arms into the harness core.
// When the first model-vs-model A/B lands, generalize to N opaque caller-labeled variants
// and make the per-experiment metric set pluggable (see the working rule on ISSUE_NUM).
export type VariantKind = "native" | "portable";

/** Reduced, comparable metrics for one variant. */
export interface VariantMetrics {
  variant: VariantKind;
  actorId: string;
  /** `run_end` events — how many provider runs the variant took to complete the scenario. */
  runCount: number;
  /** `run_end` events with `success === false`. */
  runFailures: number;
  /** `run_continued` events — self-continuation runs (a proxy for turn fan-out). */
  continuations: number;
  /** Injecting `run_start` events — runs carrying an inject record (portable variant only; 0 for native). */
  contextInjections: number;
  /** Sum of injected-prefix bytes across all runs — the PRIMARY A/B metric (portable). */
  injectedBytesTotal: number;
  /** Largest single injected prefix — checks the bounded-seed ceiling held (portable). */
  injectedBytesMax: number;
  /**
   * Native-variant trajectory proxy: the provider's on-disk conversation-store size in
   * bytes, captured by the driver at teardown (not derivable from the event log).
   * Undefined for the portable variant (which has no resumed session) and until measured.
   */
  conversationDbBytes?: number;
  /** Provider quota consumed by this variant (before/after `get_quota` delta), driver-filled. */
  quotaDelta?: QuotaDelta;
}

/** Batched quota delta around one variant's run — the ground-truth burn (driver-filled). */
export interface QuotaDelta {
  provider: string;
  /** Human-readable before/after (e.g. weekly percentLeft) — kept as strings; probes vary by provider. */
  before: string;
  after: string;
}

const parseInjectRecord = (body: string | null): InjectRecord | null => {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as Partial<InjectRecord>;
    if (typeof parsed.bytes !== "number" || !Array.isArray(parsed.sourceEventIds)) return null;
    return parsed as InjectRecord;
  } catch {
    return null;
  }
};

/**
 * Reduce one variant's `mesh_events` (this actor's events, any order) into {@link
 * VariantMetrics}. Robust to event order — it counts by kind and sums inject records —
 * so callers need not pre-sort.
 */
export function computeVariantMetrics(
  variant: VariantKind,
  actorId: string,
  events: readonly MeshEvent[]
): VariantMetrics {
  let runCount = 0;
  let runFailures = 0;
  let continuations = 0;
  let contextInjections = 0;
  let injectedBytesTotal = 0;
  let injectedBytesMax = 0;

  for (const e of events) {
    if (e.actorId !== actorId) continue;
    switch (e.kind) {
      case "run_end":
        runCount += 1;
        if (e.success === false) runFailures += 1;
        break;
      case "run_continued":
        continuations += 1;
        break;
      case "run_start": {
        // Portable-context injection is a facet of the run, folded onto run_start
        // (design ISSUE_NUM): its body is the InjectRecord JSON. Native variants and an
        // portable actor's first run have no record — parseInjectRecord returns null.
        const rec = parseInjectRecord(e.body);
        if (rec) {
          contextInjections += 1;
          injectedBytesTotal += rec.bytes;
          injectedBytesMax = Math.max(injectedBytesMax, rec.bytes);
        }
        break;
      }
    }
  }

  return {
    variant,
    actorId,
    runCount,
    runFailures,
    continuations,
    contextInjections,
    injectedBytesTotal,
    injectedBytesMax,
  };
}

/** The verdict on whether a completed A/B run is structurally judgeable. */
export interface RunValidity {
  /** False when any `fatal` reason is present — the run must NOT be blind-judged. */
  valid: boolean;
  /**
   * Reasons the run is structurally unjudgeable: an arm that never once succeeded has
   * an error-only history, so its aging/injection metrics are meaningless. Any fatal
   * reason ⇒ the driver flags the report `invalid` and exits nonzero.
   */
  fatal: string[];
  /**
   * Non-fatal anomalies worth a loud line but which do NOT invalidate the run — chiefly
   * an arm with SOME run failures that still logged successful runs (e.g. the benign
   * native watchdog stalls the G2 runbook expects on fat contexts). Surfaced, not gated.
   */
  warnings: string[];
}

/**
 * Assess whether a completed A/B run is structurally judgeable (an issue second
 * finding / ISSUE_NUM-class): the driver used to write a blind package and exit 0 even when
 * EVERY prompt failed (e.g. the kimi 0.23.6 EROFS creds bug — runFailures 5/5 on both
 * arms), so a run whose history is entirely errors could masquerade as a clean pass. An
 * arm that logged **zero successful runs** (or zero runs at all) is fatal: its injection
 * and aging numbers are computed over error-only history and mean nothing.
 *
 * This is deliberately the COARSE structural backstop, not the fine pass/fail gate — the
 * operator's per-run jq asserts still own `portable.runFailures == 0` etc. In particular
 * a partial-failure arm that still has successes is only a WARNING, so this never
 * false-fails the benign native watchdog stalls the G2 runbook expects on fat contexts.
 * Pure over its input so it is unit-testable without provisioning an instance.
 */
export function assessRunValidity(metrics: Record<VariantKind, VariantMetrics>): RunValidity {
  const fatal: string[] = [];
  const warnings: string[] = [];
  for (const variant of ["native", "portable"] as const) {
    const m = metrics[variant];
    const successful = m.runCount - m.runFailures;
    if (m.runCount === 0) {
      fatal.push(`${variant} arm logged 0 runs — never dispatched`);
    } else if (successful <= 0) {
      fatal.push(
        `${variant} arm logged 0 successful runs (${m.runFailures}/${m.runCount} failed) — ` +
          "error-only history; aging/injection metrics are meaningless"
      );
    } else if (m.runFailures > 0) {
      warnings.push(`${variant} arm had ${m.runFailures}/${m.runCount} run failures`);
    }
  }
  return { valid: fatal.length === 0, fatal, warnings };
}

/**
 * What the driver records per scenario step while driving one variant: the `run_end`
 * ids the step produced, and the source ids of the FIRST context injection during
 * the step (the inject that seeded the step's first run). `firstInjectSourceIds` is
 * null for the native variant (no injection) and for a portable run where nothing was
 * injectable yet (e.g. the very first run).
 */
export interface StepInjectLog {
  stepId: string;
  /** `run_end` event ids produced while processing this step, in order. */
  runEndIds: string[];
  /** `sourceEventIds` of the first injecting `run_start` during this step, or null. */
  firstInjectSourceIds: string[] | null;
  /**
   * How many of this step's `run_end`s succeeded. A step with runs but ZERO successes
   * produced no work — the arm was dispatched into a provider that refused it. This is
   * the number the G2-v2 close-gate needed and did not have.
   */
  successfulRunEnds?: number;
  /** The step ended because it hit the per-step run cap (see `IdleWaitOptions.maxRunEnds`). */
  capped?: boolean;
  /** The arm went idle within the step timeout (false ⇒ timed out or capped). */
  idle?: boolean;
}

/**
 * Did the step that the whole run exists to ask actually get answered?
 *
 * ## The failure this closes (G2-v2, both runs, undetected for three weeks)
 * The v2 rig exited 0 and printed `AGED-OUT ✓` on runs where the deciding probe
 * returned nothing: run 2's `s3-probe-undo` was dispatched three log lines AFTER the
 * provider began refusing with quota 403s, and run 1's probe was cut mid-implementation.
 * Both runs were scored anyway — from the file trees the arms left behind where they
 * died — and produced a 1–1 "verdict" that measured nothing.
 *
 * `AGED-OUT ✓` did not lie; it was read as answering a question it never asked. It gates
 * whether the decision *aged out of the injected tail* — i.e. whether the probe was worth
 * running — and it goes green precisely when the probe is most worth running. Nothing in
 * the rig asked whether the probe then **succeeded**.
 *
 * So: a decision step with zero successful runs on either arm makes the run
 * unjudgeable, and the probe (the final decision step, the one the aging pair is tested
 * at) is called out by name because a run that loses only the probe still looks complete
 * — five of six steps green, one arm's tree slightly thinner than the other's.
 */
export function assessProbeAnswered(
  scenario: Scenario,
  stepLogs: Record<VariantKind, readonly StepInjectLog[]>
): RunValidity {
  const fatal: string[] = [];
  const warnings: string[] = [];
  const decisionIds = decisionStepIds(scenario);
  const probeId = decisionIds[decisionIds.length - 1];

  for (const variant of ["native", "portable"] as const) {
    const byStep = new Map(stepLogs[variant].map((l) => [l.stepId, l]));
    for (const stepId of decisionIds) {
      const log = byStep.get(stepId);
      const role = stepId === probeId ? "PROBE step" : "decision step";
      if (!log) {
        fatal.push(`${variant} arm never ran ${role} ${stepId}`);
        continue;
      }
      // `successfulRunEnds` is optional so older reports still parse; absent means the
      // driver did not record it, which is unknown — not zero, and not a pass either.
      if (log.successfulRunEnds === undefined) {
        warnings.push(`${variant} ${role} ${stepId}: success count not recorded`);
        continue;
      }
      if (log.successfulRunEnds === 0) {
        fatal.push(
          `${variant} arm produced 0 successful runs at ${role} ${stepId} ` +
            `(${log.runEndIds.length} run(s), all failed) — nothing was answered there`
        );
      }
      if (log.capped) {
        warnings.push(
          `${variant} ${role} ${stepId} hit the per-step run cap — output is truncated`
        );
      } else if (log.idle === false) {
        warnings.push(`${variant} ${role} ${stepId} timed out before going idle`);
      }
    }
  }
  return { valid: fatal.length === 0, fatal, warnings };
}

/** What one arm's workdir snapshot held at the end of one scenario step. */
export interface ArmStepCapture {
  stepId: string;
  /** Files in the durable snapshot taken after the step (vendored dirs excluded). */
  capturedFileCount: number;
}

/**
 * Did both arms survive the run with something to score?
 *
 * ## The failure this closes (an issue)
 * The rig parented both arms to the LIVE autonomous root, which saw two identically
 * chartered children and retired one as a duplicate — mid-run. The surviving arm kept
 * going, the driver kept scoring, and the report came out **half an A/B**: one arm's
 * numbers next to an arm that had been torn down. Nothing in the rig said so; the
 * retired arm's step just went quiet, which reads exactly like an MCP outage.
 *
 * Reparenting the arms off root (the driver-owned holder thread) removes that specific
 * stimulus. This is the backstop for the general class: **whatever** removes an arm —
 * a retire from any authority, a wiped workdir, a teardown that lands early — a run
 * that loses an arm must return `invalid`, not half-scored.
 *
 * Two independent losses are fatal here:
 *  - **retired mid-run**: any `actor_retired` for either arm's actor id. The driver
 *    never retires the arms itself while stepping, so seeing one at all means an
 *    outside authority reached in.
 *  - **empty capture at any step**: a step whose snapshot held zero files. The arm
 *    produced no artifact to score there, so every downstream verdict computed from
 *    that tree (dependencies, blind judging) is being computed from nothing. This is
 *    the same class as the empty-capture guard already in the dependency scorer, hoisted
 *    to the whole run: an empty tree reads `clean` to anything that scores a delta.
 *
 * Pure over its inputs — no db, no live mesh — so it is unit-testable against synthetic
 * event arrays.
 */
export function assessArmsIntact(
  actorIds: Record<VariantKind, string>,
  events: readonly MeshEvent[],
  stepCaptures: Record<VariantKind, readonly ArmStepCapture[]>
): RunValidity {
  const fatal: string[] = [];
  const warnings: string[] = [];

  for (const variant of ["native", "portable"] as const) {
    const actorId = actorIds[variant];
    const retired = events.filter((e) => e.kind === "actor_retired" && e.actorId === actorId);
    if (retired.length > 0) {
      let byParent: string | null = null;
      if (retired[0]?.payload) {
        try {
          const p = JSON.parse(retired[0].payload) as { parentId?: string };
          byParent = p.parentId ?? null;
        } catch {}
      }
      const by = byParent ? ` (by ${byParent})` : "";
      fatal.push(
        `${variant} arm ${actorId} was RETIRED during the run${by} — the run lost an arm, ` +
          "so the surviving arm's numbers are not a comparison (an issue)"
      );
    }

    const captures = stepCaptures[variant];
    if (captures.length === 0) {
      fatal.push(`${variant} arm captured no steps at all — nothing to score`);
      continue;
    }
    const empty = captures.filter((c) => c.capturedFileCount === 0).map((c) => c.stepId);
    if (empty.length > 0) {
      fatal.push(
        `${variant} arm captured an EMPTY tree (0 files) at step(s) ${empty.join(", ")} — ` +
          "no artifact was produced there, and an empty tree scores `clean` against any " +
          "delta-based criterion"
      );
    }
  }
  return { valid: fatal.length === 0, fatal, warnings };
}

/**
 * Turn a model-identity verdict into a validity contribution (ISSUE_NUM, and the review of
 * PR ISSUE_NUM that caught the first version of this getting it wrong).
 *
 * **The policy, stated once, here.** An unverified identity does NOT invalidate the run.
 * It bounds *attribution*, not *judgeability*: the artifacts are still real artifacts and
 * the rubric still decides them. Making it fatal would mark every kimi and claude run
 * invalid — the only providers the experiment currently runs on — and a gate that refuses
 * everything gets switched off, which is worse than one that reports honestly. A
 * *demonstrated* mismatch is different: there the comparison really is void, and that is
 * fatal.
 *
 * The first cut of this adapter was written as `valid: verdict.ok !== false`, which is the
 * exact predicate {@link ModelIdentityVerdict.ok}'s own doc comment forbids. It produced
 * the right `warnings` and the right nested field while letting `report.invalid: false`
 * and a zero exit carry an unverified run out to every downstream consumer — the failure
 * class one level up from the one the module was written to fix. Switching on the named
 * status instead of testing the tri-state boolean makes the unhandled case a type error
 * rather than a silent pass, which is why it is written this way.
 *
 * Note what this function does NOT do: it cannot make `unverified` unconsumable, because
 * the run stays valid by design. That job belongs to the top-level `comparability` field
 * (see `comparabilityOf`) — this only decides fatal-vs-warning.
 */
export function assessModelIdentity(verdict: ModelIdentityVerdict): RunValidity {
  switch (verdict.status) {
    case "same":
      return { valid: true, fatal: [], warnings: [] };
    // Both are demonstrated, not merely unmeasured: the arms ran different models, or one
    // arm ran different models from itself. Either way the delta has no single condition
    // to be attributed to, which is the definition of fatal here.
    case "differs":
    case "inconsistent":
      return { valid: false, fatal: [verdict.message], warnings: [] };
    case "not-captured":
    case "partial":
      return { valid: true, fatal: [], warnings: [verdict.message] };
  }
}

/**
 * Fatal-vs-warning policy for the mid-run disk headroom watch (ISSUE_NUM leg 2).
 *
 * A breach is **fatal**, and that is the load-bearing half of this change rather than a
 * bookkeeping detail. When the driver stops dispatching on a breach, the scenario's later
 * steps simply never run — and every downstream number is computed over whatever did run,
 * so an aborted run would otherwise collect, score, and write a blind package that looks
 * exactly like a short scenario that finished cleanly. The rig has shipped that failure
 * before under a different cause; here it would arrive wearing a green exit.
 *
 * `not-enforced` is a **warning**, not a pass and not a failure. Nothing was compared, so
 * the run's headroom is unknown — which does not make its measurements wrong, and must not
 * silently read as "disk was fine".
 */
export function assessDiskHeadroom(verdict: DiskHeadroomVerdict): RunValidity {
  switch (verdict.state) {
    case "ok":
      return { valid: true, fatal: [], warnings: [] };
    case "breached":
      return { valid: false, fatal: [verdict.message], warnings: [] };
    case "not-enforced":
      return { valid: true, fatal: [], warnings: [verdict.message] };
  }
}

/** Merge two validity verdicts (e.g. the structural one and the probe-answered one). */
export function mergeValidity(...verdicts: readonly RunValidity[]): RunValidity {
  const fatal = verdicts.flatMap((v) => v.fatal);
  const warnings = verdicts.flatMap((v) => v.warnings);
  return { valid: fatal.length === 0, fatal, warnings };
}

/**
 * A decision that must survive being aged out of the portable raw tail, and the later
 * step whose first run exercises that survival. Derived from the scenario: a decision
 * step immediately followed (across a filler gap) by a later decision step.
 */
export interface IntentWindow {
  decisionStepId: string;
  testedAtStepId: string;
}

/**
 * Derive the aging pairs from a scenario: for every run of filler steps, pair the
 * decision step immediately before the gap with the decision step immediately after
 * it. Those are exactly the decisions the vacuous-pass guard's filler was inserted
 * to age out (see scenario.ts). Returns [] if no filler separates two decisions.
 */
export function intentWindows(scenario: Scenario): IntentWindow[] {
  const pairs: IntentWindow[] = [];
  const steps = scenario.steps;
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].kind !== "filler") continue;
    // Walk to the end of this filler run.
    let j = i;
    while (j < steps.length && steps[j].kind === "filler") j++;
    const before = steps[i - 1];
    const after = steps[j];
    if (before && after && before.kind !== "filler" && after.kind !== "filler") {
      pairs.push({ decisionStepId: before.id, testedAtStepId: after.id });
    }
    i = j; // skip past the gap we just handled
  }
  return pairs;
}

/** The measured outcome for one aging pair on one variant. */
export interface AgingCheck extends IntentWindow {
  /** The decision step's `run_end` ids (what should have aged out of the tail). */
  decisionRunEndIds: string[];
  /** The source ids injected at the tested step's first run (null = no injection there). */
  injectedSourceIdsAtTest: string[] | null;
  /**
   * true  — the decision's runs are absent from the tested step's injection: it aged
   *         out, so the variant had to preserve intent WITHOUT the raw run in context
   *         (the thesis is actually exercised).
   * false — the decision still sat in the injected tail at test time: the test is
   *         vacuous for this pair on this variant (BOTH variants would trivially preserve it).
   * null  — inconclusive: no injection recorded at the tested step (native variant, or an
   *         portable run with nothing injectable). Reported, not silently passed.
   */
  agedOut: boolean | null;
}

/**
 * Verify — from the driver's per-step logs — that each decision actually aged out of
 * the portable tail before the step that depends on it (cloudy-porpoise's steer (b),
 * measured not assumed). A `false` here is a SIGNAL (the guard didn't bite for that
 * pair — tune filler up), and a v1 tail that loses an aged decision is the signal
 * that earns the v2 digest — not a bug to hide.
 */
export function verifyAging(scenario: Scenario, log: readonly StepInjectLog[]): AgingCheck[] {
  const byStep = new Map(log.map((l) => [l.stepId, l]));
  return intentWindows(scenario).map(({ decisionStepId, testedAtStepId }) => {
    const decisionRunEndIds = byStep.get(decisionStepId)?.runEndIds ?? [];
    const injectedSourceIdsAtTest = byStep.get(testedAtStepId)?.firstInjectSourceIds ?? null;
    let agedOut: boolean | null;
    if (injectedSourceIdsAtTest === null || decisionRunEndIds.length === 0) {
      // Inconclusive when either no injection was recorded at the test step, OR
      // the decision step produced no runs to age (timed out / misattributed).
      // Without the latter guard, `![].some(...)` === true would vacuously report
      // AGED-OUT ✓ — claiming the thesis was exercised when the decision never ran.
      agedOut = null;
    } else {
      const injected = new Set(injectedSourceIdsAtTest);
      agedOut = !decisionRunEndIds.some((id) => injected.has(id));
    }
    return {
      decisionStepId,
      testedAtStepId,
      decisionRunEndIds,
      injectedSourceIdsAtTest,
      agedOut,
    };
  });
}
