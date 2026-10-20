import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

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
 * validates the name; write it with {@link streamNewFileInWorkdir}.
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
 * Open a path already confined by {@link resolveAttachmentPath} or
 * {@link resolveDownloadPath}. Confinement is decided at resolution; the
 * lexical check here only refuses a caller that skipped the resolver and passed
 * a path outside the workdir. It does not re-resolve symlinks, and a directory
 * renamed or replaced while a call is in flight is outside what this boundary
 * promises.
 */
async function openInWorkdir(
  workDir: string,
  confinedPath: string,
  flags: number,
  mode?: number
): Promise<FileHandle> {
  const realRoot = await realpath(workDir);
  if (!isContained(realRoot, confinedPath)) {
    throw new Error("access denied: path resolves outside the actor workdir");
  }
  return open(confinedPath, flags, mode);
}

/**
 * Stream data into a new file at a {@link resolveDownloadPath} target, computing
 * sha256 without buffering the whole payload. The client supplies a response
 * already bounded at its download limit; this helper owns only confined,
 * safe artifact publication. It opens the destination exclusively (`O_EXCL`),
 * so an existing file or symlink there is never overwritten or followed. On
 * failure, the source stream is cancelled and the partial file is unlinked.
 */
export async function streamNewFileInWorkdir(
  workDir: string,
  path: string,
  stream: ReadableStream<Uint8Array> | null
): Promise<{ bytes: number; sha256: string }> {
  let handle: FileHandle | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    handle = await openInWorkdir(
      workDir,
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o666
    );
    const hash = createHash("sha256");
    let bytesWritten = 0;
    if (stream) {
      reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        bytesWritten += value.byteLength;
        hash.update(value);
        await handle.writeFile(value);
      }
    }
    // A successful file-mode result promises a completed artifact, not merely
    // bytes queued in the process. Keep the bounded write path, then ask the
    // filesystem to flush before reporting its path and digest.
    await handle.sync();
    await handle.close();
    handle = undefined;
    return { bytes: bytesWritten, sha256: hash.digest("hex") };
  } catch (err) {
    await reader?.cancel().catch(() => {});
    if (!reader) await stream?.cancel().catch(() => {});
    if (handle) await unlink(path).catch(() => {});
    throw err;
  } finally {
    reader?.releaseLock();
    await handle?.close().catch(() => {});
  }
}

const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Read a confined file with a hard byte bound at the read itself, so the cap
 * holds even if the file grows after it was resolved. The handle is opened
 * nonblocking (a FIFO cannot stall the open) and must be a regular file; at
 * most `maxBytes + 1` bytes are ever read. `O_NOFOLLOW` refuses a
 * final-component symlink from a caller that passes an unresolved name; the
 * tool paths pass realpath'd names and do not depend on it. `noun` names the
 * file in the size error, so each caller keeps its existing wording.
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

/**
 * Open a confined regular file for a streamed read, holding the same boundary
 * as {@link readBoundedRegularFile} without reading the content. Its size at
 * open is checked against `maxBytes` and returned; {@link exactFileStream}
 * then refuses a file that grows or shrinks before it is fully read. The caller
 * owns the handle and must close it.
 */
export async function openBoundedRegularFile(
  workDir: string,
  path: string,
  maxBytes: number,
  noun = "file"
): Promise<{ handle: FileHandle; bytes: number }> {
  const handle = await openInWorkdir(
    workDir,
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("access denied: filePath is not a regular file");
    if (info.size > maxBytes) {
      throw new Error(`${noun} size limit exceeded: ${noun} is larger than ${maxBytes} bytes`);
    }
    return { handle, bytes: info.size };
  } catch (err) {
    await handle.close();
    throw err;
  }
}

/**
 * Stream exactly `bytes` bytes from an {@link openBoundedRegularFile} handle,
 * 64 KiB at a time, hashing them as they pass. The stream errors if the file
 * ends early or has bytes beyond `bytes`, so what was sized is what was sent.
 * `sha256()` is the digest once the stream has ended.
 */
export function exactFileStream(
  handle: FileHandle,
  bytes: number
): { stream: ReadableStream<Uint8Array>; sha256: () => string } {
  const hash = createHash("sha256");
  let position = 0;
  let digest: string | undefined;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (position === bytes) {
        const { bytesRead } = await handle.read(Buffer.alloc(1), 0, 1, position);
        if (bytesRead > 0) throw new Error("file changed while it was read: it grew");
        digest = hash.digest("hex");
        controller.close();
        return;
      }
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, bytes - position));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) throw new Error("file changed while it was read: it shrank");
      position += bytesRead;
      const data = chunk.subarray(0, bytesRead);
      hash.update(data);
      controller.enqueue(new Uint8Array(data));
    },
  });
  return {
    stream,
    sha256: () => {
      if (digest === undefined) throw new Error("file stream has not been read to its end");
      return digest;
    },
  };
}
