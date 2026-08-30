/**
 * "Did both arms run the same model?" — and, more importantly, whether anyone actually
 * looked (design ISSUE_NUM, an issue).
 *
 * ## The bug this module exists to make visible
 * The G2-v3 runbook says: *if the two arms ran different models, the comparison is void
 * regardless of everything else.* That is the right rule. But the model a run reports is
 * populated by exactly ONE provider adapter — `codex.ts`. `claude.ts` and `kimi.ts` never
 * report one, so on kimi and claude the value is `null` on BOTH arms, `null === null`
 * holds, and the check passes.
 *
 * It passes on **absence of evidence**. The run that prompted this (`g2v3d`, 2026-08-06)
 * recorded a clean `null / null` and I read it as "same model on both arms ✓" — which the
 * data cannot support. The honest statement is *"model-identity
 * equivalence across arms is UNVERIFIED"*, and the operator-facing surface has to say
 * that out loud, because a green field launders it back into a pass on the next read.
 *
 * That is this arc's recurring failure class — `AGED-OUT ✓` gating age-out rather than
 * probe-answered, the kimi `authRe` matching the panel's own empty-state line, the
 * free-space gate `statfs`-ing a path that does not exist yet — a check that reads green
 * while measuring something other than what it names. The distinguishing property of the
 * fix is always the same: make "not measured" a THIRD state that cannot be mistaken for
 * a pass. Here that is {@link ModelIdentityVerdict.ok} `=== null`, mirroring the
 * window-fit gate's `capacityRuns: null` and the disk gate's `NOT ENFORCED`.
 *
 * ## What this does NOT do
 * It does not measure anything. Making kimi/claude actually report the model they ran is a
 * provider-adapter change (set `model` on the run result, which `start.ts` already carries
 * onto the `run_end` event) and is tracked separately on ISSUE_NUM. Until then this module's
 * whole job is to stop the absence from reading as a result.
 *
 * The fallback argument — "same provider, same host, same 25 minutes, therefore the same
 * default model" — is an argument, not a measurement, and it has a hole: the kimi CLI
 * self-upgraded 0.32.0 → 0.33.0 mid-experiment. Do not encode it here as a pass.
 */

/**
 * Providers whose adapter actually reports back which model a run ran on.
 *
 * Deliberately a whitelist of what is KNOWN to report, not a blacklist of what is known
 * not to: a provider added tomorrow starts out non-reporting, which is the truth, rather
 * than silently inheriting a claim nobody checked. Keep in sync with the adapters that
 * set `model` on their run result (currently only `providers/codex.ts`).
 */
export const MODEL_REPORTING_PROVIDERS: readonly string[] = ["codex"];

export type ModelIdentityStatus =
  /** Every arm reported a model and they all match. */
  | "same"
  /** Every arm reported a model and at least two differ — the comparison is void. */
  | "differs"
  /**
   * At least one arm's OWN runs reported more than one model, so that arm has no single
   * "what it ran" to put on its side of the comparison — the run is void.
   */
  | "inconsistent"
  /** No arm reported one. Not a pass. */
  | "not-captured"
  /** Some arms reported one and some did not — the arms cannot be compared to each other. */
  | "partial";

/**
 * How many of an arm's runs reported a model, out of how many ran.
 *
 * An ANNOTATION on the reading, never an input to it: no branch in
 * {@link checkModelIdentity} reads these numbers, and the verdict is identical with and
 * without them (asserted). That is deliberate. Reporting is best-effort per run —
 * `captureModel` returns nothing whenever there is no sessions dir, no session id, no
 * rollout file, or an unparseable one — so a six-step arm has six chances to go quiet,
 * and downgrading the verdict on any silent run would make the gate read UNVERIFIED
 * nearly always. A gate that is always red carries no information and gets switched off,
 * which is the failure `ab-metrics.ts` already refuses to walk into.
 *
 * What incomplete coverage genuinely means is that the evidence is thinner than the
 * verdict's wording implies — so it is surfaced as a COUNT for a human to weigh, rather
 * than spent on a verdict the data cannot support in either direction.
 */
