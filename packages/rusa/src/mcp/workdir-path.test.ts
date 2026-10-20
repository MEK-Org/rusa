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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  exactFileStream,
  openBoundedRegularFile,
  readBoundedRegularFile,
  resolveAttachmentPath,
  resolveDownloadPath,
  streamNewFileInWorkdir,
} from "./workdir-path.js";

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
});

describe("openBoundedRegularFile and exactFileStream", () => {
  async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
    return chunks;
  }

  it("streams exactly the sized bytes in bounded chunks with their digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-exact-stream-"));
    const content = Buffer.alloc(200 * 1024, 7);
    writeFileSync(join(dir, "big.bin"), content);
    const { handle, bytes } = await openBoundedRegularFile(dir, join(dir, "big.bin"), 300 * 1024);
    try {
      expect(bytes).toBe(content.length);
      const { stream, sha256 } = exactFileStream(handle, bytes);
      expect(sha256).toThrow("not been read to its end");
      const chunks = await drain(stream);
      expect(chunks.length).toBe(4);
      expect(Math.max(...chunks.map((c) => c.byteLength))).toBe(64 * 1024);
      expect(Buffer.concat(chunks).equals(content)).toBe(true);
      expect(sha256()).toBe(createHash("sha256").update(content).digest("hex"));
    } finally {
      await handle.close();
    }
  });

  it("refuses oversized, non-regular and symlinked sources before reading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-exact-stream-"));
    writeFileSync(join(dir, "big.bin"), "123456789");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "real.txt"), "ok");
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
    await expect(openBoundedRegularFile(dir, join(dir, "big.bin"), 8)).rejects.toThrow(
      "file size limit exceeded: file is larger than 8 bytes"
    );
    await expect(openBoundedRegularFile(dir, join(dir, "sub"), 8)).rejects.toThrow(
      "not a regular file"
    );
    await expect(openBoundedRegularFile(dir, join(dir, "link.txt"), 8)).rejects.toThrow();
  });

  it("errors when the file grows or shrinks after it was sized", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rusa-exact-stream-"));
    writeFileSync(join(dir, "grow.txt"), "abc");
    writeFileSync(join(dir, "shrink.txt"), "abcdef");
    const grow = await openBoundedRegularFile(dir, join(dir, "grow.txt"), 100);
    const shrink = await openBoundedRegularFile(dir, join(dir, "shrink.txt"), 100);
    try {
      appendFileSync(join(dir, "grow.txt"), "d");
      writeFileSync(join(dir, "shrink.txt"), "ab");
      await expect(drain(exactFileStream(grow.handle, grow.bytes).stream)).rejects.toThrow(
        "file changed while it was read: it grew"
      );
      await expect(drain(exactFileStream(shrink.handle, shrink.bytes).stream)).rejects.toThrow(
        "file changed while it was read: it shrank"
      );
    } finally {
      await grow.handle.close();
      await shrink.handle.close();
    }
  });
});
