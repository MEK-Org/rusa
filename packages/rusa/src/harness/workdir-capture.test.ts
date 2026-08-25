import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { scanVendorPaths, snapshotWorkdir } from "./workdir-capture.js";

/**
 * These run against a real filesystem on purpose. The bug class they cover  is a
 * failed read answering "absent", and no hand-written fixture can produce one — mocking the
 * error would assert my belief about the walk rather than the walk's behaviour, which is
 * exactly how the last round's `node_modules/express` fixture slipped through.
 */

/**
 * Whether an unreadable directory is actually unreadable HERE. Running as root (some CI
 * images do), `chmod 000` is not enforced, and the tests below would be asserting on a
 * precondition the environment never established. Probed, not assumed.
 */
const canDenyRead = (() => {
  const probe = mkdtempSync(join(tmpdir(), "ab-perm-"));
  try {
    mkdirSync(join(probe, "d"));
    chmodSync(join(probe, "d"), 0o000);
    readdirSync(join(probe, "d"));
    return false;
  } catch {
    return true;
  } finally {
    chmodSync(join(probe, "d"), 0o755);
    rmSync(probe, { recursive: true, force: true });
  }
})();

const tmp = (): string => mkdtempSync(join(tmpdir(), "ab-snap-"));

/**
 * The structural half of the fix: the policy cannot be forgotten at a call site if no call
 * site can reach the filesystem. `capture-fs.ts` is the only module on this path that imports
 * `node:fs` — including the `Dirent` type, which it re-exports so this guard can reject the
 * string outright instead of having to tell a type import from a value one.
 */
