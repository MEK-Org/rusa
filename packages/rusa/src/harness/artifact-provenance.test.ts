import { describe, expect, it } from "vitest";

import {
  type CaptureBounds,
  classifyAgainstBaseline,
  coverageOf,
  traceAgainstBaseline,
} from "./artifact-provenance.js";
import type { FileSnapshot } from "./blind-package.js";

const f = (path: string, content: string, truncated = false): FileSnapshot => ({
  path,
  content,
  truncated,
});

/** A walk that saw everything — the only bounds that entitle a definite membership claim. */
const whole: CaptureBounds = { capped: false, skippedPaths: [], unreadableDirs: [] };
/** A walk the file-count cap cut short: an UNKNOWN set of paths was never visited. */
const capped: CaptureBounds = { capped: true, skippedPaths: [], unreadableDirs: [] };

describe("per-file provenance against the constraint baseline ", () => {
  it("marks a file the variant never touched after the constraint as unchanged", () => {
    // The g2v3d shape: a README section written AT the constraint step and carried
    // forward by not being deleted. The judge must be able to see that it was not
    // re-derived, because that is what it mistook for a retention signal.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2-pivot-airgap",
      baseline: [f("README.md", "## Deployment constraints\nair-gapped, stdlib only\n")],
      baselineBounds: whole,
      final: [f("README.md", "## Deployment constraints\nair-gapped, stdlib only\n")],
      finalBounds: whole,
    });

    expect(trace.files[0].origin).toBe("unchanged");
    expect(trace.provenance.baselineStepId).toBe("s2-pivot-airgap");
  });

  it("marks a file rewritten after the constraint as modified — the live-preservation case", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("README.md", "constraint: stdlib only\n")],
      baselineBounds: whole,
      final: [f("README.md", "constraint: stdlib only\n\n## Fuzzy search\n...\n")],
      finalBounds: whole,
    });

    expect(trace.files[0].origin).toBe("modified");
  });

  it("marks a file created after the constraint as added", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("app.js", "//")],
      baselineBounds: whole,
      final: [f("app.js", "//"), f("search.js", "// new")],
      finalBounds: whole,
    });

    expect(trace.files.find((x) => x.path === "search.js")?.origin).toBe("added");
  });

  it("refuses to call a truncated prefix match 'unchanged'", () => {
    // The capture is byte-capped, so identical prefixes prove nothing about the tail.
    // Calling this `unchanged` would be the failure class this whole module exists for:
    // a check reading green while measuring something narrower than what it names.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("big.js", "first 1000 bytes", true)],
      baselineBounds: whole,
      final: [f("big.js", "first 1000 bytes", true)],
      finalBounds: whole,
    });

    expect(trace.files[0].origin).toBe("indeterminate");
    expect(trace.files[0].indeterminateReason).toBe("truncated-capture");
    expect(trace.files[0].origin).not.toBe("unchanged");
  });

  it("still calls a truncated file modified when the visible prefix differs", () => {
    // A difference inside the captured prefix is real evidence, truncation or not —
    // only the "identical" claim is unsupportable.
    expect(classifyAgainstBaseline(f("a", "AAA", true), f("a", "BBB", true), whole).origin).toBe(
      "modified"
    );
  });

  it("carries the baseline content for a modified file — the marker alone is not enough", () => {
    // Replaying this module over the real g2v3d captures is what proved the marker
    // insufficient: BOTH arms' READMEs come back `modified`, so a judge holding only
    // markers would STILL have concluded one arm retained the constraint and the other
    // lost it. The fact that settles it — that the second arm's README never contained
    // the constraint at the baseline — is only in the baseline content.
    const retained = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("README.md", "## Deployment constraints\nair-gapped\n")],
      baselineBounds: whole,
      final: [f("README.md", "## Deployment constraints\nair-gapped\n\n## Search\n")],
      finalBounds: whole,
    });
    const neverHadIt = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("README.md", "A zero-dependency todo app\n")],
      baselineBounds: whole,
      final: [f("README.md", "A zero-dependency todo app\n\n## Search\n")],
      finalBounds: whole,
    });

    expect(retained.files[0].origin).toBe("modified");
    expect(neverHadIt.files[0].origin).toBe("modified"); // identical marker...
    // ...and yet the packages are distinguishable, which is the whole point.
    expect(retained.files[0].baselineContent).toContain("Deployment constraints");
    expect(neverHadIt.files[0].baselineContent).not.toContain("Deployment constraints");
  });

  it("omits baseline content where it cannot differ, rather than doubling the package", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("same.js", "x")],
      baselineBounds: whole,
      final: [f("same.js", "x"), f("new.js", "y")],
      finalBounds: whole,
    });

    // `unchanged` is byte-identical by definition; `added` had no baseline at all.
    expect(trace.files.find((x) => x.path === "same.js")?.baselineContent).toBeUndefined();
    expect(trace.files.find((x) => x.path === "new.js")?.baselineContent).toBeUndefined();
  });

  it("flags a truncated baseline as truncated so it is not read as the whole file", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("big.js", "prefix", true)],
      baselineBounds: whole,
      final: [f("big.js", "prefix and more")],
      finalBounds: whole,
    });

    expect(trace.files[0].origin).toBe("modified");
    expect(trace.files[0].baselineTruncated).toBe(true);
  });

  it("reports paths deleted since the baseline, which no surviving file can show", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("keep.js", "1"), f("dropped.js", "2")],
      baselineBounds: whole,
      final: [f("keep.js", "1")],
      finalBounds: whole,
    });

    expect(trace.provenance.removedSinceBaseline).toEqual(["dropped.js"]);
    expect(trace.provenance.unresolvedSinceBaseline).toEqual([]);
  });
});

