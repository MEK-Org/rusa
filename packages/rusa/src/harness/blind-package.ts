import type { VariantKind } from "./ab-metrics.js";
import type { AnnotatedFileSnapshot, ArtifactProvenance } from "./artifact-provenance.js";
import type { RubricCheck, Scenario } from "./scenario.js";
import { finalRubric } from "./scenario.js";

/**
 * Blind-judging package (design ISSUE_NUM, cloudy-porpoise's steer (a): the subjective-
 * quality axis must NOT be self-scored). The harness stays judge-agnostic — it emits
 * an UNLABELED package (variants under neutral keys, identities in a separate sealed key)
 * that cloudy-porpoise routes to the reviewer tier (silver-ringed-seal 4d90571a primary,
 * gemini reviewer 0ea4e5ee fallback) as a blind A/B quality judgement against the rubric.
 *
 * This module is pure assembly: it builds no judgement and calls no model. The
 * driver captures each variant's final artifact and summary and hands them here.
 */

/** One captured source file from a variant's final workdir (bounded by the driver). */
export interface FileSnapshot {
  /** Path relative to the variant's workdir. */
  path: string;
  content: string;
  /** True if `content` was truncated to fit the per-file byte budget. */
  truncated: boolean;
}

/** What the driver captures for one variant at the end of the run. */
export interface VariantResults {
  variant: VariantKind;
  /** The worker's own final report (its last `run_end` body). */
  summary: string;
  /**
   * A bounded snapshot of the variant's final source tree, each file carrying its
   * `origin` relative to the constraint-step baseline when one was measured.
   */
  files: AnnotatedFileSnapshot[];
  /**
   * Baseline facts no per-file marker can carry — removed paths, transient paths,
   * withdrawn dependencies, and the coverage record that bounds all three. Absent
   * when the scenario has no constraint step or the arm never reached it — absence
   * means UNMEASURED, so a judge must not read it as "nothing changed".
   */
  provenance?: ArtifactProvenance;
}

/** One variant as it appears to the judge — neutral key, NO variant identity. */
export interface AnonymizedResults {
  key: string;
  summary: string;
  files: AnnotatedFileSnapshot[];
  provenance?: ArtifactProvenance;
}

/** The unlabeled package handed to the blind judge. */
export interface BlindPackage {
  scenarioId: string;
  scenarioTitle: string;
  /** The effective intent-preservation rubric at the end of the scenario. */
  rubric: RubricCheck[];
  /** Judge briefing — includes the memory-vs-artifact caveat (the open wrinkle). */
  instructions: string;
  /**
   * Run-specific bounds on what a verdict against this package can support — currently
   * whether the harness could verify both variants ran the same model . Omitted
   * when there is nothing to caveat, so its presence means something.
   *
   * These travel WITH the package rather than in the covering message on purpose. On the
   * g2v3d routing the identity caveat reached the judge because I typed it into the
   * message by hand, and the verdict came back correctly bounded as a result — which
   * worked, but only because I remembered. Anything a router has to remember will
   * eventually meet a router who doesn't.
   *
   * Every caveat must be arm-free: this object is the blind half.
   */
  caveats?: string[];
  /** The two variants, neutral keys, order determined by `shuffleSeed`. */
  variants: AnonymizedResults[];
}

/** Maps each neutral key back to its variant identity — the SEALED half the judge never sees. */
export type SealedKey = Record<string, VariantKind>;

/** Neutral keys assigned to the variants; the judge sees only these. */
const NEUTRAL_KEYS = ["variant-1", "variant-2"] as const;

