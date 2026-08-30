import { describe, expect, it } from "vitest";

import { assessModelIdentity, mergeValidity } from "./ab-metrics.js";
import {
  checkModelIdentity,
  comparabilityCaveat,
  comparabilityOf,
  MODEL_REPORTING_PROVIDERS,
  reportsRunModel,
} from "./model-identity.js";

const TWO_NULLS = {
  native: { provider: "kimi", models: [] },
  portable: { provider: "kimi", models: [] },
};
const SAME = {
  native: { provider: "codex", models: ["gpt-5.5-codex"] },
  portable: { provider: "codex", models: ["gpt-5.5-codex"] },
};
const DIFFERS = {
  native: { provider: "codex", models: ["gpt-5.5-codex"] },
  portable: { provider: "codex", models: ["gpt-5.1-codex"] },
};

describe("model identity across A/B arms ", () => {
  it("reports NOT CAPTURED — never a pass — when neither arm reported a bound model", () => {
    // This is the g2v3d shape verbatim: kimi on both sides, nothing reported on either.
    const verdict = checkModelIdentity({
      native: { provider: "kimi", models: [] },
      portable: { provider: "kimi", models: [] },
    });

    expect(verdict.status).toBe("not-captured");
    // The whole point: null, NOT true. A caller writing `ok !== false` must not get a pass.
    expect(verdict.ok).toBeNull();
    expect(verdict.ok).not.toBe(true);
    expect(verdict.capturedArms).toEqual([]);
  });

  it("says out loud that matching nulls are absence of evidence", () => {
    const { message } = checkModelIdentity({
      native: { provider: "kimi", models: [] },
      portable: { provider: "kimi", models: [] },
    });

    expect(message).toContain("NOT CAPTURED");
    expect(message).toContain("UNVERIFIED, not verified");
    expect(message).toContain("absence of evidence");
    // and points at the remedy rather than leaving the reader to rediscover it
    expect(message).toContain("ISSUE_NUM");
  });

  it("names the reason as a missing adapter feature, not a failed read", () => {
    const { message, uncapturableArms } = checkModelIdentity({
      native: { provider: "kimi", models: [] },
      portable: { provider: "kimi", models: [] },
    });

    expect(uncapturableArms).toEqual(["native", "portable"]);
    expect(message).toContain("no adapter for kimi reports it");
    expect(message).toContain("only codex does");
  });

  it("distinguishes an unexplained null on a provider that CAN capture", () => {
    // codex reports the model it ran, so a null here is a real anomaly worth investigating —
    // a different diagnosis from kimi's structural absence, and worded differently.
    const { message, uncapturableArms } = checkModelIdentity({
      native: { provider: "codex", models: [] },
      portable: { provider: "codex", models: [] },
    });

    expect(uncapturableArms).toEqual([]);
    expect(message).toContain("investigate rather than assume");
  });

  it("verifies identity only when both arms actually reported the same model", () => {
    const verdict = checkModelIdentity({
      native: { provider: "codex", models: ["gpt-5.5-codex"] },
      portable: { provider: "codex", models: ["gpt-5.5-codex"] },
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.status).toBe("same");
    expect(verdict.message).toContain("model identity verified");
  });

  it("voids the comparison when the arms demonstrably bound different models", () => {
    const verdict = checkModelIdentity({
      native: { provider: "codex", models: ["gpt-5.5-codex"] },
      portable: { provider: "codex", models: ["gpt-5.1-codex"] },
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe("differs");
    expect(verdict.message).toContain("ARMS RAN DIFFERENT MODELS");
    expect(verdict.message).toContain("void");
    // both sides named, so the reader doesn't have to open the report to see which is which
    expect(verdict.message).toContain("native=gpt-5.5-codex");
    expect(verdict.message).toContain("portable=gpt-5.1-codex");
  });

  it("voids the run when ONE arm did not run a single model throughout", () => {
    // The counterexample this state exists for: codex re-pins on tier escalation, so a
    // multi-step arm can run A for its first steps and B for the rest. Collapsing that
    // to either end makes the report claim the whole arm ran one model — and here the
    // collapse would land on the OTHER arm's value, producing a clean `same ✓` for a run
    // in which half the native arm ran something else entirely.
    const verdict = checkModelIdentity({
      native: { provider: "codex", models: ["gpt-5.5-codex", "gpt-5.1-codex"] },
      portable: { provider: "codex", models: ["gpt-5.1-codex"] },
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe("inconsistent");
    expect(verdict.message).toContain("ARM CHANGED MODELS MID-RUN");
    // named in the order they ran, so the reader can see it moved rather than just that
    // two values exist
    expect(verdict.message).toContain("native ran gpt-5.5-codex then gpt-5.1-codex");
    expect(comparabilityOf(verdict)).toBe("void");
  });

  it("calls a mid-run change void even when the other arm never reported", () => {
    // Ordering matters here: this shape is ALSO `partial` (portable never reported), and
    // partial is only a warning. A demonstrated change must not be downgraded into an
    // unmeasured one by the arm that happens to be unmeasurable.
    const verdict = checkModelIdentity({
      native: { provider: "codex", models: ["gpt-5.5-codex", "gpt-5.1-codex"] },
      portable: { provider: "kimi", models: [] },
    });

    expect(verdict.status).toBe("inconsistent");
    expect(assessModelIdentity(verdict).valid).toBe(false);
    expect(assessModelIdentity(verdict).fatal).toHaveLength(1);
  });

  it("does not read a repeated model as a change", () => {
    // Six steps all reporting the same model is the ordinary healthy shape; only DISTINCT
    // values count, or every long arm would void itself.
    const verdict = checkModelIdentity({
      native: { provider: "codex", models: ["gpt-5.5-codex"] },
      portable: { provider: "codex", models: ["gpt-5.5-codex"] },
    });

    expect(verdict.status).toBe("same");
    expect(verdict.ok).toBe(true);
  });

  it("tells the judge WHICH kind of mismatch it was", () => {
    // Both statuses are `void`, but "the variants ran different models" is a false
    // description of a run where one variant ran two — and the judge is told to refuse
    // the package either way, so the sentence has to be true.
    const inconsistent = comparabilityCaveat(
      checkModelIdentity({
        native: { provider: "codex", models: ["gpt-5.5-codex", "gpt-5.1-codex"] },
        portable: { provider: "codex", models: ["gpt-5.1-codex"] },
      })
    );

    expect(inconsistent).toContain("did not run a single model throughout");
    expect(comparabilityCaveat(checkModelIdentity(DIFFERS))).toContain(
      "demonstrably ran on different models"
    );
    // still blind — the caveat travels with the package
    expect(inconsistent).not.toContain("native");
    expect(inconsistent).not.toContain("portable");
  });

  it("treats one-sided capture as unknown, not as a match", () => {
    const verdict = checkModelIdentity({
      native: { provider: "codex", models: ["gpt-5.5-codex"] },
      portable: { provider: "kimi", models: [] },
    });

    expect(verdict.status).toBe("partial");
    expect(verdict.ok).toBeNull();
    expect(verdict.capturedArms).toEqual(["native"]);
    expect(verdict.message).toContain("unknown, not a pass");
  });

  it("keeps the raw per-arm values so the report shows the nulls rather than hiding them", () => {
    const { models } = checkModelIdentity({
      native: { provider: "kimi", models: [] },
      portable: { provider: "kimi", models: ["kimi-k2.5"] },
    });

    expect(models).toEqual({ native: [], portable: ["kimi-k2.5"] });
  });

  it("refuses to call two matching CONFIGURED models a measurement", () => {
    // The failure the field rename made reachable. `boundModel` could only ever hold a
    // read-back, so a non-null value WAS a measurement. `model` is one careless caller
    // away from the arm's configured model — which is non-null on every arm and equal on
    // both whenever the run pinned a model, i.e. exactly when a false "same ✓" is most
    // tempting. Both arms here look fully populated and must still read NOT CAPTURED.
    const verdict = checkModelIdentity({
      native: { provider: "kimi", models: ["kimi-k2.5"] },
      portable: { provider: "kimi", models: ["kimi-k2.5"] },
    });

    expect(verdict.ok).toBeNull();
    expect(verdict.status).toBe("not-captured");
    expect(verdict.capturedArms).toEqual([]);
    // The values are still reported verbatim — refusing the inference is not the same as
    // hiding the data a reader needs to see why.
    expect(verdict.models).toEqual({ native: ["kimi-k2.5"], portable: ["kimi-k2.5"] });
    expect(comparabilityOf(verdict)).toBe("unverified");
  });

  it("knows exactly which providers capture — codex today, nothing else", () => {
    expect([...MODEL_REPORTING_PROVIDERS]).toEqual(["codex"]);
    expect(reportsRunModel("codex")).toBe(true);
    expect(reportsRunModel("kimi")).toBe(false);
    expect(reportsRunModel("claude")).toBe(false);
    // an unknown/absent provider starts out non-capturing, which is the truth
    expect(reportsRunModel(null)).toBe(false);
    expect(reportsRunModel(undefined)).toBe(false);
  });
});

/**
 * These cover the hole silver-ringed-seal found in the first cut of ISSUE_NUM: the leaf
 * function was correct and every test above passed, while the DRIVER's adapter turned
 * `ok: null` back into a pass on the surfaces anyone actually reads. Testing the leaf in
 * isolation could not see it, so these test the composition.
 */
describe("what an unverified identity does to the run's verdict", () => {
  it("does NOT invalidate the run — unverified bounds attribution, not judgeability", () => {
    const validity = mergeValidity(assessModelIdentity(checkModelIdentity(TWO_NULLS)));

    // Deliberate: every kimi/claude run lands here, and a gate that refuses everything
    // gets switched off. The run stays judgeable...
    expect(validity.valid).toBe(true);
    expect(validity.fatal).toEqual([]);
    // ...but never silently.
    expect(validity.warnings).toHaveLength(1);
    expect(validity.warnings[0]).toContain("NOT CAPTURED");
  });

  it("says so on the surface a consumer actually reads, not only in a nested field", () => {
    // The whole point of the top-level `comparability`: `invalid: false` is the pass
    // surface, and on this path it IS false, so the bound has to be visible beside it.
    const validity = mergeValidity(assessModelIdentity(checkModelIdentity(TWO_NULLS)));
    expect(validity.valid).toBe(true);
    expect(comparabilityOf(checkModelIdentity(TWO_NULLS))).toBe("unverified");
  });

  it("voids the run when the arms demonstrably differ — that one IS fatal", () => {
    const validity = mergeValidity(assessModelIdentity(checkModelIdentity(DIFFERS)));

    expect(validity.valid).toBe(false);
    expect(validity.fatal).toHaveLength(1);
    expect(validity.fatal[0]).toContain("ARMS RAN DIFFERENT MODELS");
    expect(comparabilityOf(checkModelIdentity(DIFFERS))).toBe("void");
  });

  it("stays quiet when identity is verified", () => {
    const validity = mergeValidity(assessModelIdentity(checkModelIdentity(SAME)));

    expect(validity).toEqual({ valid: true, fatal: [], warnings: [] });
    expect(comparabilityOf(checkModelIdentity(SAME))).toBe("verified");
    // no unconditional caveat — noise is how a real one gets skimmed past
    expect(comparabilityCaveat(checkModelIdentity(SAME))).toBeNull();
  });

  it("hands the judge a caveat that bounds attribution without naming an arm", () => {
    const caveat = comparabilityCaveat(checkModelIdentity(TWO_NULLS));

    expect(caveat).toContain("MODEL IDENTITY UNVERIFIED");
    expect(caveat).toContain("NOT safe to attribute");
    // blind: the package this goes into must not identify the arms
    expect(caveat).not.toContain("native");
    expect(caveat).not.toContain("portable");
  });

  it("caveats the one-sided case too — partial capture is not verification", () => {
    const partial = checkModelIdentity({
      native: { provider: "codex", models: ["gpt-5.5-codex"] },
      portable: { provider: "kimi", models: [] },
    });

    expect(comparabilityOf(partial)).toBe("unverified");
    expect(comparabilityCaveat(partial)).toContain("MODEL IDENTITY UNVERIFIED");
    expect(assessModelIdentity(partial).fatal).toEqual([]);
    expect(assessModelIdentity(partial).warnings).toHaveLength(1);
  });
});
