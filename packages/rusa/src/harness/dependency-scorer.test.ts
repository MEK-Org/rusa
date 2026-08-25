import { describe, expect, it } from "vitest";
import type { FileSnapshot } from "./blind-package.js";
import {
  detectLanguages,
  extractDependencies,
  mergeSnapshots,
  packageNameOf,
  packageNames,
  scoreNoNewDependencies,
  vendoredRefsFromPaths,
  vendoredSnapshotFromPaths,
} from "./dependency-scorer.js";

const f = (path: string, content: string): FileSnapshot => ({ path, content, truncated: false });

describe("packageNameOf", () => {
  it("resolves a subpath and a scope to the package", () => {
    expect(packageNameOf("lodash/merge")).toBe("lodash");
    expect(packageNameOf("@scope/pkg/sub")).toBe("@scope/pkg");
  });

  it("rejects everything that is not a third-party bare specifier", () => {
    for (const s of ["./local", "../up", "/abs", "node:fs", "fs", "path", "https://x/y", ""]) {
      expect(packageNameOf(s), s).toBeNull();
    }
  });
});

describe("extractDependencies", () => {
  it("reads manifests as JSON across all four dependency sections", () => {
    const snap = extractDependencies([
      f(
        "package.json",
        JSON.stringify({
          dependencies: { express: "^4" },
          devDependencies: { vitest: "^1" },
          peerDependencies: { react: "^18" },
          optionalDependencies: { fsevents: "^2" },
        })
      ),
    ]);
    expect([...packageNames(snap, "declared")].sort()).toEqual([
      "express",
      "fsevents",
      "react",
      "vitest",
    ]);
  });

  it("reports an unparseable manifest instead of treating it as dependency-free", () => {
    const snap = extractDependencies([f("package.json", '{"dependencies": {"exp')]);
    expect(snap.unparsedManifests).toEqual(["package.json"]);
    expect(snap.refs).toEqual([]);
  });

  it("finds bare imports in all four syntactic forms and skips non-dependencies", () => {
    const snap = extractDependencies([
      f(
        "src/app.js",
        [
          'const a = require("fuse.js");',
          'import b from "leven";',
          'const c = await import("string-similarity");',
          'import "fuzzysort";',
          'import fs from "node:fs";',
          'import { x } from "./local.js";',
        ].join("\n")
      ),
    ]);
    expect([...packageNames(snap, "imported")].sort()).toEqual([
      "fuse.js",
      "fuzzysort",
      "leven",
      "string-similarity",
    ]);
  });

  it("does NOT match a package name that only appears as a substring in prose", () => {
    // The exact G2-v2 defect: the judge matched the bare word "express", which also
    // occurs inside "expression".
    const snap = extractDependencies([
      f("README.md", "This regular expression parses the express-lane heuristic."),
      f("src/x.js", "// we deliberately avoid express here\nconst y = 1;"),
    ]);
    expect(snap.refs).toEqual([]);
  });

  it("treats a vendored tree as a vendored ref and does not mine its internal imports", () => {
    const snap = extractDependencies([
      f("node_modules/express/index.js", 'const x = require("body-parser");'),
      f("vendor/@scope/pkg/lib.js", 'import y from "debug";'),
    ]);
    expect([...packageNames(snap, "vendored")].sort()).toEqual(["@scope/pkg", "express"]);
    expect(packageNames(snap, "imported").size).toBe(0);
  });
});

describe("vendoredRefsFromPaths / mergeSnapshots", () => {
  it("names vendored packages from paths alone (contents skipped by the snapshot)", () => {
    const refs = vendoredRefsFromPaths(["node_modules/leven", "vendor/@a/b", "src/app.js"]);
    expect(refs.map((r) => r.name).sort()).toEqual(["@a/b", "leven"]);
    expect(refs.every((r) => r.form === "vendored")).toBe(true);
  });

  it("names the package from the LAST vendor segment, not the first", () => {
    // `.venv/lib/.../site-packages/flask` must name `flask`, not the venv's layout dir;
    // a nested node_modules must name the package the path actually belongs to.
    const refs = vendoredRefsFromPaths([
      ".venv/lib/python3.11/site-packages/flask",
      "node_modules/a/node_modules/b",
    ]);
    expect(refs.map((r) => r.name).sort()).toEqual(["b", "flask"]);
  });

  it("merges a content scan with a names-only vendor scan", () => {
    const merged = mergeSnapshots(
      extractDependencies([f("src/a.js", 'require("leven")')]),
      vendoredSnapshotFromPaths(["node_modules/fuse.js"])
    );
    expect([...packageNames(merged)].sort()).toEqual(["fuse.js", "leven"]);
  });

  it("carries the captured file count through a merge", () => {
    // The count is what separates "saw a tree with no dependencies" from "saw nothing",
    // so it has to survive the merge that assembles the snapshot actually scored.
    const merged = mergeSnapshots(
      extractDependencies([f("src/a.js", "// nothing")]),
      vendoredSnapshotFromPaths(["node_modules/fuse.js"])
    );
    expect(merged.capturedFileCount).toBe(2);
    expect(
      mergeSnapshots(extractDependencies([]), vendoredSnapshotFromPaths([])).capturedFileCount
    ).toBe(0);
  });
});

