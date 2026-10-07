import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve an attachment `filePath` and confine it to the calling actor's
 * workdir. Without this boundary, a chat write tool is a host-file
 * read-and-exfiltrate primitive: any path the server process can see could be
 * uploaded to a chat space. Both the workdir and the target are realpath'd so
 * `..` traversal and symlinks pointing outside the workdir are rejected, not
 * just lexical escapes; realpath on the target also surfaces ENOENT for
 * nonexistent files.
 */
export async function resolveAttachmentPath(workDir: string, filePath: string): Promise<string> {
  const realRoot = await realpath(workDir);
  const target = resolve(realRoot, filePath);
  if (!isContained(realRoot, target)) {
    throw new Error("access denied: filePath escapes the actor workdir");
  }
  const realTarget = await realpath(target);
  if (!isContained(realRoot, realTarget)) {
    throw new Error("access denied: filePath resolves outside the actor workdir");
  }
  return realTarget;
}

/**
 * Resolve a download destination inside the calling actor's workdir. The
 * parent directory must already exist and realpath inside the workdir, so a
 * symlinked directory cannot redirect the write elsewhere. This only
 * validates the name; write it with {@link writeNewFileInWorkdir}, which holds
 * the boundary at the open itself.
 */
export async function resolveDownloadPath(
  workDir: string,
  destinationPath: string
): Promise<string> {
  const realRoot = await realpath(workDir);
  const target = resolve(realRoot, destinationPath);
  if (target === realRoot || !isContained(realRoot, target)) {
    throw new Error("access denied: destinationPath escapes the actor workdir");
  }
  const realParent = await realpath(dirname(target));
  if (!isContained(realRoot, realParent)) {
    throw new Error("access denied: destinationPath resolves outside the actor workdir");
  }
  return join(realParent, basename(target));
}

/**
 * Open the parent directory of a resolved path by walking it from the
 * filesystem root one component at a time, each relative to the previous
 * directory's descriptor and without following symlinks. The path was
 * realpath'd, so it has no legitimate symlinks; one that appears in any
 * component, whether inside the workdir or above the workdir root, was swapped
 * in after resolution and is refused rather than followed out of the root. Node
 * has no openat, so lookups go through Linux's `/proc/self/fd`; without it this
 * fails closed rather than falling back to a pathname open. Returns the parent
 * handle with the final component's name, for {@link inDir}.
 */
async function openParentInWorkdir(
  workDir: string,
  confinedPath: string
): Promise<{ dir: FileHandle; name: string }> {
  const realRoot = await realpath(workDir);
  if (!isContained(realRoot, confinedPath)) {
    throw new Error("access denied: path resolves outside the actor workdir");
  }
  const names = confinedPath.split(sep).filter(Boolean);
  const name = names.pop();
  if (name === undefined) throw new Error("access denied: path names no file");
  let dir = await open(sep, DIR_FLAGS);
  try {
    const anchor = await stat(`/proc/self/fd/${dir.fd}`).catch(() => undefined);
    const fsRoot = await dir.stat();
    if (anchor?.dev !== fsRoot.dev || anchor?.ino !== fsRoot.ino) {
      throw new Error("workdir file I/O needs Linux /proc/self/fd; refusing to open by pathname");
    }
    for (const component of names) {
      const next = await open(inDir(dir, component), DIR_FLAGS).catch((err) => {
        throw refusedSwap(err, false);
      });
      const parent = dir;
      dir = next;
      await parent.close();
    }
    return { dir, name };
  } catch (err) {
    await dir.close();
    throw err;
  }
}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** `name` inside the directory `dir` holds open, independent of its current pathname. */
function inDir(dir: FileHandle, name: string): string {
  return `/proc/self/fd/${dir.fd}/${name}`;
}

function refusedSwap(err: unknown, last: boolean): unknown {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ELOOP" || (!last && code === "ENOTDIR")) {
    return Object.assign(
      new Error("access denied: a path component changed to a symlink after resolution"),
      { code }
    );
  }
  return err;
}

async function openInWorkdir(
  workDir: string,
  confinedPath: string,
  flags: number,
  mode?: number
): Promise<FileHandle> {
  const { dir, name } = await openParentInWorkdir(workDir, confinedPath);
  try {
    return await open(inDir(dir, name), flags, mode).catch((err) => {
      throw refusedSwap(err, true);
    });
  } finally {
    await dir.close();
  }
}

/**
 * Create a new file at a {@link resolveDownloadPath} result and write `data`
 * through the descriptor. The final component is created exclusively, so an
 * existing file or symlink there is refused too.
 */
