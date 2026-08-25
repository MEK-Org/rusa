import { describe, expect, it } from "vitest";

import { assessModelIdentity, mergeValidity } from "./ab-metrics.js";
import {
  BOUND_MODEL_CAPTURE_PROVIDERS,
  capturesBoundModel,
  checkModelIdentity,
  comparabilityCaveat,
  comparabilityOf,
} from "./model-identity.js";

const TWO_NULLS = {
  native: { provider: "kimi", boundModel: null },
  portable: { provider: "kimi", boundModel: null },
};
const SAME = {
  native: { provider: "codex", boundModel: "gpt-5.5-codex" },
  portable: { provider: "codex", boundModel: "gpt-5.5-codex" },
};
const DIFFERS = {
  native: { provider: "codex", boundModel: "gpt-5.5-codex" },
  portable: { provider: "codex", boundModel: "gpt-5.1-codex" },
};

describe("model identity across A/B arms ", () => {
  it("reports NOT CAPTURED — never a pass — when neither arm reported a bound model", () => {
    // This is the g2v3d shape verbatim: kimi on both sides, boundModel null on both.
    const verdict = checkModelIdentity({
      native: { provider: "kimi", boundModel: null },
      portable: { provider: "kimi", boundModel: null },
    });

    expect(verdict.status).toBe("not-captured");
    // The whole point: null, NOT true. A caller writing `ok !== false` must not get a pass.
    expect(verdict.ok).toBeNull();
    expect(verdict.ok).not.toBe(true);
    expect(verdict.capturedArms).toEqual([]);
  });

  it("says out loud that matching nulls are absence of evidence", () => {
    const { message } = checkModelIdentity({
      native: { provider: "kimi", boundModel: null },
      portable: { provider: "kimi", boundModel: null },
    });

    expect(message).toContain("NOT CAPTURED");
    expect(message).toContain("UNVERIFIED, not verified");
    expect(message).toContain("absence of evidence");
    // and points at the remedy rather than leaving the reader to rediscover it
    expect(message).toContain("ISSUE_NUM");
  });

  it("names the reason as a missing adapter feature, not a failed read", () => {
    const { message, uncapturableArms } = checkModelIdentity({
      native: { provider: "kimi", boundModel: null },
      portable: { provider: "kimi", boundModel: null },
    });

    expect(uncapturableArms).toEqual(["native", "portable"]);
    expect(message).toContain("no adapter for kimi populates it");
    expect(message).toContain("only codex does");
  });

  it("distinguishes an unexplained null on a provider that CAN capture", () => {
    // codex populates boundModel, so a null here is a real anomaly worth investigating —
    // a different diagnosis from kimi's structural absence, and worded differently.
    const { message, uncapturableArms } = checkModelIdentity({
      native: { provider: "codex", boundModel: null },
      portable: { provider: "codex", boundModel: null },
    });

    expect(uncapturableArms).toEqual([]);
    expect(message).toContain("investigate rather than assume");
  });

  it("verifies identity only when both arms actually reported the same model", () => {
    const verdict = checkModelIdentity({
      native: { provider: "codex", boundModel: "gpt-5.5-codex" },
      portable: { provider: "codex", boundModel: "gpt-5.5-codex" },
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.status).toBe("same");
    expect(verdict.message).toContain("model identity verified");
  });

  it("voids the comparison when the arms demonstrably bound different models", () => {
    const verdict = checkModelIdentity({
      native: { provider: "codex", boundModel: "gpt-5.5-codex" },
      portable: { provider: "codex", boundModel: "gpt-5.1-codex" },
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.status).toBe("differs");
    expect(verdict.message).toContain("ARMS BOUND DIFFERENT MODELS");
    expect(verdict.message).toContain("void");
    // both sides named, so the reader doesn't have to open the report to see which is which
    expect(verdict.message).toContain("native=gpt-5.5-codex");
    expect(verdict.message).toContain("portable=gpt-5.1-codex");
  });

  it("treats one-sided capture as unknown, not as a match", () => {
    const verdict = checkModelIdentity({
      native: { provider: "codex", boundModel: "gpt-5.5-codex" },
      portable: { provider: "kimi", boundModel: null },
    });

    expect(verdict.status).toBe("partial");
    expect(verdict.ok).toBeNull();
    expect(verdict.capturedArms).toEqual(["native"]);
    expect(verdict.message).toContain("unknown, not a pass");
  });

  it("keeps the raw per-arm values so the report shows the nulls rather than hiding them", () => {
    const { boundModels } = checkModelIdentity({
      native: { provider: "kimi", boundModel: null },
      portable: { provider: "kimi", boundModel: "kimi-k2.5" },
    });

    expect(boundModels).toEqual({ native: null, portable: "kimi-k2.5" });
  });

  it("knows exactly which providers capture — codex today, nothing else", () => {
    expect([...BOUND_MODEL_CAPTURE_PROVIDERS]).toEqual(["codex"]);
    expect(capturesBoundModel("codex")).toBe(true);
    expect(capturesBoundModel("kimi")).toBe(false);
    expect(capturesBoundModel("claude")).toBe(false);
    // an unknown/absent provider starts out non-capturing, which is the truth
    expect(capturesBoundModel(null)).toBe(false);
    expect(capturesBoundModel(undefined)).toBe(false);
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
    expect(validity.fatal[0]).toContain("ARMS BOUND DIFFERENT MODELS");
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
      native: { provider: "codex", boundModel: "gpt-5.5-codex" },
      portable: { provider: "kimi", boundModel: null },
    });

    expect(comparabilityOf(partial)).toBe("unverified");
    expect(comparabilityCaveat(partial)).toContain("MODEL IDENTITY UNVERIFIED");
    expect(assessModelIdentity(partial).fatal).toEqual([]);
    expect(assessModelIdentity(partial).warnings).toHaveLength(1);
  });
});
