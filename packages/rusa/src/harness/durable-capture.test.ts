import { describe, expect, it } from "vitest";
import type { CaptureBounds } from "./artifact-provenance.js";
import type { FileSnapshot } from "./blind-package.js";
import {
  foldDurableCapture,
  isGoodSummary,
  type StepCapture,
  type VendorScan,
} from "./durable-capture.js";

const f = (path: string): FileSnapshot => ({ path, content: `// ${path}`, truncated: false });

describe("isGoodSummary", () => {
  it("accepts a real self-report", () => {
    expect(isGoodSummary("Built the CRDT todo app; removed mutable CRUD.")).toBe(true);
  });

  it("rejects empty / whitespace", () => {
    expect(isGoodSummary("")).toBe(false);
    expect(isGoodSummary("   \n")).toBe(false);
    expect(isGoodSummary(null)).toBe(false);
    expect(isGoodSummary(undefined)).toBe(false);
  });

  it("rejects provider cancel markers (case-insensitive)", () => {
    expect(isGoodSummary("[Task cancelled by user]")).toBe(false);
    expect(isGoodSummary("[task cancelled]")).toBe(false);
    expect(isGoodSummary("[cancelled]")).toBe(false);
    expect(isGoodSummary("[Aborted]")).toBe(false);
    expect(isGoodSummary("[Task killed by stall watchdog (no output for 15 minutes)]")).toBe(false);
    expect(isGoodSummary("[Task killed by run ceiling timeout]")).toBe(false);
    expect(isGoodSummary("[Task terminated by SIGTERM (source unattributed)]")).toBe(false);
  });

  it("rejects leading sandbox/OS error lines (an issue)", () => {
    // The exact G2 (b) s2 failure: an ENOSPC-broken bwrap mount line filled the summary
    // slot for both arms. Non-empty, no cancel marker — was scored GOOD before this fix.
    expect(
      isGoodSummary(
        "bwrap: Can't find source path /home/x/.rusa-ab/run-TPevEm/home/workers/abc: No such file or directory"
      )
    ).toBe(false);
    expect(isGoodSummary("ENOSPC: no space left on device")).toBe(false);
    expect(isGoodSummary("No space left on device")).toBe(false);
  });

  it("still accepts real prose that merely mentions an error mid-sentence", () => {
    // High precision: the floor only rejects summaries that LEAD with an error line, so a
    // genuine self-report narrating an error it handled stays GOOD.
    expect(
      isGoodSummary("Recovered from an ENOSPC by clearing the cache, then re-ran the build.")
    ).toBe(true);
    expect(
      isGoodSummary("The build failed with No such file or directory; I fixed the import path.")
    ).toBe(true);
  });
});

describe("foldDurableCapture", () => {
  const complete: CaptureBounds = { capped: false, skippedPaths: [], unreadableDirs: [] };
  const vendored: VendorScan = { paths: ["node_modules/express"], complete: true };
  const noVendor: VendorScan = { paths: [], complete: true };
  const s3: StepCapture = {
    stepId: "s3-pivot-crdt",
    summary: "Pivoted to event-sourced CRDT; no mutable CRUD.",
    files: [f("app.ts"), f("crdt.ts")],
    bounds: complete,
    vendor: vendored,
  };

  it("keeps the earlier good capture when a later step wipes the workspace + cancels", () => {
    // The exact run-hgdIwu failure: s4's runs were cancelled by the watchdog and the
    // workspace was wiped, so its capture is empty files + a cancel summary. That must
    // NOT clobber the good s3 artifact.
    const s4Wiped: StepCapture = {
      stepId: "s4-pivot-infinite",
      summary: "[Task cancelled by user]",
      files: [],
      // The teardown took the vendor tree with the files: an EMPTY scan of a wiped
      // workspace, which must not overwrite the kept capture's real one.
      bounds: { capped: false, skippedPaths: [], unreadableDirs: [] },
      vendor: noVendor,
    };
    const folded = foldDurableCapture(s3, s4Wiped);
    expect(folded).toEqual(s3);
  });

  it("keeps the wiped step's vendor scan OUT of the kept capture (ISSUE_NUM re-review)", () => {
    // Stated separately from the fold above because the consequence is not obvious: the
    // kept tree's `package.json` still requires `express`, so pairing it with the wiped
    // workspace's empty vendor scan reports a package the artifact still uses as
    // withdrawn. The scan has to describe the tree that is actually being shown.
    const folded = foldDurableCapture(s3, {
      stepId: "s4-pivot-infinite",
      summary: "[Task cancelled by user]",
      files: [],
      bounds: complete,
      vendor: noVendor,
    });
    expect(folded?.vendor).toEqual(vendored);
  });

  it("overwrites with a later good capture", () => {
    const s4: StepCapture = {
      stepId: "s4-pivot-infinite",
      summary: "Added infinite nesting; dropped the one-layer cap.",
      files: [f("app.ts"), f("tree.ts")],
      bounds: complete,
      vendor: noVendor,
    };
    expect(foldDurableCapture(s3, s4)).toEqual(s4);
  });

  it("keeps later files but an earlier good summary when the later run cancelled mid-write", () => {
    // Partial: s4 wrote files but its run_end was a cancel — take the fresher artifact,
    // retain the last real self-report so the judge still gets a coherent summary.
    const s4Partial: StepCapture = {
      stepId: "s4-pivot-infinite",
      summary: "",
      files: [f("app.ts"), f("tree.ts")],
      bounds: { capped: true, skippedPaths: ["logo.png"], unreadableDirs: [] },
      vendor: { paths: [], complete: false },
    };
    expect(foldDurableCapture(s3, s4Partial)).toEqual({
      stepId: "s4-pivot-infinite",
      summary: s3.summary,
      files: s4Partial.files,
      // The bounds travel with the FILES, not with the summary: the coverage record has
      // to describe the tree that was kept, or it understates what is missing from it.
      bounds: s4Partial.bounds,
      // Same for the vendor scan, and for a sharper reason — see the wipe test below.
      vendor: s4Partial.vendor,
    });
  });

  it("stays null until the first good capture", () => {
    const empty: StepCapture = {
      stepId: "s1",
      summary: "",
      files: [],
      bounds: complete,
      vendor: noVendor,
    };
    expect(foldDurableCapture(null, empty)).toBeNull();
  });

  it("seeds from null on the first good capture", () => {
    expect(foldDurableCapture(null, s3)).toEqual(s3);
  });
});