export interface RunModelCoverage {
  /** Runs that reported a model. */
  reported: number;
  /** Runs the arm ran at all. */
  total: number;
}

export interface ArmModelIdentity {
  /** The provider the arm actually ran on, as recorded in the registry. */
  provider: string | null;
  /**
   * Every DISTINCT model the arm's runs REPORTED they actually ran on, in the order
   * first seen; empty when nothing reported.
   *
   * Read run-scoped, off the arm's `run_end` events — NOT the arm's configured model.
   * Substituting the configured value here would make every arm look measured and turn
   * this whole module into the rubber stamp it exists to prevent.
   *
   * A LIST rather than one value because an arm is not guaranteed to be internally
   * consistent. An arm runs once per scenario step, and codex re-pins on tier
   * escalation, so a six-step arm can report A for three steps and B for the rest.
   * Collapsing that to a single string — first or last — makes the report claim the
   * whole arm ran a model that half of it did not, and then `same ✓` compares two claims
   * neither of which is true. Empty stays the module's third state: nothing reported,
   * which is not a pass.
   */
  models: readonly string[];
  /**
   * How much of the arm was actually looked at. Optional because it only annotates the
   * message — a caller with no run history (a unit fixture, a caller holding models from
   * somewhere else) still gets the same verdict, just without the coverage clause.
   */
  coverage?: RunModelCoverage;
}

export interface ModelIdentityVerdict {
  /**
   * `true` only when every arm reported a model AND they match; `false` when they
   * demonstrably differ; **`null` when nobody measured**. Callers must treat `null` as
   * "unknown" — `ok !== false` is NOT a pass, and any code written that way reintroduces
   * exactly the bug this module was written for.
   */
  ok: boolean | null;
  status: ModelIdentityStatus;
  /** Per-arm reported models, verbatim, including the empties. */
  models: Record<string, readonly string[]>;
  /** Arm keys whose reading counts as a measurement. */
  capturedArms: string[];
  /**
   * Arm keys whose provider's adapter cannot produce one at all — so their `null` is a
   * missing FEATURE, not a failed read. Named separately because the remedy differs:
   * these need a provider-adapter change, an unexplained null needs investigating.
   */
  uncapturableArms: string[];
  /** One-liner for the launch log, the report, and the refusal. */
  message: string;
}

/**
 * What the run's arms-are-comparable claim actually rests on. Written to the TOP of
 * `ab-report.json`, beside `invalid`, rather than nested inside `provenance`.
 *
 * The nesting mattered: silver-ringed-seal's review of PR ISSUE_NUM pointed out that a
 * consumer reading the driver's established pass surfaces — exit status, `report.invalid`
 * — sees a clean pass on an unverified run, and has to know to go dig for
 * `provenance.modelIdentity.ok`. A caveat nobody encounters is not a caveat.
 *
 * - `verified` — measured, and the arms match.
 * - `unverified` — NOT measured. The run is still judgeable (see
 *   {@link comparabilityCaveat}); what it cannot support is attributing a delta to the
 *   condition under test.
 * - `void` — measured, and the arms differ. The run is invalid.
 */
export type Comparability = "verified" | "unverified" | "void";

export function comparabilityOf(verdict: ModelIdentityVerdict): Comparability {
  switch (verdict.status) {
    case "same":
      return "verified";
    case "differs":
    case "inconsistent":
      return "void";
    case "not-captured":
    case "partial":
      return "unverified";
  }
}

/**
 * The caveat that has to travel WITH the artifact to the blind judge, arm-free so it
 * cannot unblind anything.
 *
 * On the g2v3d routing I typed this caveat into the covering message by hand, and the
 * judge's verdict came back correctly bounded because of it. That is not a mechanism —
 * it worked because I remembered. Putting it in the package makes it survive a router
 * who doesn't.
 *
 * Returns null when identity is verified: an unconditional caveat is noise, and noise is
 * how a real one gets skimmed past.
 */
