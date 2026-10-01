import { realpath } from "node:fs/promises";
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
 * symlinked directory cannot redirect the write elsewhere; callers create the
 * file exclusively (`wx`), which also refuses an existing file or symlink at
 * the final component.
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
