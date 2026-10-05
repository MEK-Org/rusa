/**
 * The Git identity mesh-owned commits are made under (#894, #909).
 *
 * The only source is the explicit `gitIdentity` pair in rusa's own config.yaml.
 * No Git config file is consulted: a host's global identity may be a person's,
 * and presenting it as the mesh would misattribute that person. An absent,
 * blank, partial or unusable pair resolves to a concrete gap that actors report
 * instead of committing. Actors apply a resolved identity per command with
 * `git -c`, so no Git config file is written.
 */

export interface MeshGitIdentity {
  name: string;
  email: string;
}

export type MeshGitIdentityResolution =
  | { identity: MeshGitIdentity; gap?: undefined }
  | { identity: null; gap: string };

// A Git command can't carry these intact. Git stores an identity as one
// `Name <email>` line and silently strips `<`, `>` and line breaks from it, so the
// commit would not record the configured value. A NUL byte can't be passed in a
// process argument at all, so `-c user.name=…` can't be run with it.
const UNCARRIABLE = /[<>\n\r\0]/;

function field(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Resolve config.yaml's `gitIdentity` to a complete pair or a stated gap. */
export function resolveMeshGitIdentity(configured: unknown): MeshGitIdentityResolution {
  if (configured === undefined || configured === null) {
    return { identity: null, gap: "config.yaml has no gitIdentity" };
  }
  if (typeof configured !== "object" || Array.isArray(configured)) {
    return { identity: null, gap: "config.yaml gitIdentity is not a mapping of name and email" };
  }
  const { name: rawName, email: rawEmail } = configured as Record<string, unknown>;
  const name = field(rawName);
  const email = field(rawEmail);
  const missing = [name ? null : "name", email ? null : "email"].filter(Boolean);
  if (!name || !email) {
    return { identity: null, gap: `config.yaml gitIdentity lacks ${missing.join(" and ")}` };
  }
  if (UNCARRIABLE.test(name) || UNCARRIABLE.test(email)) {
    return {
      identity: null,
      gap: "config.yaml gitIdentity contains <, >, a line break or a NUL byte, which a Git command cannot carry intact",
    };
  }
  return { identity: { name, email } };
}

/** `git` options that set author and committer for one command only. */
export function meshGitIdentityArgs(identity: MeshGitIdentity): string[] {
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}