export function comparabilityCaveat(verdict: ModelIdentityVerdict): string | null {
  switch (comparabilityOf(verdict)) {
    case "verified":
      return null;
    case "unverified":
      return (
        "MODEL IDENTITY UNVERIFIED: the harness could not read back which model each " +
        "variant actually ran on, so it cannot show that both variants used the same one. " +
        "Judge the artifacts as given — but if you report a quality delta, it is NOT safe " +
        "to attribute it solely to the condition under test."
      );
    case "void":
      // Still one decision point — comparability — but two ways to reach it, and the
      // judge needs to know which. "The variants ran different models" would be a false
      // description of a run where BOTH variants ran the same set, one of them twice.
      return (
        (verdict.status === "inconsistent"
          ? "MODEL IDENTITY MISMATCH: at least one variant did not run a single model " +
            "throughout — it reported more than one across its own steps, so "
          : "MODEL IDENTITY MISMATCH: the variants demonstrably ran on different " +
            "models, so ") +
        "no delta between them can be attributed to the condition under test. This " +
        "package should not have been routed."
      );
  }
}

/** Whether `provider`'s adapter reports the model a run ran on at all. */
export function reportsRunModel(provider: string | null | undefined): boolean {
  return provider != null && MODEL_REPORTING_PROVIDERS.includes(provider);
}

/**
 * Compare the models the arms reported, distinguishing "same", "differs", and "nobody
 * looked".
 *
 * The message for the not-captured cases is worded to be alarming rather than
 * reassuring, on the disk gate's precedent: an operator skimming the log for a red flag
 * must not skim past the line that says the comparability claim is unbacked.
 */
export function checkModelIdentity(arms: Record<string, ArmModelIdentity>): ModelIdentityVerdict {
  const keys = Object.keys(arms);
  const models: Record<string, readonly string[]> = Object.fromEntries(
    keys.map((k) => [k, arms[k]?.models ?? []])
  );
  const uncapturableArms = keys.filter((k) => !reportsRunModel(arms[k]?.provider));
  // An arm counts as MEASURED only if it reported a model AND its provider is one that
  // reports models at all. The second half is the load-bearing one now: while this field
  // was called `boundModel` a non-null value could only have come from a read-back, so
  // its presence was self-evidently a measurement. Called `model`, it is one careless
  // caller away from the arm's CONFIGURED model — which is non-null on every arm, would
  // make every run look measured, and would turn "both arms were pinned to the same
  // string" into "both arms ran the same model ✓". That inference is the one this module
  // exists to refuse, so the whitelist refuses it structurally rather than by convention.
  //
  // Cost, stated: an adapter that starts reporting without being added to
  // MODEL_REPORTING_PROVIDERS has its readings ignored and the run reads NOT CAPTURED.
  // That is the safe direction — loud, honest, one array entry to fix — and it is the
  // same bet the whitelist already makes by being a whitelist.
  const capturedArms = keys.filter(
    (k) => models[k].length > 0 && reportsRunModel(arms[k]?.provider)
  );

  const why = uncapturableArms.length
    ? `no adapter for ${[...new Set(uncapturableArms.map((k) => arms[k]?.provider ?? "unknown"))].join("/")} reports it — only ${MODEL_REPORTING_PROVIDERS.join(", ")} does`
    : "the adapter should populate it but did not — investigate rather than assume";

  // Checked FIRST — before the absence cases and before comparing the arms to each
  // other — because an arm whose own runs disagree has no single value to put on its
  // side of that comparison, so every verdict below it would be computed from a number
  // that does not exist. Positive evidence of voidness also outranks a missing reading
  // on the other arm: a run where one side changed models mid-experiment is void whether
  // or not the other side was ever measured, and reporting it as `partial` (a warning)
  // would downgrade a demonstrated defect into an unmeasured one.
  const inconsistentArms = capturedArms.filter((k) => models[k].length > 1);
  if (inconsistentArms.length > 0) {
    return {
      ok: false,
      status: "inconsistent",
      models,
      capturedArms,
      uncapturableArms,
      message:
        `ARM CHANGED MODELS MID-RUN — ${inconsistentArms
          .map((k) => `${k} ran ${models[k].join(" then ")}`)
          .join("; ")}. The comparison is void regardless of everything else: an arm ` +
        `that did not run one model throughout has no single model to attribute its ` +
        `half of the delta to.`,
    };
  }

  if (capturedArms.length === 0) {
    return {
      ok: null,
      status: "not-captured",
      models,
      capturedArms,
      uncapturableArms,
      message:
        `model identity NOT CAPTURED — no arm reported a model (${why}). ` +
        `"Both arms ran the same model" is UNVERIFIED, not verified: matching nulls are ` +
        `absence of evidence. Do NOT read this as a pass — see ISSUE_NUM.`,
    };
  }

  if (capturedArms.length < keys.length) {
    const missing = keys.filter((k) => !capturedArms.includes(k));
    return {
      ok: null,
      status: "partial",
      models,
      capturedArms,
      uncapturableArms,
      message:
        `model identity NOT CAPTURED on ${missing.join(", ")} (${why}) while ` +
        `${capturedArms.map((k) => `${k}=${models[k][0]}`).join(", ")} reported one. ` +
        `A comparison needs both sides — this is unknown, not a pass. See ISSUE_NUM.`,
    };
  }

  // Safe to index [0]: `inconsistent` returned above, so every captured arm has
  // exactly one reported model by the time control reaches here.
  const distinct = [...new Set(capturedArms.map((k) => models[k][0] as string))];
  if (distinct.length > 1) {
    return {
      ok: false,
      status: "differs",
      models,
      capturedArms,
      uncapturableArms,
      message:
        `ARMS RAN DIFFERENT MODELS — ${keys.map((k) => `${k}=${models[k][0] ?? "null"}`).join(", ")}. ` +
        `The comparison is void regardless of everything else: a quality delta between the ` +
        `arms cannot be attributed to the context regime.`,
    };
  }

  return {
    ok: true,
    status: "same",
    models,
    capturedArms,
    uncapturableArms,
    message: `model identity ${sameMessage(distinct[0] as string, keys, arms)}`,
  };
}

