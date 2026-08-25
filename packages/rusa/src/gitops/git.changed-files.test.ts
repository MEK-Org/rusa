import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getChangedFiles } from "./git.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "changed-files-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-b", "master");
  git("config", "user.email", "test@local");
  git("config", "user.name", "Test");
  writeFileSync(join(dir, "index.js"), "console.log('hi');\n");
  git("add", ".");
  git("commit", "-m", "seed");
  return dir;
}

describe("getChangedFiles", () => {
  it("returns the full filename for an unstaged modification", () => {
    // Regression: porcelain prints ' M index.js' (leading space); a trimmed
    // read corrupted the first entry to 'ndex.js'.
    const dir = makeRepo();
    writeFileSync(join(dir, "index.js"), "console.log('changed');\n");
    expect(getChangedFiles(dir)).toEqual(["index.js"]);
  });

  it("handles a mix of modified and untracked files", () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "index.js"), "console.log('changed');\n");
    writeFileSync(join(dir, "new.txt"), "new\n");
    expect(getChangedFiles(dir).sort()).toEqual(["index.js", "new.txt"]);
  });

  it("returns an empty list for a clean tree", () => {
    expect(getChangedFiles(makeRepo())).toEqual([]);
  });
});
