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
  /** No arm reported one. Not a pass. */
  | "not-captured"
  /** Some arms reported one and some did not — the arms cannot be compared to each other. */
  | "partial";

export interface ArmModelIdentity {
  /** The provider the arm actually ran on, as recorded in the registry. */
  provider: string | null;
  /**
   * What the arm's runs REPORTED they actually ran on, or null when nothing reported.
   *
   * Read run-scoped, off the arm's `run_end` events — NOT the arm's configured model.
   * Substituting the configured value here would make every arm look measured and turn
   * this whole module into the rubber stamp it exists to prevent.
   */
  model: string | null;
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
  /** Per-arm reported model, verbatim, including the nulls. */
  models: Record<string, string | null>;
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
      return (
        "MODEL IDENTITY MISMATCH: the variants demonstrably ran on different models, so " +
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
  const models = Object.fromEntries(keys.map((k) => [k, arms[k]?.model ?? null]));
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
  const capturedArms = keys.filter((k) => models[k] != null && reportsRunModel(arms[k]?.provider));

  const why = uncapturableArms.length
    ? `no adapter for ${[...new Set(uncapturableArms.map((k) => arms[k]?.provider ?? "unknown"))].join("/")} reports it — only ${MODEL_REPORTING_PROVIDERS.join(", ")} does`
    : "the adapter should populate it but did not — investigate rather than assume";

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
        `${capturedArms.map((k) => `${k}=${models[k]}`).join(", ")} reported one. ` +
        `A comparison needs both sides — this is unknown, not a pass. See ISSUE_NUM.`,
    };
  }

  const distinct = [...new Set(capturedArms.map((k) => models[k] as string))];
  if (distinct.length > 1) {
    return {
      ok: false,
      status: "differs",
      models,
      capturedArms,
      uncapturableArms,
      message:
        `ARMS RAN DIFFERENT MODELS — ${keys.map((k) => `${k}=${models[k]}`).join(", ")}. ` +
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
    message: `model identity verified — all arms ran ${distinct[0]}`,
  };
}