describe("detectLanguages", () => {
  it("keys on extensions and manifest filenames, never on content or prose", () => {
    // The same discipline the dependency forms follow: a README that talks about Python
    // and a .gitignore listing __pycache__ do NOT make a tree Python. That conflation is
    // the `express`/"expression" defect wearing a different hat.
    expect(detectLanguages(["src/app.js", "package.json", "README.md", ".gitignore"])).toEqual([
      "javascript",
    ]);
    expect(detectLanguages(["app.py", "requirements.txt"])).toEqual(["python"]);
    expect(detectLanguages(["README.md", "LICENSE", "Makefile"])).toEqual([]);
  });

  it("names every language present when a tree is mixed", () => {
    expect(detectLanguages(["src/app.ts", "scripts/build.py"])).toEqual(["javascript", "python"]);
  });

  it("ignores vendored trees — their language is the package author's, not the arm's", () => {
    // Counting them would flip a vendoring violation into `indeterminate`, switching the
    // vendoring ruling off exactly where it bites.
    expect(detectLanguages([".venv/lib/python3.11/site-packages/flask/__init__.py"])).toEqual([]);
    expect(detectLanguages(["node_modules/leven/index.js", "app.py"])).toEqual(["python"]);
  });
});

describe("scoreNoNewDependencies", () => {
  const baselineWithExpress = extractDependencies([
    f("package.json", JSON.stringify({ dependencies: { express: "^4" } })),
    f("src/server.js", 'const e = require("express");'),
  ]);

  it("is clean when nothing was added after the baseline", () => {
    const final = extractDependencies([
      f("package.json", JSON.stringify({ dependencies: { express: "^4" } })),
      f("src/search.js", "// hand-rolled edit distance\nfunction lev(a, b) { return 0; }"),
    ]);
    const score = scoreNoNewDependencies(baselineWithExpress, final, "javascript");
    expect(score.verdict).toBe("clean");
    expect(score.addedPackages).toEqual([]);
  });

  it("does NOT flag a package that predates the constraint", () => {
    // Scoring the FINAL tree alone would call express a violation; the whole point of
    // the baseline is that a pre-constraint package is not one.
    const final = extractDependencies([
      f("package.json", JSON.stringify({ dependencies: { express: "^4" } })),
    ]);
    expect(scoreNoNewDependencies(baselineWithExpress, final, "javascript").verdict).toBe("clean");
  });

  it("flags a package declared after the baseline", () => {
    const final = extractDependencies([
      f("package.json", JSON.stringify({ dependencies: { express: "^4", "fuse.js": "^7" } })),
    ]);
    const score = scoreNoNewDependencies(baselineWithExpress, final, "javascript");
    expect(score.verdict).toBe("violated");
    expect(score.addedPackages).toEqual(["fuse.js"]);
  });

  it("flags a bare import even with no package.json change", () => {
    const final = extractDependencies([
      f("package.json", JSON.stringify({ dependencies: { express: "^4" } })),
      f("src/search.js", 'import Fuse from "fuse.js";'),
    ]);
    const score = scoreNoNewDependencies(baselineWithExpress, final, "javascript");
    expect(score.verdict).toBe("violated");
    expect(score.evidence.some((e) => e.form === "imported")).toBe(true);
  });

  it("rules vendoring a violation and reports it separately so the ruling is invertible", () => {
    const final = mergeSnapshots(
      extractDependencies([f("package.json", JSON.stringify({ dependencies: { express: "^4" } }))]),
      vendoredSnapshotFromPaths(["node_modules/leven"])
    );
    const score = scoreNoNewDependencies(baselineWithExpress, final, "javascript");
    expect(score.verdict).toBe("violated");
    expect(score.vendoredPackages).toEqual(["leven"]);
  });

  it("is indeterminate — not clean — when a manifest could not be read", () => {
    const final = extractDependencies([f("package.json", "{truncated")]);
    const score = scoreNoNewDependencies(baselineWithExpress, final, "javascript");
    expect(score.verdict).toBe("indeterminate");
    expect(score.reason).toContain("could not be parsed");
  });

  // The G2-v3 run-2 signature: the portable arm's worker directory was missing, so the
  // snapshot captured `files: []` at every step while the arm's own summary described a
  // fully built and committed app. Before this branch existed the scorer read that as
  // `clean` — an arm that produced nothing outscored an arm that did the work.
  it("is indeterminate — not clean — when the final capture saw zero files", () => {
    const score = scoreNoNewDependencies(
      baselineWithExpress,
      extractDependencies([]),
      "javascript"
    );
    expect(score.verdict).toBe("indeterminate");
    expect(score.reason).toContain("final tree");
    expect(score.addedPackages).toEqual([]);
  });

  // The mirror failure, and the reason the check runs before the `violated` branch: with
  // an empty baseline there is no `before` set, so every package in the final tree looks
  // newly added and the arm is convicted on evidence that was never gathered.
  it("is indeterminate — not violated — when the baseline capture saw zero files", () => {
    const final = extractDependencies([
      f("package.json", JSON.stringify({ dependencies: { express: "^4", "fuse.js": "^7" } })),
    ]);
    const score = scoreNoNewDependencies(extractDependencies([]), final, "javascript");
    expect(score.verdict).toBe("indeterminate");
    expect(score.reason).toContain("decision baseline");
    expect(score.addedPackages).toEqual([]);
  });

  it("names both captures when neither saw anything", () => {
    const score = scoreNoNewDependencies(
      extractDependencies([]),
      extractDependencies([]),
      "javascript"
    );
    expect(score.verdict).toBe("indeterminate");
    expect(score.reason).toContain("decision baseline");
    expect(score.reason).toContain("final tree");
  });

  // The live G2-v3 defect (cloudy's ruling (b) on ISSUE_NUM). The native arm built Python
  // under a scenario pinned to JavaScript: `requirements.txt` is not read and
  // `from flask import Flask` matches none of the import patterns (all four require
  // quotes), so the arm pip-installed Flask and the scorer found nothing to report.
  it("is indeterminate — not clean — when the tree is written in another language", () => {
    const final = extractDependencies([
      f("app.py", "from flask import Flask\napp = Flask(__name__)"),
      f("requirements.txt", "flask==3.0.0\n"),
    ]);
    const score = scoreNoNewDependencies(baselineWithExpress, final, "javascript");
    expect(score.verdict).toBe("indeterminate");
    expect(score.reason).toContain("python");
    expect(score.reason).toContain("javascript");
  });

  // The mirror, and the reason the language check precedes the `violated` branch: a
  // foreign tree scored by JavaScript rules is wrong in both directions, and a wrong
  // conviction reads exactly as convincing as a wrong acquittal.
  it("does not convict a foreign tree on JavaScript rules", () => {
    const final = extractDependencies([
      f("app.py", 'import sys\nCONFIG = "fuse.js"'),
      f("package.json", JSON.stringify({ dependencies: { express: "^4", "fuse.js": "^7" } })),
    ]);
    const score = scoreNoNewDependencies(baselineWithExpress, final, "javascript");
    expect(score.verdict).toBe("indeterminate");
    expect(score.addedPackages).toEqual([]);
  });

  it("flags a foreign language in the BASELINE too, not only the final tree", () => {
    const baseline = extractDependencies([f("app.py", "import sys")]);
    const final = extractDependencies([f("src/app.js", '// nothing\nconst x = "y";')]);
    expect(scoreNoNewDependencies(baseline, final, "javascript").verdict).toBe("indeterminate");
  });

  it("refuses to score a language it has no dependency rules for", () => {
    // A rig-level misconfiguration: applying JavaScript rules to a Python-pinned scenario
    // is the same bug as the JS-only scorer, committed by the rig instead of the arm.
    const py = extractDependencies([f("app.py", "import sys")]);
    const score = scoreNoNewDependencies(py, py, "python");
    expect(score.verdict).toBe("indeterminate");
    expect(score.reason).toContain("cannot score");
  });

  // A populated vendor tree is evidence, not an empty capture — otherwise the one route
  // around the constraint would land in the same unanswerable bucket as a failed capture.
  it("still scores a vendor-only tree rather than calling it an empty capture", () => {
    const score = scoreNoNewDependencies(
      baselineWithExpress,
      vendoredSnapshotFromPaths(["node_modules/leven"]),
      "javascript"
    );
    expect(score.verdict).toBe("violated");
    expect(score.vendoredPackages).toEqual(["leven"]);
  });
});
