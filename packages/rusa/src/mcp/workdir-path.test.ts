import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readBoundedRegularFile,
  resolveAttachmentPath,
  resolveDownloadPath,
  streamNewFileInWorkdir,
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

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
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

describe("streamNewFileInWorkdir", () => {
  it("streams chunks into a new file, computing sha256 and byte length", async () => {
    const dir = workdir();
    const destination = await resolveDownloadPath(dir, "streamed.bin");
    const chunks = [Buffer.from("hello "), Buffer.from("world")];
    const result = await streamNewFileInWorkdir(dir, destination, streamFrom(chunks));
    expect(result.bytes).toBe(11);
    expect(result.sha256).toBe(createHash("sha256").update("hello world").digest("hex"));
    expect(readFileSync(destination, "utf-8")).toBe("hello world");
  });

  it("reports its digest only after sync completes, and unlinks output when sync fails", async () => {
    const dir = workdir();
    const probe = await openFile(join(dir, "probe"), "w");
    const proto = Object.getPrototypeOf(probe);
    await probe.close();
    let finishSync: (err?: Error) => void = () => {};
    const sync = vi.spyOn(proto, "sync").mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          finishSync = (err) => (err ? reject(err) : resolve());
        })
    );
    try {
      const destination = await resolveDownloadPath(dir, "synced.bin");
      let settled = false;
      const receipt = streamNewFileInWorkdir(
        dir,
        destination,
        streamFrom([Buffer.from("complete")])
      ).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      finishSync();
      await expect(receipt).resolves.toMatchObject({ bytes: 8 });

      const failed = await resolveDownloadPath(dir, "sync-failed.bin");
      const rejected = streamNewFileInWorkdir(dir, failed, streamFrom([Buffer.from("partial")]));
      await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
      finishSync(new Error("disk full"));
      await expect(rejected).rejects.toThrow("disk full");
      expect(existsSync(failed)).toBe(false);
    } finally {
      sync.mockRestore();
    }
  });

  it("unlinks partial output when the source stream fails", async () => {
    const dir = workdir();
    const destination = await resolveDownloadPath(dir, "oversized.bin");
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(Buffer.from("partial"));
          return;
        }
        controller.error(new Error("source failed"));
      },
    });
    await expect(streamNewFileInWorkdir(dir, destination, stream)).rejects.toThrow("source failed");
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("cancels the source and keeps an existing destination it refuses to overwrite", async () => {
    const dir = workdir();
    writeFileSync(join(dir, "existing.bin"), "original");
    const destination = await resolveDownloadPath(dir, "existing.bin");
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    await expect(streamNewFileInWorkdir(dir, destination, stream)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(cancel).toHaveBeenCalled();
    expect(readFileSync(destination, "utf-8")).toBe("original");
  });

  it("removes partial output from the directory it opened after an ancestor swap", async () => {
    const dir = workdir();
    const outside = workdir();
    writeFileSync(join(outside, "partial.bin"), "unrelated");
    mkdirSync(join(dir, "sub"));
    const destination = await resolveDownloadPath(dir, "sub/partial.bin");
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(Buffer.from("first"));
          return;
        }
        renameSync(join(dir, "sub"), join(dir, "sub-moved"));
        symlinkSync(outside, join(dir, "sub"));
        controller.error(new Error("source failed"));
      },
    });
    await expect(streamNewFileInWorkdir(dir, destination, stream)).rejects.toThrow("source failed");
    expect(existsSync(join(dir, "sub-moved", "partial.bin"))).toBe(false);
    expect(readdirSync(join(dir, "sub-moved"))).toEqual([]);
    expect(readFileSync(join(outside, "partial.bin"), "utf-8")).toBe("unrelated");
  });
});
