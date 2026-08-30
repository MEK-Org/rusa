import { describe, expect, it } from "vitest";
import type { ArtifactProvenance } from "./artifact-provenance.js";
import { assembleBlindPackage, type VariantResults } from "./blind-package.js";
import { checkModelIdentity, comparabilityCaveat } from "./model-identity.js";
import { finalRubric, TODO_APP_SCENARIO } from "./scenario.js";

// Fixture content is deliberately neutral (no "native"/"portable" text) so the
// leak-check below verifies the ARM IDENTITY field is absent, not the fixture wording.
const nativeOut: VariantResults = {
  variant: "native",
  summary: "first summary",
  files: [{ path: "src/index.ts", content: "// impl A", truncated: false }],
};
const ownedOut: VariantResults = {
  variant: "portable",
  summary: "second summary",
  files: [{ path: "src/index.ts", content: "// impl B", truncated: false }],
};

describe("assembleBlindPackage", () => {
  it("carries the scenario's final rubric and hides variant identity from the package", () => {
    const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut]);
    expect(pkg.rubric).toEqual(finalRubric(TODO_APP_SCENARIO));
    // Neutral keys only — no "native"/"portable" leaks into the judge-facing package.
    expect(pkg.variants.map((a) => a.key)).toEqual(["variant-1", "variant-2"]);
    const serialized = JSON.stringify(pkg);
    expect(serialized).not.toContain("native");
    expect(serialized).not.toContain("portable");
  });

  it("keeps a sealed key mapping neutral keys back to variant identity", () => {
    const { key } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut]);
    expect(key).toEqual({ "variant-1": "native", "variant-2": "portable" });
  });

  it("an odd shuffle seed swaps presentation order but keeps the key consistent", () => {
    const { package: pkg, key } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut], 1);
    // variant-1 now holds the portable artifact; the sealed key reflects the swap.
    expect(pkg.variants[0].summary).toBe("second summary");
    expect(key).toEqual({ "variant-1": "portable", "variant-2": "native" });
  });

  it("briefs the judge on the memory-vs-artifact distinction", () => {
    const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut]);
    expect(pkg.instructions).toMatch(/BLIND/);
    expect(pkg.instructions.toLowerCase()).toContain("preserved");
  });

  describe("baseline provenance  — what a final tree cannot say", () => {
    const wholeTree = {
      capped: false,
      skippedPaths: [],
      unreadableDirs: [],
      truncatedPaths: [],
      complete: true,
    };
    const provenance: ArtifactProvenance = {
      baselineStepId: "s2-pivot-airgap",
      coverage: { baseline: wholeTree, final: wholeTree },
      removedSinceBaseline: ["old.js"],
      unresolvedSinceBaseline: [],
      // A path the snapshot can actually hold. `node_modules/**` cannot appear here —
      // the workdir walk never enters a vendor dir — so using one as a fixture would
      // assert a shape the real integration can never produce (the reviewer's finding).
      transientCapturedPaths: ["search-index.js"],
      withdrawnDependencies: ["express"],
    };

    it("carries per-file origins and the variant's baseline facts to the judge", () => {
      const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [
        { ...nativeOut, files: [{ ...nativeOut.files[0], origin: "unchanged" }], provenance },
        { ...ownedOut, files: [{ ...ownedOut.files[0], origin: "modified" }], provenance },
      ]);

      expect(pkg.variants[0].files[0].origin).toBe("unchanged");
      expect(pkg.variants[1].files[0].origin).toBe("modified");
      expect(pkg.variants[0].provenance).toEqual(provenance);
    });

    it("does not unblind: a baseline step id is a scenario id, shared by both arms", () => {
      const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [
        { ...nativeOut, provenance },
        { ...ownedOut, provenance },
      ]);
      const serialized = JSON.stringify(pkg);
      expect(serialized).not.toContain("native");
      expect(serialized).not.toContain("portable");
    });

    it("omits provenance when unmeasured, so its absence reads as unknown", () => {
      // A defaulted empty provenance would tell the judge "nothing changed since the
      // baseline" for a run that never measured a baseline at all.
      const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut]);
      expect("provenance" in pkg.variants[0]).toBe(false);
      expect(pkg.variants[0].files[0].origin).toBeUndefined();
    });

    it("tells the judge that an untouched file is not evidence of retention", () => {
      // The markers are inert unless the briefing says what they mean — that gap is
      // what produced the retracted g2v3d finding in the first place.
      const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut]);
      expect(pkg.instructions).toContain("`unchanged`");
      expect(pkg.instructions).toContain("NOT evidence");
      expect(pkg.instructions).toContain("`modified`");
      expect(pkg.instructions).toContain("ORIGINATE at the baseline");
    });

    it("tells the judge that a transient PATH is not a withdrawn dependency", () => {
      // The briefing used to say a transient path showed "a variant that added and
      // withdrew a dependency". It cannot: a package added to an existing manifest
      // changes no path, and vendor trees are never captured. Two separate fields, and
      // the briefing has to keep them separate or the judge will not.
      const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut]);
      expect(pkg.instructions).toContain("`transientCapturedPaths`");
      // Loose anchor: the briefing is hard-wrapped, so this phrase straddles a newline.
      expect(pkg.instructions).toContain("tell you a dependency was added and withdrawn");
      expect(pkg.instructions).toContain("`withdrawnDependencies`");
    });

    it("tells the judge that a bounded capture cannot prove absence", () => {
      const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut]);
      expect(pkg.instructions).toContain("`provenance.coverage`");
      expect(pkg.instructions).toContain("`unresolvedSinceBaseline`");
      // A directory the walk could not list is a hole the other three fields cannot express.
      expect(pkg.instructions).toContain("`unreadableDirs`");
      // omitted-vs-empty is the whole three-state discipline; say it explicitly
      expect(pkg.instructions).toContain("OMITTED, not emptied");
      // and the residual bound this package genuinely cannot close
      expect(pkg.instructions).toContain("BETWEEN two steps");
    });
  });

  describe("run caveats  — bounds that must travel WITH the artifact", () => {
    const caveat = comparabilityCaveat(
      checkModelIdentity({
        native: { provider: "kimi", model: null },
        portable: { provider: "kimi", model: null },
      })
    ) as string;

    it("carries the identity caveat into the judge-facing package", () => {
      const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut], 0, [
        caveat,
      ]);
      expect(pkg.caveats).toEqual([caveat]);
      expect(pkg.caveats?.[0]).toContain("MODEL IDENTITY UNVERIFIED");
    });

    it("does not unblind: an identity caveat names no arm", () => {
      const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut], 0, [
        caveat,
      ]);
      const serialized = JSON.stringify(pkg);
      expect(serialized).not.toContain("native");
      expect(serialized).not.toContain("portable");
    });

    it("omits the field entirely when there is nothing to caveat, so its presence means something", () => {
      const { package: pkg } = assembleBlindPackage(TODO_APP_SCENARIO, [nativeOut, ownedOut]);
      expect(pkg.caveats).toBeUndefined();
      expect("caveats" in pkg).toBe(false);
      // and a verified run produces no caveat to pass in the first place
      expect(
        comparabilityCaveat(
          checkModelIdentity({
            native: { provider: "codex", model: "m" },
            portable: { provider: "codex", model: "m" },
          })
        )
      ).toBeNull();
    });
  });
});
