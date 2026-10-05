/**
 * The Git identity mesh-owned commits are made under (#894).
 *
 * The source is the mesh host's own global Git configuration: `rusa init` writes
 * the identity it asks for ("for commits made by rusa") there, and every actor
 * process inherits that home. It is read, never written. Actors apply it per
 * command with `git -c`, so an identity in a repository's local config, or a
 * person's global config on a machine where an actor executes, is neither used
 * nor changed.
 */

import { execFileSync } from "node:child_process";

export interface MeshGitIdentity {
  name: string;
  email: string;
}

function readGlobal(key: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const value = execFileSync("git", ["config", "--global", "--get", key], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
      // Local file read with no lock; the timeout only bounds an exotic hung
      // filesystem from stalling mesh startup. A timeout lands in the catch
      // below and surfaces as "no identity", never as a wrong one.
      timeout: 5_000,
    }).trim();
    return value || undefined;
  } catch {
    // `git config --get` exits 1 when the key is unset.
    return undefined;
  }
}

/** The mesh's Git identity, or null when its global config lacks a name or email. */
export function resolveMeshGitIdentity(
  env: NodeJS.ProcessEnv = process.env
): MeshGitIdentity | null {
  const name = readGlobal("user.name", env);
  const email = readGlobal("user.email", env);
  return name && email ? { name, email } : null;
}

/** `git` options that set author and committer for one command only. */
export function meshGitIdentityArgs(identity: MeshGitIdentity): string[] {
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}
