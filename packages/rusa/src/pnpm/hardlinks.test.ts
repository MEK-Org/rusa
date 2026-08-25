import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPnpmHardlinks, pnpmStoreFileForContent, relinkPnpmProject } from "./hardlinks.js";

describe("pnpm hardlink invariant", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "mc-pnpm-hardlinks-"));
    tempDirs.push(root);
    const projectDir = join(root, "project");
    const storeDir = join(root, "store", "v10");
    const packageDir = join(
      projectDir,
      "node_modules",
      ".pnpm",
      "left-pad@1.3.0",
      "node_modules",
      "left-pad"
    );
    mkdirSync(packageDir, { recursive: true });
    mkdirSync(join(storeDir, "files"), { recursive: true });
    const file = join(packageDir, "index.js");
    writeFileSync(file, "module.exports = leftPad;\n");
    const storeFile = pnpmStoreFileForContent(file, storeDir);
    mkdirSync(dirname(storeFile), { recursive: true });
    writeFileSync(storeFile, "module.exports = leftPad;\n");
    return { projectDir, storeDir, file, storeFile };
  }

  it("reports copied package files", () => {
    const { projectDir, storeDir, file } = fixture();

    const result = checkPnpmHardlinks({ projectDir, storeDir });

    expect(result.sampled).toBe(1);
    expect(result.problems).toEqual([
      expect.objectContaining({ file, reason: "not-linked", links: 1 }),
    ]);
  });

  it("atomically replaces copied files with hardlinks to the store", () => {
    const { projectDir, storeDir, file, storeFile } = fixture();

    const result = relinkPnpmProject({ projectDir, storeDir });

    expect(result).toEqual(
      expect.objectContaining({
        scanned: 1,
        relinked: 1,
        alreadyLinked: 0,
        missingStoreFile: 0,
        failed: 0,
      })
    );
    expect(existsSync(file)).toBe(true);
    const installed = statSync(file);
    const store = statSync(storeFile);
    expect(installed.ino).toBe(store.ino);
    expect(installed.nlink).toBeGreaterThan(1);
    expect(checkPnpmHardlinks({ projectDir, storeDir }).problems).toEqual([]);
  });
});