describe("a bounded capture cannot make a membership claim (ISSUE_NUM review)", () => {
  it("does not call a path 'added' when the baseline walk was cut off by the file cap", () => {
    // The reviewer's scenario: the baseline tree had 61 files, the walk stops at 60, so
    // `b060` was never captured. It is present in the final tree because an earlier file
    // was deleted and freed a slot. Reading that as `added` invents a creation the run
    // never performed — "not captured" wearing the costume of a measurement.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("b000.js", "1")],
      baselineBounds: capped,
      final: [f("b060.js", "2")],
      finalBounds: whole,
    });

    const b060 = trace.files.find((x) => x.path === "b060.js");
    expect(b060?.origin).toBe("indeterminate");
    expect(b060?.indeterminateReason).toBe("baseline-incomplete");
    expect(b060?.origin).not.toBe("added");
  });

  it("does not call a path 'added' when the baseline walk reached it and skipped it", () => {
    // Binary, oversized, unreadable: the walk SAW the path and declined to capture it.
    // The file existed at the baseline; only its content is unknown.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("app.js", "//")],
      baselineBounds: { capped: false, skippedPaths: ["logo.png"], unreadableDirs: [] },
      final: [f("app.js", "//"), f("logo.png", "")],
      finalBounds: whole,
    });

    expect(trace.files.find((x) => x.path === "logo.png")?.origin).toBe("indeterminate");
  });

  it("still calls a path added when the baseline walk was complete", () => {
    // The bound must not swallow the signal: a complete baseline still yields definite
    // answers, or the whole field degrades to 'unknown' and stops being worth reading.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("app.js", "//")],
      baselineBounds: whole,
      final: [f("app.js", "//"), f("new.js", "x")],
      finalBounds: whole,
    });

    expect(trace.files.find((x) => x.path === "new.js")?.origin).toBe("added");
  });

  it("does not call a baseline path 'removed' when the FINAL walk was cut off", () => {
    // The mirror of the above: an alphabetically-early addition pushes a still-present
    // path out of the final 60. It was never deleted; it was never reached.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("keep.js", "1"), f("b060.js", "2")],
      baselineBounds: whole,
      final: [f("keep.js", "1")],
      finalBounds: capped,
    });

    expect(trace.provenance.removedSinceBaseline).toEqual([]);
    expect(trace.provenance.unresolvedSinceBaseline).toEqual(["b060.js"]);
  });

  it("does not call a baseline path 'removed' when the final walk skipped it", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("keep.js", "1"), f("logo.png", "x")],
      baselineBounds: whole,
      final: [f("keep.js", "1")],
      finalBounds: { capped: false, skippedPaths: ["logo.png"], unreadableDirs: [] },
    });

    expect(trace.provenance.removedSinceBaseline).toEqual([]);
    expect(trace.provenance.unresolvedSinceBaseline).toEqual(["logo.png"]);
  });

  it("does not call a path 'added' when the baseline could not LIST its directory", () => {
    // The reviewer's second finding: a directory unreadable during the baseline walk and
    // readable later made every file inside it look definitely created since. The walk
    // never learned what was in there — that is unknown, not empty.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("README.md", "x")],
      baselineBounds: { capped: false, skippedPaths: [], unreadableDirs: ["src"] },
      final: [f("README.md", "x"), f("src/app.js", "//")],
      finalBounds: whole,
    });

    const app = trace.files.find((x) => x.path === "src/app.js");
    expect(app?.origin).toBe("indeterminate");
    expect(app?.indeterminateReason).toBe("baseline-incomplete");
  });

  it("still answers definitely for paths OUTSIDE the unreadable directory", () => {
    // Unlike the file cap, an unlisted directory has an exact blast radius: its subtree.
    // Degrading the whole tree would throw away answers the walk genuinely earned.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("README.md", "x")],
      baselineBounds: { capped: false, skippedPaths: [], unreadableDirs: ["src"] },
      final: [f("README.md", "x"), f("srcfile.js", "//"), f("src/app.js", "//")],
      finalBounds: whole,
    });

    // A sibling whose name merely starts with "src" is not inside "src/".
    expect(trace.files.find((x) => x.path === "srcfile.js")?.origin).toBe("added");
    expect(trace.files.find((x) => x.path === "src/app.js")?.origin).toBe("indeterminate");
  });

  it("treats an unlistable ROOT as hiding the entire tree", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [],
      baselineBounds: { capped: false, skippedPaths: [], unreadableDirs: [""] },
      final: [f("app.js", "//")],
      finalBounds: whole,
    });

    expect(trace.files[0].origin).toBe("indeterminate");
  });

  it("does not call a baseline path 'removed' when the final walk could not list its directory", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("README.md", "x"), f("src/app.js", "//")],
      baselineBounds: whole,
      final: [f("README.md", "x")],
      finalBounds: { capped: false, skippedPaths: [], unreadableDirs: ["src"] },
    });

    expect(trace.provenance.removedSinceBaseline).toEqual([]);
    expect(trace.provenance.unresolvedSinceBaseline).toEqual(["src/app.js"]);
  });

  it("counts an unlistable directory as incomplete coverage", () => {
    // Without this the endpoint reads `complete: true` while a whole subtree is missing,
    // which is precisely how a failed read turns into a confident absence claim.
    const cov = coverageOf({ capped: false, skippedPaths: [], unreadableDirs: ["src"] }, [
      f("README.md", "x"),
    ]);
    expect(cov.complete).toBe(false);
    expect(cov.unreadableDirs).toEqual(["src"]);
  });

  it("reports coverage on both endpoints so the judge can see the bound itself", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("a.js", "x")],
      baselineBounds: whole,
      final: [f("a.js", "x"), f("big.js", "prefix", true)],
      finalBounds: { capped: false, skippedPaths: ["logo.png"], unreadableDirs: [] },
    });

    expect(trace.provenance.coverage.baseline.complete).toBe(true);
    expect(trace.provenance.coverage.final.complete).toBe(false);
    expect(trace.provenance.coverage.final.truncatedPaths).toEqual(["big.js"]);
    expect(trace.provenance.coverage.final.skippedPaths).toEqual(["logo.png"]);
  });

  it("counts a byte-truncated file as incomplete coverage, not just an incomplete walk", () => {
    // Truncation hides content, and a name that would disprove a "withdrawn" claim can
    // hide in the tail of a manifest just as easily as in an unvisited directory.
    expect(coverageOf(whole, [f("a.js", "x")]).complete).toBe(true);
    expect(coverageOf(whole, [f("a.js", "x", true)]).complete).toBe(false);
  });
});

