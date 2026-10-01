import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBoundedRegularFile, resolveAttachmentPath } from "./workdir-path.js";

function workdir(): string {
  return mkdtempSync(join(tmpdir(), "rusa-workdir-path-"));
}

describe("readBoundedRegularFile", () => {
  it("reads a multi-chunk file up to exactly the cap", async () => {
    const dir = workdir();
    const bytes = Buffer.alloc(200 * 1024, 7);
    writeFileSync(join(dir, "big.bin"), bytes);
    const source = await resolveAttachmentPath(dir, "big.bin");
    expect((await readBoundedRegularFile(source, bytes.length)).equals(bytes)).toBe(true);
  });

  it("enforces the cap at the read when the file grows after resolution", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "grow.txt"), "1234");
    const source = await resolveAttachmentPath(dir, "grow.txt");
    appendFileSync(source, "56789");
    await expect(readBoundedRegularFile(source, 8)).rejects.toThrow("file size limit exceeded");
  });

  // A regular file whose stat size (0) understates its bytes stands in for a
  // file that grows between a size check and the read.
  it.skipIf(process.platform !== "linux")(
    "bounds bytes read rather than trusting the stat size",
    async () => {
      await expect(readBoundedRegularFile("/proc/self/status", 8)).rejects.toThrow(
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
    await expect(readBoundedRegularFile(source, 8)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("refuses directories and FIFOs without blocking", async () => {
    const dir = workdir();
    mkdirSync(join(dir, "sub"));
    execFileSync("mkfifo", [join(dir, "pipe")]);
    for (const name of ["sub", "pipe"]) {
      const source = await resolveAttachmentPath(dir, name);
      await expect(readBoundedRegularFile(source, 8)).rejects.toThrow("not a regular file");
    }
  });
});
