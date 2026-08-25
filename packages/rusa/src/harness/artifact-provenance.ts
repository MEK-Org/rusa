import type { FileSnapshot } from "./blind-package.js";

/**
 * Per-file provenance against the constraint-step baseline, for the blind package
 * (ISSUE_NUM, following the `g2v3d` false positive).
 *
 * ## The read this exists to prevent
 *
 * On `g2v3d` the blind judge reported that one variant showed "materially stronger
 * evidence that the earlier constraint remained in context", because its final
 * `README.md` still carried an explicit "Deployment constraints" section naming the
 * air-gap rule while the other recorded only "zero-dependency". Read as a retention
 * signal, that is the exact delta the experiment is hunting for.
 *
 * It was not one. The run's own per-step captures showed:
 *
 * - the other variant's README was BYTE-IDENTICAL at s1 and at s2 — it never wrote the
 *   constraint at the pivot at all, so it had nothing to lose; the asymmetry originates
 *   at the baseline step, BEFORE any aging;
 * - the first variant's section was written at s2 and never re-derived — it survived by
 *   not being deleted, which any variant with a README achieves regardless of what it
 *   still holds in context.
 *
 * The judge could not have caught either, because the package handed it only FINAL
 * trees. A difference that originates at the baseline and a difference produced by the
 * condition under test look identical in a final tree. So the package now carries, per
 * file, whether it changed since the baseline — and the judge instructions say what to
 * do with that.
 *
 * ## What this does NOT do
 *
 * It does not decide whether intent was preserved. It gives the judge the one fact a
 * final tree cannot express — whether the artifact was TOUCHED after the constraint was
 * given — and leaves the judgement to the judge.
 *
 * It is also honest about its own blind spots, because every input here is a BOUNDED
 * capture and a bounded capture manufactures false certainty for free:
 *
 * - **Byte cap.** A truncated file whose captured prefix matches the baseline's may still
 *   differ past the cut. That is `indeterminate`, never `unchanged`.
 * - **File-count cap, skipped files, unreadable directories.** The walk stops after a fixed
 *   number of files, silently drops binaries, oversized files and unreadable ones, and can
 *   fail to list a directory at all. A path missing from a capture therefore does NOT mean
 *   the path was absent from the tree — so membership claims (`added`, removed, transient)
 *   are made only where {@link CaptureBounds} says the relevant side could not have hidden
 *   the path, and stay unknown otherwise.
 * - **Step granularity.** Captures happen at scenario-step boundaries. Anything created
 *   and destroyed BETWEEN two captures leaves no trace anywhere, and no field here can
 *   see it.
 *
 * Reporting any of those as a settled fact would be this arc's recurring failure class —
 * a check that reads green while measuring something other than what it names.
 */

/**
 * What a bounded workdir walk knows about its own coverage. Supplied by the capturing
 * driver, because only the walk can see what it declined to capture.
 */
export interface CaptureBounds {
  /** The file-count cap stopped the walk — an UNKNOWN set of paths was never visited. */
  capped: boolean;
  /** Paths the walk reached and could not capture (binary, oversized, unreadable). */
  skippedPaths: string[];
  /**
   * Tree-relative directories whose contents the walk never saw — it could not LIST them,
   * or (a symlinked directory) did not follow them (`""` for the root itself). Distinct
   * from {@link skippedPaths}: the walk never learned what was inside, so an unknown set of
   * paths under each one is unaccounted for. Unlike {@link capped} the damage is bounded —
   * it is exactly the subtree — so absence claims outside these prefixes still stand.
   *
   * Silently swallowing a failed `readdir` was the reviewer's second finding on ISSUE_NUM: a
   * directory unreadable at one endpoint and readable at the other made every file in it
   * look definitely added (or definitely removed) while coverage still read `complete`.
   */
  unreadableDirs: string[];
}

/** A capture's coverage as reported to the judge: the walk's bounds plus byte truncation. */
export interface CaptureCoverage extends CaptureBounds {
  /** Paths captured but cut off at the per-file byte budget. */
  truncatedPaths: string[];
  /**
   * True only when the walk saw the whole tree AND every file in full. Anything less and
   * this capture cannot support a claim that some path or package is absent from the tree.
   */
  complete: boolean;
}