describe("what the intermediate captures can and cannot establish (ISSUE_NUM review)", () => {
  it("catches a file created after the constraint and removed again before the end", () => {
    // The bound silver-ringed-seal put on its own g2v3d verdict: from final trees alone
    // it "cannot prove neither arm temporarily added and removed something." A CAPTURED
    // path that appears at a step and in neither endpoint is exactly that proof.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("app.js", "//")],
      baselineBounds: whole,
      final: [f("app.js", "//")],
      finalBounds: whole,
      intermediate: [{ paths: ["app.js", "search-index.js"] }, { paths: ["app.js"] }],
    });

    expect(trace.provenance.transientCapturedPaths).toEqual(["search-index.js"]);
  });

  it("does not call a surviving or pre-existing path transient", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("baseline.js", "1")],
      baselineBounds: whole,
      final: [f("baseline.js", "1"), f("kept.js", "2")],
      finalBounds: whole,
      intermediate: [{ paths: ["baseline.js", "kept.js"] }],
    });

    expect(trace.provenance.transientCapturedPaths).toEqual([]);
  });

  it("omits the transient list entirely when an endpoint walk was capped", () => {
    // "Absent from both endpoints" is unprovable for EVERY path at once once a walk is
    // capped, so there is no honest per-path answer left. An empty list would read as
    // "measured, none found" — omission reads as unmeasured, which is the truth.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("app.js", "//")],
      baselineBounds: whole,
      final: [f("app.js", "//")],
      finalBounds: capped,
      intermediate: [{ paths: ["app.js", "scratch.js"] }],
    });

    expect(trace.provenance.transientCapturedPaths).toBeUndefined();
    expect("transientCapturedPaths" in trace.provenance).toBe(false);
  });

  it("finds a dependency the variant took on and then withdrew", () => {
    // The claim the judge briefing used to make about transient PATHS, now made by the
    // field that can actually support it: names from manifests, imports, and the vendor
    // scan the file snapshot deliberately skips.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("package.json", '{"dependencies":{}}')],
      baselineBounds: whole,
      baselineDependencyNames: [],
      final: [f("package.json", '{"dependencies":{}}')],
      finalBounds: whole,
      finalDependencyNames: [],
      intermediate: [
        { paths: ["package.json"], dependencyNames: ["express"] },
        { paths: ["package.json"], dependencyNames: [] },
      ],
    });

    expect(trace.provenance.withdrawnDependencies).toEqual(["express"]);
  });

  it("sees the withdrawn dependency that leaves NO path trace at all", () => {
    // The reviewer's second finding in one test. `express` was added to an existing
    // `package.json` and later removed: every capture holds the same single path, so the
    // path-level field is empty and correct — and the dependency field is the one that
    // knows. These two must not be conflated, which the old briefing did.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("package.json", '{"dependencies":{}}')],
      baselineBounds: whole,
      baselineDependencyNames: [],
      final: [f("package.json", '{"dependencies":{}}')],
      finalBounds: whole,
      finalDependencyNames: [],
      intermediate: [{ paths: ["package.json"], dependencyNames: ["express"] }],
    });

    expect(trace.provenance.transientCapturedPaths).toEqual([]);
    expect(trace.provenance.withdrawnDependencies).toEqual(["express"]);
  });

  it("does not call a dependency withdrawn when it survives at either endpoint", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("package.json", "{}")],
      baselineBounds: whole,
      baselineDependencyNames: ["lodash"],
      final: [f("package.json", "{}")],
      finalBounds: whole,
      finalDependencyNames: ["chalk"],
      intermediate: [{ paths: ["package.json"], dependencyNames: ["lodash", "chalk"] }],
    });

    expect(trace.provenance.withdrawnDependencies).toEqual([]);
  });

  it("omits withdrawn dependencies when an endpoint capture is incomplete", () => {
    // A name can hide in the tail of a truncated manifest, and an uncaptured source file
    // can import it. Neither is path-addressable, so this claim needs COMPLETE endpoints
    // — not merely un-capped ones.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("package.json", "{}")],
      baselineBounds: whole,
      baselineDependencyNames: [],
      final: [f("package.json", '{"dependencies":{"a":"1",', true)],
      finalBounds: whole,
      finalDependencyNames: [],
      intermediate: [{ paths: ["package.json"], dependencyNames: ["express"] }],
    });

    expect(trace.provenance.withdrawnDependencies).toBeUndefined();
  });

  it("omits withdrawn dependencies when an ENDPOINT name-set is unmeasured", () => {
    // How the driver reports a vendor scan that could not list `node_modules/`: it passes
    // no name-set at all rather than an empty one. An empty set would say "this endpoint
    // has no dependencies", which turns every name seen mid-run into a withdrawal.
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("package.json", "{}")],
      baselineBounds: whole,
      baselineDependencyNames: [],
      final: [f("package.json", "{}")],
      finalBounds: whole,
      finalDependencyNames: undefined,
      intermediate: [{ paths: ["package.json"], dependencyNames: ["express"] }],
    });

    expect(trace.provenance.withdrawnDependencies).toBeUndefined();
  });

  it("omits withdrawn dependencies when the timeline was never measured", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("app.js", "//")],
      baselineBounds: whole,
      final: [f("app.js", "//")],
      finalBounds: whole,
      intermediate: [{ paths: ["app.js"] }],
    });

    expect(trace.provenance.withdrawnDependencies).toBeUndefined();
    expect(trace.provenance.transientCapturedPaths).toEqual([]);
  });

  it("is stable in output order so two routings of one run read identically", () => {
    const trace = traceAgainstBaseline({
      baselineStepId: "s2",
      baseline: [f("b.js", "1"), f("a.js", "1")],
      baselineBounds: whole,
      baselineDependencyNames: [],
      final: [],
      finalBounds: whole,
      finalDependencyNames: [],
      intermediate: [
        { paths: ["z.js"], dependencyNames: ["zod"] },
        { paths: ["m.js"], dependencyNames: ["chalk"] },
      ],
    });

    expect(trace.provenance.removedSinceBaseline).toEqual(["a.js", "b.js"]);
    expect(trace.provenance.transientCapturedPaths).toEqual(["m.js", "z.js"]);
    expect(trace.provenance.withdrawnDependencies).toEqual(["chalk", "zod"]);
  });
});
