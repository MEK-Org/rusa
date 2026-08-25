import { join, relative } from "node:path";
import type { CaptureBounds } from "./artifact-provenance.js";
import type { FileSnapshot } from "./blind-package.js";
import {
  type Dirent,
  entryPresent,
  fileSize,
  listEntries,
  readText,
  targetIsDirectory,
} from "./capture-fs.js";
import type { VendorScan } from "./durable-capture.js";

/**
 * Everything that reads an arm's workdir to build one capture.
 *
 * This module imports the filesystem module NOWHERE — not even for a type. Every read goes
 * through
 * {@link ./capture-fs.js}, whose single policy is that only `ENOENT` means absent and any
 * other outcome makes the capture incomplete. `workdir-capture.test.ts` asserts that door
 * is the only one, so a future read cannot quietly reintroduce the family of bugs PR ISSUE_NUM
 * fixed five times.
 */

/**
 * Vendor-tree scan depth: enough to name `node_modules/@scope/pkg`, no deeper.
 *
 * `.venv`/`venv` are here because the G2-v2 artifacts show arms installing into them.
 * The scan only reaches a venv's layout dirs (`lib`, `bin`), so the package NAME it
 * yields is coarse — the ruling it triggers is still the right one, and the evidence
 * carries the path.
 */
export const VENDOR_SCAN_DIRS = [
  "node_modules",
  "vendor",
  "third_party",
  "vendored",
  ".venv",
  "venv",
];
export const SNAPSHOT_MAX_FILES = 60;
export const SNAPSHOT_MAX_FILE_BYTES = 12_000;
/**
 * Directories whose CONTENTS the blind snapshot never captures.
 *
 * Every vendor dir must appear here, and the union is built from {@link VENDOR_SCAN_DIRS}
 * rather than retyped, because the two lists have a load-bearing invariant that a
 * hand-maintained copy already broke: a dir skipped here but NOT scanned there becomes
 * invisible to the scorer (no evidence at all), and a dir scanned there but not skipped
 * here swallows the {@link SNAPSHOT_MAX_FILES} budget with third-party files — which is
 * how vendored Python prose ended up in a capture and gave the G2-v2 judge the
 * "expression"/`express` substring it scored the run on. Before this, only
 * `node_modules` was in both.
 */
export const SNAPSHOT_SKIP_DIRS = new Set([
  ...VENDOR_SCAN_DIRS,
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  "__pycache__",
]);

/** A bounded snapshot plus what the walk knows it left out. */
export interface WorkdirSnapshot {
  files: FileSnapshot[];
  bounds: CaptureBounds;
}

/**
 * Bounded, text-only snapshot of a workdir's source tree for the blind judge.
 *
 * The bounds travel WITH the files because they are load-bearing downstream: this walk
 * stops at {@link SNAPSHOT_MAX_FILES} and silently drops binaries, oversized files and
 * unreadable ones, so "path absent from this snapshot" does not mean "path absent from
 * the tree". Returning a bare array let `traceAgainstBaseline` read an uncaptured path as
 * a definite addition or deletion — the reviewer's finding on PR ISSUE_NUM, and this arc's
 * recurring failure class in yet another costume.
 */
export function snapshotWorkdir(dir: string): WorkdirSnapshot {
  const out: FileSnapshot[] = [];
  const skippedPaths: string[] = [];
  const unreadableDirs: string[] = [];
  let capped = false;
  const walkEntries = (current: string, entries: Dirent[]): void => {
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= SNAPSHOT_MAX_FILES) {
        capped = true;
        return;
      }
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const snap = readFileSnapshot(dir, full);
        if (snap) out.push(snap);
        else skippedPaths.push(relative(dir, full));
      } else if (!SNAPSHOT_SKIP_DIRS.has(entry.name)) {
        // A symlink is neither `isDirectory()` nor `isFile()` here (Dirent reports the link
        // itself), so this used to drop silently with coverage still `complete` — the same
        // green-by-absence the vendor scan had. Not followed: a link can leave the workdir
        // or cycle. Recorded instead, in the bucket that matches what is unseen — a link to
        // a directory hides its whole subtree, so it belongs with `unreadableDirs`, whose
        // prefix containment covers everything under it.
        //
        // Only an outcome that PROVES there is nothing there (a dangling link) downgrades
        // this to a single skipped path. `unknown` — EACCES on the target's parent, ELOOP,
        // an errno nobody enumerated — may well be hiding a subtree, so it is treated as
        // one.
        const hidesSubtree = targetIsDirectory(full).match({
          ok: (isDir) => isDir,
          absent: () => false,
          unknown: () => true,
        });
        if (hidesSubtree) unreadableDirs.push(relative(dir, full));
        else skippedPaths.push(relative(dir, full));
      }
    }
  };
  /** List a directory the walk has already decided to enter, and descend if it can. */
  const walk = (current: string): void => {
    if (out.length >= SNAPSHOT_MAX_FILES) {
      capped = true;
      return;
    }
    listEntries(current).match({
      ok: (entries) => walkEntries(current, entries),
      // A subdirectory that vanished between being listed and being read is a real
      // measurement — the capture describes a moment, and at that moment there is nothing
      // under it. Anything ELSE is a hole: nothing under here was seen, and returning
      // silently (the old behaviour) let a directory unreadable at one endpoint and
      // readable at the other turn every file in it into a definite `added` or `removed`,
      // with coverage still `complete`.
      absent: () => void 0,
      unknown: () => {
        unreadableDirs.push(relative(dir, current));
      },
    });
  };
  // The root gets its own listing rather than going through `walk`, because "no workdir at
  // all" and "a workdir I could not read" are different answers and only the first is a
  // measurement: an empty-and-complete snapshot of a tree nobody could see is the exact
  // shape of every bug this module has had. A failed listing is disambiguated the same way
  // `scanVendorPaths` does it — ENOENT on the LISTING is not on its own proof the tree is
  // absent, since a dangling symlink named as the workdir reports ENOENT too, and that is
  // an entry someone put there whose contents are unknown. `""` is the whole tree's prefix,
  // so recording it makes coverage incomplete and hides every path from membership claims.
  listEntries(dir).match({
    ok: (entries) => walkEntries(dir, entries),
    absent: () =>
      entryPresent(dir).match({
        ok: () => {
          unreadableDirs.push("");
        },
        absent: () => void 0,
        unknown: () => {
          unreadableDirs.push("");
        },
      }),
    unknown: () => {
      unreadableDirs.push("");
    },
  });
  return { files: out, bounds: { capped, skippedPaths, unreadableDirs } };
}