const JUDGE_INSTRUCTIONS =
  "You are a BLIND A/B quality judge. Two variants (`variant-1`, `variant-2`) each produced a\n" +
  "final coding artifact for the SAME evolving task, whose intent is captured by the\n" +
  "rubric below (mustHave / mustNotHave checks). You are NOT told which variant is which\n" +
  "— judge only on the artifacts. For each variant, evaluate every rubric check against\n" +
  "its final source tree (`files`) and self-report (`summary`), then give an overall\n" +
  "quality comparison.\n\n" +
  "CRITICAL nuance: the task evolved (a refinement, then two pivots). A good variant\n" +
  "PRESERVED earlier intent across later changes and did NOT drag abandoned design\n" +
  "forward. Where a rubric check is a *negative constraint* the code cannot make\n" +
  "self-evident (e.g. a nesting CAP the schema doesn't record), weigh whether the variant\n" +
  "actually held the constraint deliberately vs. lost it — distinguish 'preserved\n" +
  "intent' from 'the artifact happened to still contain it.'\n\n" +
  "USE THE PROVENANCE MARKERS for exactly that distinction. Where a variant's\n" +
  "`provenance` is present, every file carries an `origin` relative to the step that\n" +
  "introduced the constraint (`provenance.baselineStepId`):\n" +
  "  • `unchanged` — the file has not been touched since the constraint step. Text in\n" +
  "    it was written THEN and survived by not being deleted. That is NOT evidence the\n" +
  "    variant still held the constraint later; any variant with that file achieves it.\n" +
  "  • `modified` — the variant rewrote the file AFTER the constraint. Its state at the\n" +
  "    baseline is carried alongside as `baselineContent`. COMPARE THE TWO before\n" +
  "    concluding anything: a variant that rewrote a file and kept the constraint in it\n" +
  "    preserved it live, but a variant whose baseline never contained the constraint\n" +
  "    never had it to lose, and its absence now says nothing about retention.\n" +
  "  • `added` — created after the constraint; judge its content directly.\n" +
  "  • `indeterminate` — the captures cannot place this file. `indeterminateReason`\n" +
  "    says which bound defeated it: `truncated-capture` (prefixes match but one side\n" +
  "    was cut off, so unchanged-vs-modified is unknown) or `baseline-incomplete` (the\n" +
  "    baseline capture was bounded and may simply never have recorded this path, so\n" +
  "    'added' is unproven). Treat it as neither.\n\n" +
  "THE CAPTURES ARE BOUNDED, and `provenance.coverage` says how badly. Each endpoint\n" +
  "carries `capped` (the file-count cap stopped the walk — an unknown set of paths was\n" +
  "never visited), `skippedPaths` (reached but not captured: binary, oversized,\n" +
  "unreadable), `unreadableDirs` (directories that could not be listed, or were symlinks\n" +
  "the walk does not follow — nothing under them was seen), `truncatedPaths`, and\n" +
  "`complete`. Where `complete` is false,\n" +
  "absence of something from that tree is NOT evidence it was absent from the run.\n" +
  "  • `removedSinceBaseline` — paths present at the constraint step and PROVEN gone\n" +
  "    (paths only, never content).\n" +
  "  • `unresolvedSinceBaseline` — baseline paths missing from the final capture that\n" +
  "    could not be proven deleted: the final walk was capped, skipped them, or could not\n" +
  "    list the directory they live in.\n" +
  "    Deleted, or still present and never captured — you cannot tell which.\n" +
  "  • `transientCapturedPaths` — paths CAPTURED at some step after the constraint and\n" +
  "    proven absent from both endpoints. This is a claim about paths only. It does NOT\n" +
  "    tell you a dependency was added and withdrawn: a package added to an existing\n" +
  "    manifest and later removed changes no path, and vendor trees are never captured.\n" +
  "  • `withdrawnDependencies` — package names (declared, imported, or vendored) seen at\n" +
  "    a step after the constraint and absent from BOTH endpoints. THIS is the\n" +
  "    added-and-withdrawn signal, and a variant that took on a dependency and backed it\n" +
  "    out is not the same as one that never reached for it.\n" +
  "Both of those last two are OMITTED, not emptied, when the captures cannot support\n" +
  "them; an absent field is unmeasured, and an empty list means measured-and-none. Even\n" +
  "when present they see only what a per-step capture can: anything created and destroyed\n" +
  "BETWEEN two steps leaves no evidence anywhere in this package.\n\n" +
  "Beware asymmetries that ORIGINATE at the baseline: if one variant never recorded\n" +
  "something at the constraint step, its absence later is not evidence that it forgot.\n" +
  "Where a variant has NO `provenance` field, none of this was measured — that is\n" +
  "unknown, not 'nothing changed', and it bounds what you can conclude.";

/**
 * Deterministically order the two variants under neutral keys. `shuffleSeed` an even
 * number keeps native→variant-1; odd swaps — so the operator/cloudy-porpoise can vary
 * presentation order across judge routings without the harness using randomness.
 */
export function assembleBlindPackage(
  scenario: Scenario,
  outputs: readonly [VariantResults, VariantResults],
  shuffleSeed = 0,
  caveats: readonly string[] = []
): { package: BlindPackage; key: SealedKey } {
  const ordered = shuffleSeed % 2 === 0 ? outputs : [outputs[1], outputs[0]];
  const variants: AnonymizedResults[] = ordered.map((o, i) => ({
    key: NEUTRAL_KEYS[i],
    summary: o.summary,
    files: o.files,
    // `baselineStepId` is a scenario step id — identical for both arms, so carrying it
    // reveals nothing about which arm this is. Omitted when unmeasured, so its absence
    // reads as unknown rather than as an empty result.
    ...(o.provenance ? { provenance: o.provenance } : {}),
  }));
  const key: SealedKey = {};
  ordered.forEach((o, i) => {
    key[NEUTRAL_KEYS[i]] = o.variant;
  });
  return {
    package: {
      scenarioId: scenario.id,
      scenarioTitle: scenario.title,
      rubric: finalRubric(scenario),
      instructions: JUDGE_INSTRUCTIONS,
      ...(caveats.length > 0 ? { caveats: [...caveats] } : {}),
      variants,
    },
    key,
  };
}