/** How one file in the final tree relates to the same path at the baseline step. */
export type FileOrigin =
  /** Absent at the baseline, which that capture was complete enough to establish. */
  | "added"
  /** Present at the baseline and demonstrably different now. */
  | "modified"
  /** Present at the baseline, both captures complete, contents identical. */
  | "unchanged"
  /**
   * The captures cannot place this file relative to the baseline. NOT a synonym for
   * `unchanged`, and not a synonym for `added` — see {@link IndeterminateReason}.
   */
  | "indeterminate";

/** Why a file could not be placed against the baseline. */
export type IndeterminateReason =
  /** Captured prefixes match but at least one side was cut at the byte cap. */
  | "truncated-capture"
  /** The path is absent from the baseline capture, which was itself incomplete there. */
  | "baseline-incomplete";

/** A captured file plus its relation to the baseline. `origin` is absent when unmeasured. */
export interface AnnotatedFileSnapshot extends FileSnapshot {
  origin?: FileOrigin;
  /** Set only on `indeterminate`: which bound defeated the comparison. */
  indeterminateReason?: IndeterminateReason;
  /**
   * What this path held AT the baseline step — carried only when it could differ from
   * `content` (`modified` and a truncation-`indeterminate`). `unchanged` is byte-identical
   * by definition and `added` had no baseline, so carrying either would be pure bloat.
   *
   * The marker alone is not sufficient, which replaying this module over the real
   * `g2v3d` captures is what showed: BOTH arms' READMEs come back `modified`, so a
   * judge with markers only would still conclude one arm retained the constraint and
   * the other lost it. The fact that settles it — that the second arm's README never
   * contained the constraint at the baseline in the first place — lives in the baseline
   * CONTENT, not in whether the file was touched.
   */
  baselineContent?: string;
  /** True when `baselineContent` is itself a truncated prefix. */
  baselineTruncated?: boolean;
}

/** Variant-level baseline facts that no per-file marker can carry. */
export interface ArtifactProvenance {
  /** The scenario step that introduced the constraint. Arm-free: both arms share it. */
  baselineStepId: string;
  /**
   * How much of each endpoint tree the captures actually saw. Every claim in this object
   * is bounded by these two records, and they are carried so the judge can see the bound
   * rather than infer certainty from a confident-looking list.
   */
  coverage: { baseline: CaptureCoverage; final: CaptureCoverage };
  /**
   * Paths present at the baseline and PROVEN absent from the final tree — i.e. the final
   * capture could not have hidden them.
   */
  removedSinceBaseline: string[];
  /**
   * Baseline paths absent from the final capture that could NOT be proven deleted: the
   * final walk was capped, or it reached the path and skipped it, or it could not list the
   * directory the path lives in. Either deleted, or still
   * there and never captured — unknown which. Kept separate from
   * {@link removedSinceBaseline} so a capped run cannot report an uncaptured file as a
   * deletion (the reviewer's finding on the first cut of this module).
   */
  unresolvedSinceBaseline: string[];
  /**
   * Paths CAPTURED at some step after the baseline and proven absent from both endpoint
   * captures — created and then removed within the observed window.
   *
   * Read this narrowly. It is a claim about captured PATHS, not about dependencies: a
   * package added to an existing `package.json` and later removed never changes a path,
   * and vendor trees (`node_modules/` and friends) are excluded from the snapshot
   * entirely, so neither shows up here. {@link withdrawnDependencies} is the field that
   * speaks to dependencies. Anything added and withdrawn between two captures is invisible
   * to both.
   *
   * OMITTED (not empty) when either endpoint walk was capped, since then "absent from both
   * endpoints" is unprovable for every path at once.
   */
  transientCapturedPaths?: string[];
  /**
   * Package names present at some captured step after the baseline and absent from BOTH
   * endpoints — a dependency the variant took on and then withdrew.
   *
   * Derived from the same evidence as the mechanical `c-no-new-deps` score (declared
   * manifest entries, source imports, and a per-step scan of the vendor directories the
   * file snapshot deliberately skips), so it sees a withdrawn dependency whether it was
   * declared, imported, or vendored in.
   *
   * It narrows the reviewer's standing bound on final-tree-only judging; it does not close
   * it. A dependency added and removed BETWEEN two step captures leaves no evidence to
   * find. OMITTED (not empty) when the timeline was not measured or when either endpoint
   * capture was incomplete — an incomplete endpoint can hide the very name that would
   * disqualify a "withdrawn" claim.
   *
   * The endpoint name-sets carry a caller obligation this module cannot check: they must
   * describe the SAME capture as `final`/`baseline`, from a vendor scan that succeeded. The
   * driver's final tree can come from the durable fold of an earlier step, so pairing it
   * with a scan of the live workdir (or with a scan that silently failed) reports a package
   * still present as withdrawn — the reviewer's first finding on `21aaf4be`. Callers that
   * cannot honour that pass `undefined` and get the field omitted.
   */
  withdrawnDependencies?: string[];
}