/**
 * One file, or `null` when it cannot be captured — binary, oversized, or unreadable.
 *
 * A `null` here is never read as absence: the caller records the path in
 * `bounds.skippedPaths`, which is what keeps "reached but not captured" distinct from
 * "not in the tree".
 */
function readFileSnapshot(base: string, full: string): FileSnapshot | null {
  const oversized = fileSize(full).match({
    ok: (size) => size > SNAPSHOT_MAX_FILE_BYTES * 8, // skip large binaries wholesale
    // Both non-ok outcomes fall through to the read, which then decides: a file that is
    // gone or unreadable produces `null`, and `null` means SKIPPED, not absent.
    absent: () => false,
    unknown: () => false,
  });
  if (oversized) return null;
  const content = readText(full).match({
    ok: (text) => text,
    absent: () => null,
    unknown: () => null,
  });
  if (content === null) return null;
  if (content.includes("\u0000")) return null; // NUL byte => binary
  const truncated = content.length > SNAPSHOT_MAX_FILE_BYTES;
  return {
    path: relative(base, full),
    content: truncated ? content.slice(0, SNAPSHOT_MAX_FILE_BYTES) : content,
    truncated,
  };
}

/** A vendor-directory entry that names a package: a real directory, or a symlink to one. */
function isPackageEntry(entry: Dirent): boolean {
  return entry.isDirectory() || entry.isSymbolicLink();
}

/**
 * Tree-relative paths of the top-level packages inside a workdir's vendor directories —
 * NAMES only, no contents, one level deep (two for a `@scope/`).
 *
 * The blind snapshot deliberately skips `node_modules/`, so without this the scorer is
 * blind to exactly one thing: vendoring, which is the one way to add a dependency without
 * touching package.json or writing a bare import. A rule the checker cannot see is not
 * a rule.
 *
 * The scan reports its own completeness because callers use the result as a MEASURED
 * dependency set. Folding "absent" and "unreadable" into the same empty array (the first
 * cut of this function) made a `node_modules/` that could not be listed look like a tree
 * with no vendored packages at all — which reads as a clean `c-no-new-deps` pass, and can
 * make a still-present package look withdrawn. File coverage cannot catch it either, since
 * the snapshot never enters these directories.
 */
export function scanVendorPaths(dir: string): VendorScan {
  const out: string[] = [];
  let complete = true;
  for (const vendorDir of VENDOR_SCAN_DIRS) {
    const base = join(dir, vendorDir);
    const entries = listEntries(base).match({
      ok: (list) => list,
      absent: () =>
        // Nothing there measures fine as "nothing vendored here" — but the listing failing
        // with ENOENT is not proof of that on its own: a DANGLING symlink named
        // `node_modules` also reports ENOENT, and someone reached for something there. Ask
        // about the entry itself, without following it.
        entryPresent(base).match({
          ok: () => {
            complete = false;
            return null;
          },
          absent: () => null,
          unknown: () => {
            complete = false;
            return null;
          },
        }),
      unknown: () => {
        complete = false;
        return null;
      },
    });
    if (!entries) continue;
    for (const entry of entries) {
      // A package entry is a directory OR a symlink to one — pnpm's `node_modules/` is
      // symlinks almost end to end, and npm/yarn produce them for workspaces and `link:`
      // deps. `isDirectory()` is false for every one of those, so accepting only real
      // directories dropped them with `complete` still true: measured absence, and a clean
      // `c-no-new-deps` pass over a tree full of vendored packages. Only the NAME is
      // wanted, so nothing here follows the link (a dangling one still counts — someone
      // reached for that package, and over-counting errs toward a stricter score).
      if (!isPackageEntry(entry) || entry.name.startsWith(".")) continue;
      if (!entry.name.startsWith("@")) {
        out.push(`${vendorDir}/${entry.name}`);
        continue;
      }
      // Follows a symlinked scope, which is one bounded read of a directory the listing
      // already named — and the only way to see the packages inside it. The scope is right
      // there in the listing, so EVERY failure to read it is a hole, ENOENT included: a
      // dangling scope link is a name we know about and contents we cannot see.
      const scoped = listEntries(join(base, entry.name)).match({
        ok: (list) => list,
        absent: () => {
          complete = false;
          return null;
        },
        unknown: () => {
          complete = false;
          return null;
        },
      });
      if (!scoped) continue;
      for (const inner of scoped) {
        if (isPackageEntry(inner)) out.push(`${vendorDir}/${entry.name}/${inner.name}`);
      }
    }
  }
  return { paths: out, complete };
}
