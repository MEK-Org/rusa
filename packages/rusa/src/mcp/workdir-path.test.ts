import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readBoundedRegularFile,
  resolveAttachmentPath,
  resolveDownloadPath,
  writeNewFileInWorkdir,
} from "./workdir-path.js";

// One-shot hook run right after the next realpath resolves, to land a swap in
// the window between resolving the workdir root and opening it.
const afterRealpath = vi.hoisted(() => ({ run: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async () => {
  const actual = (await vi.importActual<typeof import("node:fs")>("node:fs")).promises;
  const realpath = async (...args: Parameters<typeof actual.realpath>) => {
    const resolved = await actual.realpath(...args);
    const run = afterRealpath.run;
    afterRealpath.run = undefined;
    run?.();
    return resolved;
  };
  return { ...actual, default: { ...actual, realpath }, realpath };
});

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "rusa-workdir-path-"));
}

describe("readBoundedRegularFile", () => {
  it("reads a multi-chunk file up to exactly the cap", async () => {
    const dir = workdir();
    const bytes = Buffer.alloc(200 * 1024, 7);
    writeFileSync(join(dir, "big.bin"), bytes);
    const source = await resolveAttachmentPath(dir, "big.bin");
    expect((await readBoundedRegularFile(dir, source, bytes.length)).equals(bytes)).toBe(true);
  });

  it("enforces the cap at the read when the file grows after resolution", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "grow.txt"), "1234");
    const source = await resolveAttachmentPath(dir, "grow.txt");
    appendFileSync(source, "56789");
    await expect(readBoundedRegularFile(dir, source, 8)).rejects.toThrow(
      "file size limit exceeded"
    );
  });

  // A regular file whose stat size (0) understates its bytes stands in for a
  // file that grows between a size check and the read.
  it.skipIf(process.platform !== "linux")(
    "bounds bytes read rather than trusting the stat size",
    async () => {
      const proc = realpathSync("/proc/self");
      await expect(readBoundedRegularFile(proc, join(proc, "status"), 8)).rejects.toThrow(
        "file size limit exceeded"
      );
    }
  );

  it("refuses a final-component symlink swapped in after resolution", async () => {
    const dir = workdir();
    const outside = workdir();
    writeFileSync(join(outside, "secret.txt"), "secret");
    writeFileSync(join(dir, "ok.txt"), "ok");
    const source = await resolveAttachmentPath(dir, "ok.txt");
    rmSync(source);
    symlinkSync(join(outside, "secret.txt"), source);
    await expect(readBoundedRegularFile(dir, source, 8)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("refuses an ancestor directory swapped for an outside symlink after resolution", async () => {
    const dir = workdir();
    const outside = workdir();
    writeFileSync(join(outside, "file.txt"), "secret");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "file.txt"), "ok");
    const source = await resolveAttachmentPath(dir, "sub/file.txt");
    renameSync(join(dir, "sub"), join(dir, "sub-moved"));
    symlinkSync(outside, join(dir, "sub"));
    await expect(readBoundedRegularFile(dir, source, 8)).rejects.toThrow("access denied");
  });

  it("refuses directories and FIFOs without blocking", async () => {
    const dir = workdir();
    mkdirSync(join(dir, "sub"));
    execFileSync("mkfifo", [join(dir, "pipe")]);
    for (const name of ["sub", "pipe"]) {
      const source = await resolveAttachmentPath(dir, name);
      await expect(readBoundedRegularFile(dir, source, 8)).rejects.toThrow("not a regular file");
    }
  });
});

describe("workdir root acquisition", () => {
  // The workdir root sits under an ancestor; an outside tree mirrors the root's
  // name. Swapping the ancestor for a symlink to it after the root is resolved
  // must not hand back the outside root.
  function rootAncestorSwap() {
    const base = workdir();
    const outside = workdir();
    const root = join(base, "ancestor", "root");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(outside, "root"));
    writeFileSync(join(root, "file.txt"), "ok");
    writeFileSync(join(outside, "root", "file.txt"), "secret");
    const swap = () => {
      renameSync(join(base, "ancestor"), join(base, "ancestor-moved"));
      symlinkSync(outside, join(base, "ancestor"));
    };
    return { root, outside, swap };
  }

  it("refuses to read through a root ancestor swapped for an outside symlink", async () => {
    const { root, swap } = rootAncestorSwap();
    const source = await resolveAttachmentPath(root, "file.txt");
    afterRealpath.run = swap;
    await expect(readBoundedRegularFile(root, source, 64)).rejects.toThrow("access denied");
  });

  it("refuses to create a file through a root ancestor swapped for an outside symlink", async () => {
    const { root, outside, swap } = rootAncestorSwap();
    const destination = await resolveDownloadPath(root, "new.txt");
    afterRealpath.run = swap;
    await expect(writeNewFileInWorkdir(root, destination, Buffer.from("x"))).rejects.toThrow(
      "access denied"
    );
    expect(existsSync(join(outside, "root", "new.txt"))).toBe(false);
  });
});