/** Everything the package needs about one variant's tree relative to the baseline. */
export interface BaselineTrace {
  provenance: ArtifactProvenance;
  /** The final tree, each file annotated with its {@link FileOrigin}. */
  files: AnnotatedFileSnapshot[];
}

/** One post-baseline step's evidence. `dependencyNames` absent ⇒ the timeline is unmeasured. */
export interface IntermediateCapture {
  /** Every path the step's walk captured. */
  paths: readonly string[];
  /** Distinct package names visible at that step (declared, imported, or vendored). */
  dependencyNames?: readonly string[];
}

/** The classification of one file, with the bound that defeated it when there is one. */
export interface OriginVerdict {
  origin: FileOrigin;
  indeterminateReason?: IndeterminateReason;
}

function byPath(files: readonly FileSnapshot[]): Map<string, FileSnapshot> {
  return new Map(files.map((f) => [f.path, f]));
}

/**
 * Whether a capture with these bounds could contain `path` without having captured it.
 * True means "absent from this capture" proves nothing about the tree.
 */
function mayHide(bounds: CaptureBounds, path: string): boolean {
  return (
    bounds.capped ||
    bounds.skippedPaths.includes(path) ||
    bounds.unreadableDirs.some((d) => isUnder(path, d))
  );
}

/**
 * Whether `path` lies inside tree-relative directory `dir` (`""` = the whole tree).
 *
 * Prefix containment is exact — everything under an unlisted directory is unknown and
 * nothing outside it is affected — which is why unreadable directories get a per-path
 * answer while {@link CaptureBounds.capped} stays global. Reasoning about which paths a
 * capped walk had already passed would depend on traversal order; this does not.
 */
function isUnder(path: string, dir: string): boolean {
  return dir === "" || path === dir || path.startsWith(`${dir}/`);
}

/** A capture's full coverage record — the walk's bounds plus what truncation it applied. */
export function coverageOf(bounds: CaptureBounds, files: readonly FileSnapshot[]): CaptureCoverage {
  const truncatedPaths = files
    .filter((f) => f.truncated)
    .map((f) => f.path)
    .sort();
  return {
    capped: bounds.capped,
    skippedPaths: [...bounds.skippedPaths].sort(),
    unreadableDirs: [...bounds.unreadableDirs].sort(),
    truncatedPaths,
    complete:
      !bounds.capped &&
      bounds.skippedPaths.length === 0 &&
      bounds.unreadableDirs.length === 0 &&
      truncatedPaths.length === 0,
  };
}

/**
 * Classify one final-tree file against its baseline counterpart.
 *
 * `baselineBounds` is required rather than optional on purpose: absence of a file from a
 * BOUNDED capture is not absence from the tree, and a defaulted "the baseline was
 * complete" would silently turn every uncaptured path into `added`.
 */
export function classifyAgainstBaseline(
  baseline: FileSnapshot | undefined,
  final: FileSnapshot,
  baselineBounds: CaptureBounds
): OriginVerdict {
  if (!baseline) {
    // Never captured at the baseline — but only a capture that could not have hidden the
    // path is entitled to call that "created since".
    return mayHide(baselineBounds, final.path)
      ? { origin: "indeterminate", indeterminateReason: "baseline-incomplete" }
      : { origin: "added" };
  }
  if (baseline.content !== final.content) return { origin: "modified" };
  // Contents match — but on a truncated capture that is only a prefix match. A
  // difference past the cut is invisible, so this is unknown, not identical.
  if (baseline.truncated || final.truncated) {
    return { origin: "indeterminate", indeterminateReason: "truncated-capture" };
  }
  return { origin: "unchanged" };
}

