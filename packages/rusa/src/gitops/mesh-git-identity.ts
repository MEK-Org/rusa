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

// Bounded transport, prompt and delimiter safety: Git uses `<` and `>` as ident
// envelope delimiters, LF/CR breaks the line-oriented prompt guidance and commit
// header, and NUL cannot be passed in a process argument. This provides a
// minimal safe seam, deliberately avoiding a general-purpose Git-ident validator.
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
      gap: "config.yaml gitIdentity contains <, >, a line break or a NUL byte, which is not accepted for a mesh Git identity",
    };
  }
  return { identity: { name, email } };
}

/**
 * `git` options that set identity for one command only. Supplying command-line
 * `user.*` alongside `author.*` and `committer.*` ensures the configured identity
 * wins across Git versions without a version probe: on Git 2.22+, `author.*` and
 * `committer.*` take precedence over an operator's role-specific keys, while on
 * older Git where role keys are not recognized, command-line `user.*` overrides
 * any ambient configuration.
 */
export function meshGitIdentityArgs(identity: MeshGitIdentity): string[] {
  return ["user", "author", "committer"].flatMap((role) => [
    "-c",
    `${role}.name=${identity.name}`,
    "-c",
    `${role}.email=${identity.email}`,
  ]);
}