describe("capture-fs is the only door to the filesystem (ISSUE_NUM policy)", () => {
  const sourceOf = (name: string): string => readFileSync(join(import.meta.dirname, name), "utf8");

  /**
   * What one module names, read off the syntax tree rather than off the text.
   *
   * `strings` is the field the policy is enforced on, and `specifiers` is not. Recognizing
   * module-acquisition SITES turned out to be an open-ended list — `import`, `require`,
   * `import =`, `import()` types, then `process.getBuiltinModule`, and after that
   * `createRequire(...)(…)`, `module.require`, an aliased `require`… Each review round added
   * one and the list never closed. What IS closed is the set of names the filesystem module
   * answers to, and every one of those routes has to spell one of them out. So the guard stops
   * asking "is this an import?" and asks "does this module name `node:fs` at all?".
   *
   * `specifiers` survives for the one thing name-denial cannot do: tell a site that names a
   * module at runtime from a module that names nothing. `unresolved` is that signal — a
   * specifier that is not a literal (`import(spec)`) is an acquisition this guard CANNOT
   * resolve, and by this PR's own policy a check that cannot answer must not answer "clean".
   * Same for `parseErrors` — a file the parser could not read is not a file with no imports.
   */
  interface ModuleScan {
    /** Specifiers at recognized acquisition sites, when written as a literal. */
    specifiers: string[];
    /** Every string this module spells out, in any syntactic position. */
    strings: string[];
    unresolved: string[];
    parseErrors: string[];
  }

  /**
   * Every string a source spells out, plus the module specifiers it could resolve.
   *
   * This was a set of regexes and a reviewer walked a live `node:fs` import straight through
   * it: a comment is legal whitespace between `from` and the specifier, so
   * `import { readFileSync } from /* … *\/ "node:fs"` matched nothing. The regexes also fired
   * on imports written inside comments and string literals, so tightening them was a losing
   * game in both directions at once. The parser already knows what a string is; ask it.
   */
  const scanModule = (source: string): ModuleScan => {
    const file = ts.createSourceFile(
      "guarded.ts",
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      ts.ScriptKind.TS
    );
    const specifiers: string[] = [];
    const strings: string[] = [];
    const unresolved: string[] = [];

    const record = (node: ts.Node | undefined, form: string): void => {
      if (node === undefined) return;
      if (ts.isStringLiteralLike(node)) specifiers.push(node.text);
      else unresolved.push(`${form}: ${node.getText(file)}`);
    };

    /** The name a callee is written under, whether bare or reached through a property. */
    const calleeName = (callee: ts.Expression): string | undefined => {
      if (ts.isIdentifier(callee)) return callee.text;
      if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
      return undefined;
    };

    const visit = (node: ts.Node): void => {
      // Name-denial is the enforcement, so every string counts wherever it sits — a specifier,
      // an argument to a builtin accessor, or an argument to something not enumerated below.
      if (ts.isStringLiteralLike(node)) strings.push(node.text);

      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        // `export { x }` with no `from` has no specifier at all — nothing is pulled in.
        record(node.moduleSpecifier, "import/export");
      } else if (ts.isImportEqualsDeclaration(node)) {
        // `import fs = require("fs")`
        if (ts.isExternalModuleReference(node.moduleReference)) {
          record(node.moduleReference.expression, "import=require");
        }
      } else if (ts.isImportTypeNode(node)) {
        // `type S = import("node:fs").Stats` — a type-only route to the same module.
        const { argument } = node;
        record(ts.isLiteralTypeNode(argument) ? argument.literal : argument, "import type");
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (callee.kind === ts.SyntaxKind.ImportKeyword) record(node.arguments[0], "import()");
        else {
          // `require(…)`, `module.require(…)`, `process.getBuiltinModule(…)` — recognized so a
          // RUNTIME-computed name here reads as unresolved rather than as nothing. A literal
          // name needs no help from this list; `strings` already has it.
          const name = calleeName(callee);
          if (name === "require" || name === "getBuiltinModule") {
            record(node.arguments[0], `${name}()`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);

    // `createSourceFile` recovers from syntax errors silently, and a recovered parse can drop
    // the very node this guard is looking for. `transpileModule` is the public way to see
    // whether the text actually parsed.
    const { diagnostics } = ts.transpileModule(source, {
      fileName: "guarded.ts",
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext },
    });
    const parseErrors = (diagnostics ?? [])
      .filter((d) => d.category === ts.DiagnosticCategory.Error)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));

    return { specifiers, strings, unresolved, parseErrors };
  };

  /**
   * The filesystem module under every name it answers to: both spellings and the sub-path
   * forms (`fs/promises`, `node:fs/promises`). Plain string comparison, not a pattern — the
   * set of names is closed and enumerable, so a matcher buys nothing here.
   *
   * Deliberately NOT a substring test, in either direction: `fs-extra` and `./fs.js` are
   * ordinary modules and must not trip it, or the guard becomes noise and gets weakened.
   */
  const isFsSpecifier = (spec: string): boolean =>
    spec === "fs" || spec === "node:fs" || spec.startsWith("fs/") || spec.startsWith("node:fs/");

  /**
   * The policy check: does this module name the filesystem module anywhere?
   *
   * A false positive here is a legitimate string that happens to be exactly `node:fs` — an
   * error message, say. That is the safe direction (it is loud, and rewording it costs
   * nothing) and it is why the comparison is equality and prefix, never substring: a string
   * that merely CONTAINS the name, like the sample import text in the negatives below, is
   * prose and must not fire.
   */
  const fsNamesIn = (source: string): string[] => scanModule(source).strings.filter(isFsSpecifier);

  /** The narrower positional view, kept for the `unresolved` signal it feeds. */
  const fsImportsIn = (source: string): string[] =>
    scanModule(source).specifiers.filter(isFsSpecifier);

  it("keeps every filesystem read in workdir-capture.ts behind the policy module", () => {
    const scan = scanModule(sourceOf("workdir-capture.ts"));
    expect(scan.strings.filter(isFsSpecifier)).toEqual([]);
    // The other two thirds of the answer: nothing in this module names a module at runtime
    // where the scan had to give up, and the parse that produced that verdict succeeded.
    expect(scan.unresolved).toEqual([]);
    expect(scan.parseErrors).toEqual([]);
  });

  it.each([
    ['import type { Dirent } from "fs";', "the spelling a reviewer used to walk through"],
    [
      'import { readFileSync } from /* policy exception? */ "node:fs";',
      "a comment between `from` and the specifier",
    ],
    [
      'process.getBuiltinModule("fs").existsSync(".");',
      "a builtin accessor that is not an import at all",
    ],
  ])("rejects `%s` placed in the guarded module itself (%s)", (line) => {
    // The counter-fixture, and the only version of this assertion that means anything: the
    // detector must fire on the REAL guarded source, mutated. Each of these passed a previous
    // cut of the guard — one because it knew a single spelling, one because it read text
    // instead of syntax, one because it enumerated import forms and Node has a non-import way
    // to reach the same module.
    expect(fsNamesIn(`${line}\n${sourceOf("workdir-capture.ts")}`)).not.toEqual([]);
  });

  it("finds the import in the one module that is allowed to have it", () => {
    expect(fsImportsIn(sourceOf("capture-fs.ts"))).toEqual(["node:fs"]);
  });

  it.each([
    ['import { readFileSync } from "fs";', "fs"],
    ['import { readFileSync } from "node:fs";', "node:fs"],
    ['import type { Dirent } from "fs";', "fs"],
    ['import { readFile } from "fs/promises";', "fs/promises"],
    ['import { readFile } from "node:fs/promises";', "node:fs/promises"],
    ['export { readFileSync } from "node:fs";', "node:fs"],
    ['import "node:fs";', "node:fs"],
    ['const fs = require("fs");', "fs"],
    ['const fs = await import("node:fs");', "node:fs"],
    // Everything below here is invisible to a regex over the text.
    ['import { readFileSync } from /* policy exception? */ "node:fs";', "node:fs"],
    ['import {\n  readFileSync, // still an import\n} from "node:fs";', "node:fs"],
    ['import fs = require("node:fs");', "node:fs"],
    ['type S = import("node:fs").Stats;', "node:fs"],
    // And everything below here is invisible to a scan that enumerates IMPORT forms, because
    // none of them is one: Node hands out builtins directly, and `createRequire` mints a
    // `require` under any name you like.
    ['process.getBuiltinModule("fs").existsSync(".");', "fs"],
    ['const fs = globalThis.process.getBuiltinModule("node:fs");', "node:fs"],
    ['const load = createRequire(import.meta.url);\nconst fs = load("node:fs");', "node:fs"],
    ['const fs = module.require("fs/promises");', "fs/promises"],
  ])("catches %s", (source, expected) => {
    expect(fsNamesIn(source)).toEqual([expected]);
  });

  it.each([
    'import { join } from "node:path";',
    'import { x } from "./capture-fs.js";',
    'import fse from "fs-extra";',
    'import { y } from "./fs.js";',
    // The other direction of the same defect: the regex cut read comments and string bodies
    // as imports. A guard that cries wolf is a guard someone deletes.
    '// import { readFileSync } from "node:fs";',
    "const example = 'import { readFileSync } from \"node:fs\";';",
    // Name-denial widens what counts, so pin the boundary: a string that merely mentions the
    // name is not the name.
    'const doc = "see node:fs for the underlying call";',
  ])("does not fire on %s", (source) => {
    expect(fsNamesIn(source)).toEqual([]);
  });

  it.each([
    ['const spec = "node:fs";\nconst fs = await import(spec);', "import(): spec"],
    ["const fs = process.getBuiltinModule(spec);", "getBuiltinModule(): spec"],
  ])("reports %s as an acquisition it cannot resolve", (source, expected) => {
    // Three-state, same as every filesystem read in this PR: a name computed at runtime is not
    // evidence of a clean module, so it lands in `unresolved` rather than being dropped. This
    // is the half of the answer name-denial cannot give — the module names nothing here.
    const scan = scanModule(source);
    expect(scan.specifiers).toEqual([]);
    expect(scan.unresolved).toEqual([expected]);
  });

  it("reports a parse failure instead of reading it as no import", () => {
    const scan = scanModule('import { readFileSync from "node:fs";');
    expect(scan.parseErrors.length).toBeGreaterThan(0);
  });
});