/**
 * The `same` verdict's wording, qualified by how much of the arms was actually read.
 *
 * The unqualified sentence — "verified — all arms ran X" — is a claim about EVERY run,
 * and an arm runs once per scenario step. When some of those runs reported nothing, the
 * evidence covers the runs that spoke, not the arm. Saying so in the line the operator
 * actually reads is the honest instrument; the alternative on offer was to force the
 * verdict to `unverified` on any silent run, which fires on an ordinary rollout-read
 * hiccup and trains the reader to skip this line entirely.
 *
 * The silent runs are called UNMEASURED rather than a mismatch on purpose: nothing
 * contradicts X (a contradiction is caught above, as `inconsistent` or `differs`), and
 * equally nothing rules out a silent run having run something else. Both halves have to
 * be said, or the count reads as either a false alarm or a rubber stamp.
 */
function sameMessage(
  model: string,
  keys: readonly string[],
  arms: Record<string, ArmModelIdentity>
): string {
  const covered = keys.filter((k) => arms[k]?.coverage != null);
  if (covered.length < keys.length) return `verified — all arms ran ${model}`;

  const counts = covered
    .map((k) => `${k} ${arms[k]?.coverage?.reported}/${arms[k]?.coverage?.total}`)
    .join(", ");
  const complete = covered.every((k) => arms[k]?.coverage?.reported === arms[k]?.coverage?.total);
  return complete
    ? `verified — all arms ran ${model}, and every run reported (${counts})`
    : `verified ON THE RUNS THAT REPORTED — those ran ${model} (${counts}). The silent ` +
        `runs are UNMEASURED, not confirmed: nothing contradicts ${model}, and nothing ` +
        `rules out a silent run having run something else.`;
}