export async function writeNewFileInWorkdir(
  workDir: string,
  path: string,
  data: Uint8Array
): Promise<void> {
  const handle = await openInWorkdir(
    workDir,
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o666
  );
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

async function cancelStream(stream: unknown): Promise<void> {
  if (
    stream &&
    typeof stream === "object" &&
    "cancel" in stream &&
    typeof (stream as { cancel: () => Promise<unknown> }).cancel === "function"
  ) {
    try {
      await (stream as { cancel: () => Promise<unknown> }).cancel();
    } catch (_) {}
  } else if (
    stream &&
    typeof stream === "object" &&
    "destroy" in stream &&
    typeof (stream as { destroy: () => unknown }).destroy === "function"
  ) {
    try {
      (stream as { destroy: () => unknown }).destroy();
    } catch (_) {}
  }
}

/**
 * Stream data into a new file at a {@link resolveDownloadPath} target, computing
 * sha256 and enforcing `maxBytes` on total written bytes without buffering the
 * whole payload. On any failure, including failing to create the destination,
 * the source stream is cancelled; output this call created is unlinked through
 * the same directory descriptor it was created in, and only while that name
 * still refers to the file this call wrote.
 */
export async function streamNewFileInWorkdir(
  workDir: string,
  path: string,
  stream:
    | Iterable<Uint8Array | Buffer | string>
    | AsyncIterable<Uint8Array | Buffer | string>
    | ReadableStream<Uint8Array>,
  maxBytes: number,
  noun = "file"
): Promise<{ bytes: number; sha256: string }> {
  let dir: FileHandle | undefined;
  let handle: FileHandle | undefined;
  let name = "";
  try {
    ({ dir, name } = await openParentInWorkdir(workDir, path));
    handle = await open(
      inDir(dir, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o666
    ).catch((err) => {
      throw refusedSwap(err, true);
    });
    const hash = createHash("sha256");
    let bytesWritten = 0;
    for await (const chunk of stream as AsyncIterable<Uint8Array | Buffer | string>) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytesWritten += buf.byteLength;
      if (bytesWritten > maxBytes) {
        throw new Error(`${noun} size limit exceeded: ${noun} is larger than ${maxBytes} bytes`);
      }
      hash.update(buf);
      await handle.writeFile(buf);
    }
    // A successful file-mode result promises a completed artifact, not merely
    // bytes queued in the process. Keep the bounded write path, then ask the
    // filesystem to flush before reporting its path and digest.
    await handle.sync();
    await handle.close();
    handle = undefined;
    return { bytes: bytesWritten, sha256: hash.digest("hex") };
  } catch (err) {
    await cancelStream(stream);
    if (dir && handle) await unlinkIfSame(dir, name, handle);
    throw err;
  } finally {
    await handle?.close().catch(() => {});
    await dir?.close().catch(() => {});
  }
}

/** Unlink `name` in `dir` only while it is still the file `handle` has open. */
async function unlinkIfSame(dir: FileHandle, name: string, handle: FileHandle): Promise<void> {
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(inDir(dir, name))]);
    if (opened.dev === current.dev && opened.ino === current.ino) await unlink(inDir(dir, name));
  } catch (_) {}
}

/** Point an inline-mode size rejection at file mode, which allows up to 1 GiB. */
export function withFileModeHint(err: unknown): unknown {
  if (err instanceof Error && err.message.includes("size limit exceeded")) {
    return new Error(
      `${err.message}; specify destinationPath to download up to 1 GiB to a file in your workdir`
    );
  }
  return err;
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read a confined file with a hard byte bound at the read itself, so the cap
 * holds even if the file grows or is replaced after it was resolved. The
 * handle is opened within the workdir without following any symlink and
 * nonblocking (a FIFO cannot stall the open), then must be a regular file; at
 * most `maxBytes + 1` bytes are ever read. `noun` names the file in the size
 * error, so each caller keeps its existing wording.
 */
export async function readBoundedRegularFile(
  workDir: string,
  path: string,
  maxBytes: number,
  noun = "file"
): Promise<Buffer> {
  const handle = await openInWorkdir(
    workDir,
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error("access denied: filePath is not a regular file");
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
      if (length > maxBytes) {
        throw new Error(`${noun} size limit exceeded: ${noun} is larger than ${maxBytes} bytes`);
      }
    }
    return Buffer.concat(chunks, length);
  } finally {
    await handle.close();
  }
}