/**
 * The policy — only `ENOENT` means absent, anything else means the capture is INCOMPLETE —
 * stated once as a grid rather than at the two sites a reviewer happened to name.
 *
 * Rows are the three things a capture reads (the arm's worktree, a vendor root, a package
 * entry inside one) crossed with the three ways a read fails (the entry is missing, it is a
 * symlink, it cannot be read). Each cell asserts BOTH directions where they exist: genuine
 * absence stays a measurement, and every other outcome shows up in `unreadableDirs` or
 * `complete: false`.
 */
describe("read policy over {missing, symlink, EACCES} × {worktree, vendor root, package dir}", () => {
  /** One cell. `unlock` names dirs to reopen so the sandbox can be removed afterwards. */
  interface Cell {
    name: string;
    needsDenyRead?: boolean;
    unlock?: string[];
    run: (sandbox: string) => void;
  }

  const CELLS: Cell[] = [
    {
      name: "worktree × missing — no tree at all is a real measurement, so it stays complete",
      run: (s) => {
        // An arm that never started leaves no workdir. This is the ONE outcome that may be
        // reported as an empty capture, and the reason the policy needs a third state at all:
        // without it, "nothing there" and "could not look" collapse into the same answer.
        expect(snapshotWorkdir(join(s, "wt"))).toEqual({
          files: [],
          bounds: { capped: false, skippedPaths: [], unreadableDirs: [] },
        });
      },
    },
    {
      name: "worktree × symlink — followed when it resolves, admitted as a hole when it dangles",
      run: (s) => {
        mkdirSync(join(s, "store"));
        writeFileSync(join(s, "store", "app.js"), "//");
        symlinkSync("./store", join(s, "wt"));
        symlinkSync("./nowhere", join(s, "gone-wt"));
        // A symlinked ROOT is followed — unlike a symlink found mid-walk, it is the tree the
        // caller asked for, and the one listing is bounded.
        const live = snapshotWorkdir(join(s, "wt"));
        expect(live.files.map((f) => f.path)).toEqual(["app.js"]);
        expect(live.bounds.unreadableDirs).toEqual([]);
        // Dangling: `existsSync` said "absent" here and the capture came back empty AND
        // complete, so every baseline file read as definitely removed. The entry exists; its
        // contents are unknown. `""` is the whole tree's prefix, so it hides all of them.
        expect(snapshotWorkdir(join(s, "gone-wt")).bounds.unreadableDirs).toEqual([""]);
      },
    },
    {
      name: "worktree × EACCES — unreadable directly or through its parent, both incomplete",
      needsDenyRead: true,
      unlock: ["locked", "wt"],
      run: (s) => {
        mkdirSync(join(s, "locked", "store"), { recursive: true });
        writeFileSync(join(s, "locked", "store", "app.js"), "//");
        symlinkSync("./locked/store", join(s, "via-link"));
        mkdirSync(join(s, "wt"));
        writeFileSync(join(s, "wt", "app.js"), "//");
        chmodSync(join(s, "locked"), 0o000);
        chmodSync(join(s, "wt"), 0o000);
        expect(snapshotWorkdir(join(s, "wt")).bounds.unreadableDirs).toEqual([""]);
        // The symlink+EACCES corner: resolution fails with EACCES, and `existsSync` reports
        // that as `false` — the same value as "no such entry". A check that cannot answer
        // must not answer.
        expect(snapshotWorkdir(join(s, "via-link")).bounds.unreadableDirs).toEqual([""]);
      },
    },
    {
      name: "vendor root × missing — nothing vendored is a measurement, so the scan is complete",
      run: (s) => {
        mkdirSync(join(s, "wt"));
        writeFileSync(join(s, "wt", "app.js"), "//");
        expect(scanVendorPaths(join(s, "wt"))).toEqual({ paths: [], complete: true });
      },
    },
    {
      name: "vendor root × symlink — scanned when it resolves, incomplete when it dangles",
      run: (s) => {
        mkdirSync(join(s, "store", "express"), { recursive: true });
        mkdirSync(join(s, "wt"));
        symlinkSync("../store", join(s, "wt", "node_modules"));
        expect(scanVendorPaths(join(s, "wt"))).toEqual({
          paths: ["node_modules/express"],
          complete: true,
        });
        mkdirSync(join(s, "wt2"));
        symlinkSync("./nowhere", join(s, "wt2", "node_modules"));
        // ENOENT from the LISTING is not on its own proof of absence: a dangling link reports
        // it too, and someone put that entry there. `lstat` asks about the entry itself.
        expect(scanVendorPaths(join(s, "wt2"))).toEqual({ paths: [], complete: false });
      },
    },
    {
      name: "vendor root × EACCES — unreadable directly or through its parent, both incomplete",
      needsDenyRead: true,
      unlock: ["locked", "wt/node_modules"],
      run: (s) => {
        mkdirSync(join(s, "wt", "node_modules", "express"), { recursive: true });
        chmodSync(join(s, "wt", "node_modules"), 0o000);
        // An unreadable `node_modules/` scoring as "added no dependencies" is a clean
        // `c-no-new-deps` PASS over a tree nobody could see, and file coverage cannot catch it
        // because the snapshot never enters vendor directories at all.
        expect(scanVendorPaths(join(s, "wt"))).toEqual({ paths: [], complete: false });
        mkdirSync(join(s, "locked", "store", "express"), { recursive: true });
        mkdirSync(join(s, "wt2"));
        symlinkSync("../locked/store", join(s, "wt2", "node_modules"));
        chmodSync(join(s, "locked"), 0o000);
        expect(scanVendorPaths(join(s, "wt2"))).toEqual({ paths: [], complete: false });
      },
    },
    {
      name: "package dir × missing — a dangling package still counts, a dangling scope is a hole",
      run: (s) => {
        mkdirSync(join(s, "wt", "node_modules"), { recursive: true });
        symlinkSync("../gone", join(s, "wt", "node_modules", "ghost"));
        symlinkSync("../gone-scope", join(s, "wt", "node_modules", "@ghost"));
        // Both directions err away from a green reading: the package NAME is all the scan
        // wants and someone reached for it, so counting it only makes the gate stricter —
        // while a scope whose contents cannot be listed is a hole, not an empty scope.
        expect(scanVendorPaths(join(s, "wt"))).toEqual({
          paths: ["node_modules/ghost"],
          complete: false,
        });
      },
    },
    {
      name: "package dir × symlink — counted, as package and as scope (the pnpm/workspace layout)",
      run: (s) => {
        mkdirSync(join(s, "store-express"), { recursive: true });
        mkdirSync(join(s, "store-scope", "inner"), { recursive: true });
        mkdirSync(join(s, "store-pkg"), { recursive: true });
        mkdirSync(join(s, "wt", "node_modules", "@real"), { recursive: true });
        symlinkSync("../../store-express", join(s, "wt", "node_modules", "express"));
        symlinkSync("../../store-scope", join(s, "wt", "node_modules", "@scope"));
        symlinkSync("../../../store-pkg", join(s, "wt", "node_modules", "@real", "pkg"));
        // `isDirectory()` is false for every one of these — pnpm's `node_modules/` is symlinks
        // nearly end to end — so the previous filter dropped a fully vendored tree with
        // `complete: true`.
        const scan = scanVendorPaths(join(s, "wt"));
        expect(scan.paths.sort()).toEqual([
          "node_modules/@real/pkg",
          "node_modules/@scope/inner",
          "node_modules/express",
        ]);
        expect(scan.complete).toBe(true);
      },
    },
    {
      name: "package dir × EACCES — the name survives, an unreadable scope's contents do not",
      needsDenyRead: true,
      unlock: ["wt/node_modules/@scope", "wt/node_modules/opaque"],
      run: (s) => {
        mkdirSync(join(s, "wt", "node_modules", "opaque"), { recursive: true });
        mkdirSync(join(s, "wt", "node_modules", "@scope", "pkg"), { recursive: true });
        chmodSync(join(s, "wt", "node_modules", "opaque"), 0o000);
        chmodSync(join(s, "wt", "node_modules", "@scope"), 0o000);
        // An unreadable PACKAGE is not a hole: the listing already gave its name, and the name
        // is the entire measurement. An unreadable SCOPE is, because the names it holds are
        // exactly what could not be read.
        expect(scanVendorPaths(join(s, "wt"))).toEqual({
          paths: ["node_modules/opaque"],
          complete: false,
        });
      },
    },
  ];

  for (const cell of CELLS) {
    const test = cell.needsDenyRead ? it.runIf(canDenyRead) : it;
    test(cell.name, () => {
      const sandbox = tmp();
      try {
        cell.run(sandbox);
      } finally {
        for (const path of cell.unlock ?? []) chmodSync(join(sandbox, path), 0o755);
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  }
});

describe("bounded capture reports its own failures (ISSUE_NUM re-review)", () => {
  it("reports a complete walk as complete, so the bound stays meaningful", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "app.js"), "//");
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "index.js"), "//");
      const snap = snapshotWorkdir(dir);
      expect(snap.files.map((f) => f.path).sort()).toEqual(["app.js", "src/index.js"]);
      expect(snap.bounds).toEqual({ capped: false, skippedPaths: [], unreadableDirs: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canDenyRead)(
    "records a directory it could not list instead of returning silently",
    () => {
      const dir = tmp();
      try {
        writeFileSync(join(dir, "app.js"), "//");
        mkdirSync(join(dir, "locked"));
        writeFileSync(join(dir, "locked", "hidden.js"), "//");
        chmodSync(join(dir, "locked"), 0o000);
        const snap = snapshotWorkdir(dir);
        // The file is missing from the capture either way — the difference is whether the
        // capture ADMITS it, which is what stops `hidden.js` reading as added or removed.
        expect(snap.files.map((f) => f.path)).toEqual(["app.js"]);
        expect(snap.bounds.unreadableDirs).toEqual(["locked"]);
      } finally {
        chmodSync(join(dir, "locked"), 0o755);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it("admits the symlinks it does not follow instead of walking past them", () => {
    // Same green-by-absence as the vendor scan, in the walk: a Dirent for a symlink is
    // neither `isDirectory()` nor `isFile()`, so both branches missed it and the path left
    // no trace in the bounds. Not followed (a link can leave the workdir or cycle) — but a
    // link to a directory hides a whole subtree, so it has to land where prefix containment
    // covers it, and a link to a file hides exactly one path.
    const dir = tmp();
    try {
      writeFileSync(join(dir, "app.js"), "//");
      mkdirSync(join(dir, "elsewhere"));
      writeFileSync(join(dir, "elsewhere", "deep.js"), "//");
      symlinkSync("./elsewhere", join(dir, "linked-dir"));
      symlinkSync("./app.js", join(dir, "linked-file.js"));
      symlinkSync("./gone", join(dir, "dangling"));
      const snap = snapshotWorkdir(dir);
      expect(snap.files.map((f) => f.path).sort()).toEqual(["app.js", "elsewhere/deep.js"]);
      expect(snap.bounds.unreadableDirs).toEqual(["linked-dir"]);
      expect(snap.bounds.skippedPaths.sort()).toEqual(["dangling", "linked-file.js"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canDenyRead)("treats a symlink it cannot CLASSIFY as hiding a subtree", () => {
    // `statSync` fails with EACCES as well as ENOENT, and an inaccessible target may be a
    // directory. Filing it as one skipped path would leave prefix containment covering
    // nothing, so a baseline file under it reads as definitely removed rather than
    // unresolved — the three-state guarantee lost to an error code.
    const dir = tmp();
    try {
      mkdirSync(join(dir, "locked", "hidden"), { recursive: true });
      writeFileSync(join(dir, "locked", "hidden", "child.js"), "//");
      symlinkSync("./locked/hidden", join(dir, "linked"));
      chmodSync(join(dir, "locked"), 0o000);
      const snap = snapshotWorkdir(dir);
      expect(snap.bounds.unreadableDirs.sort()).toEqual(["linked", "locked"]);
      expect(snap.bounds.skippedPaths).toEqual([]);
    } finally {
      chmodSync(join(dir, "locked"), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans vendored packages and calls the scan complete", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "node_modules", "express"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "@scope", "pkg"), { recursive: true });
      const scan = scanVendorPaths(dir);
      expect(scan.paths.sort()).toEqual(["node_modules/@scope/pkg", "node_modules/express"]);
      expect(scan.complete).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.runIf(canDenyRead)("calls an unreadable SCOPE inside a vendor directory incomplete", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, "node_modules", "express"), { recursive: true });
      mkdirSync(join(dir, "node_modules", "@scope", "pkg"), { recursive: true });
      chmodSync(join(dir, "node_modules", "@scope"), 0o000);
      const scan = scanVendorPaths(dir);
      expect(scan.paths).toEqual(["node_modules/express"]);
      expect(scan.complete).toBe(false);
    } finally {
      chmodSync(join(dir, "node_modules", "@scope"), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