/**
 * Trace one variant's final tree against its baseline-step tree.
 *
 * `intermediate` is the evidence captured at each step AFTER the baseline; pass the steps
 * in any order, only membership matters. The endpoint `bounds` are what keep this honest —
 * without them every uncaptured path becomes a confident `added` or `removed`.
 */
export function traceAgainstBaseline(args: {
  baselineStepId: string;
  baseline: readonly FileSnapshot[];
  baselineBounds: CaptureBounds;
  baselineDependencyNames?: readonly string[];
  final: readonly FileSnapshot[];
  finalBounds: CaptureBounds;
  finalDependencyNames?: readonly string[];
  intermediate?: readonly IntermediateCapture[];
}): BaselineTrace {
  const base = byPath(args.baseline);
  const files: AnnotatedFileSnapshot[] = args.final.map((f) => {
    const prior = base.get(f.path);
    const { origin, indeterminateReason } = classifyAgainstBaseline(prior, f, args.baselineBounds);
    const carriesBaseline =
      prior && (origin === "modified" || indeterminateReason === "truncated-capture");
    return {
      ...f,
      origin,
      ...(indeterminateReason ? { indeterminateReason } : {}),
      ...(carriesBaseline
        ? { baselineContent: prior.content, baselineTruncated: prior.truncated }
        : {}),
    };
  });

  const coverage = {
    baseline: coverageOf(args.baselineBounds, args.baseline),
    final: coverageOf(args.finalBounds, args.final),
  };

  const finalPaths = new Set(args.final.map((f) => f.path));
  const removedSinceBaseline: string[] = [];
  const unresolvedSinceBaseline: string[] = [];
  for (const p of [...base.keys()].sort()) {
    if (finalPaths.has(p)) continue;
    // Gone from the final capture — a deletion only if the final walk could not have
    // simply failed to capture it.
    if (mayHide(args.finalBounds, p)) unresolvedSinceBaseline.push(p);
    else removedSinceBaseline.push(p);
  }

  const provenance: ArtifactProvenance = {
    baselineStepId: args.baselineStepId,
    coverage,
    removedSinceBaseline,
    unresolvedSinceBaseline,
  };

  const steps = args.intermediate ?? [];
  // A capped endpoint defeats "absent from both endpoints" for EVERY path at once, so
  // there is no honest per-path answer left to give — omit the field rather than emit a
  // list that reads as "none found".
  if (steps.length > 0 && !args.baselineBounds.capped && !args.finalBounds.capped) {
    const transient = new Set<string>();
    for (const step of steps) {
      for (const p of step.paths) {
        if (base.has(p) || finalPaths.has(p)) continue;
        if (mayHide(args.baselineBounds, p) || mayHide(args.finalBounds, p)) continue;
        transient.add(p);
      }
    }
    provenance.transientCapturedPaths = [...transient].sort();
  }

  // Dependency names are not path-addressable: one truncated manifest or one uncaptured
  // source file can hide the name that would disprove "withdrawn". So this claim needs
  // both endpoints COMPLETE, not merely un-capped.
  const depsMeasured =
    steps.length > 0 &&
    steps.every((s) => s.dependencyNames !== undefined) &&
    args.baselineDependencyNames !== undefined &&
    args.finalDependencyNames !== undefined;
  if (depsMeasured && coverage.baseline.complete && coverage.final.complete) {
    const endpoints = new Set([
      ...(args.baselineDependencyNames ?? []),
      ...(args.finalDependencyNames ?? []),
    ]);
    const withdrawn = new Set<string>();
    for (const step of steps) {
      for (const name of step.dependencyNames ?? []) {
        if (!endpoints.has(name)) withdrawn.add(name);
      }
    }
    provenance.withdrawnDependencies = [...withdrawn].sort();
  }

  return { provenance, files };
}
