/**
 * One reference grammar for every external thing the mesh points at.
 *
 * `<scheme>:<path>` — **our** canonical path for the provider's resource, not
 * the provider's own URL. That distinction is the whole design:
 *
 *   github:MEK-Org/rusa                              a repository
 *   github:MEK-Org/rusa/issues/33                    an issue
 *   github:MEK-Org/rusa/issues/33/comments/12345     a comment on it
 *   github:MEK-Org/rusa/pulls/76                     a pull request
 *   github:MEK-Org/rusa/pulls/76/reviews/9001        a review on it
 *   gchat:spaces/AAAA/messages/BBBB                  a Google Chat message
 *   mesh:messages/<uuid>                             a mesh chat message
 *   mesh:actors/<actor id>/inbox/<entry id>          an actor's inbox entry
 *
 * **The path is alternating `collection/id` pairs.** GitHub resources are
 * rooted at the repository's standard `OWNER/REPO` name — which is the
 * universal identifier for a repo (git remotes, `gh`, package.json), not a URL
 * path — and every level below it is a pair. Google Chat resource names are
 * already pairs. So containment and parenthood are structural, with no
 * per-entity special cases.
 *
 * **Provider wrinkles stop at the boundary.** GitHub addresses a PR at
 * `/pull/76` but its issues at `/issues/33`, and an issue comment only as an
 * HTML anchor (`#issuecomment-12345`). Adopting either would import an
 * inconsistency into a grammar whose value comes from being uniform. This
 * codebase already does this translation elsewhere and it is the right shape:
 * GitHub delivers issue and PR comments under one `issue_comment` event, and
 * the webhook layer splits them into our own `{kind: "comment", scope}` model
 * (see `commands/start.ts`). {@link referenceUrl} is the mirror of that — a
 * projection *out* to a browsable URL, where the singular `/pull/` and the
 * `#issuecomment-` anchor are reconstructed. Nothing upstream of it knows.
 *
 * Three properties are the point:
 *
 * 1. **The vocabulary stops growing with integration × entity.** One scheme per
 *    integration, the entity in the path. Adding discussions or releases costs
 *    nothing. The previous grammar needed an enum member per pair, which is why
 *    a bare `github_comment:<id>` came out an orphan naming no issue.
 * 2. **Containment is a prefix test** ({@link isDescendantOf}) rather than a
 *    hand-written switch per kind — which is what `event-subscriptions.ts`
 *    currently spends `resourceKey`, `sameResource`, `parentOf` and
 *    `isSubResourceOf` on.
 * 3. **One spelling.** An abbreviated alternate was considered and rejected:
 *    dedupe is string equality (`UNIQUE(obligation_id, ref)`, `resolution_ref`
 *    as text), and a model writing either spelling would produce duplicate
 *    citations for one thing.
 */

/** Integrations that can be referenced. One per external system, not per entity. */
export const REFERENCE_SCHEMES = ["github", "gchat", "mesh"] as const;

export type ReferenceScheme = (typeof REFERENCE_SCHEMES)[number];

export interface Reference {
  scheme: ReferenceScheme;
  /** Path segments after the scheme, in order, each nonempty. */
  segments: readonly string[];
  /** The canonical `<scheme>:<path>` string. */
  key: string;
}

export class InvalidReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReferenceError";
  }
}

const SCHEMES = new Set<string>(REFERENCE_SCHEMES);

/**
 * How many leading segments name the scheme's root resource. Everything after
 * is `collection/id` pairs.
 *
 * GitHub is 2 because `OWNER/REPO` is one identifier; the others are 0 because
 * their paths are pairs from the start.
 */
const ROOT_SEGMENTS: Record<ReferenceScheme, number> = {
  github: 2,
  gchat: 0,
  mesh: 0,
};

/**
 * Parse and canonicalize a reference.
 *
 * Segments are preserved verbatim rather than case-folded. GitHub treats owner
 * and repo case-insensitively, but folding would make a stored ref stop
 * matching what a person wrote, and the display case is what they will
 * recognise in a citation.
 */
export function parseReference(value: string): Reference {
  const trimmed = value.trim();
  if (!trimmed) throw new InvalidReferenceError("reference is required");

  const separator = trimmed.indexOf(":");
  if (separator <= 0) {
    throw new InvalidReferenceError(
      `reference must be <scheme>:<path>, scheme one of: ${REFERENCE_SCHEMES.join(", ")}`
    );
  }
  const scheme = trimmed.slice(0, separator);
  if (!SCHEMES.has(scheme)) {
    throw new InvalidReferenceError(
      `unsupported reference scheme: ${scheme} (expected one of: ${REFERENCE_SCHEMES.join(", ")})`
    );
  }

  const rawPath = trimmed.slice(separator + 1);
  if (/\s/.test(rawPath)) {
    throw new InvalidReferenceError("reference cannot contain whitespace");
  }
  if (rawPath.includes("#")) {
    // A provider's HTML anchor is not an identifier. Comments are addressed by
    // path here, e.g. github:OWNER/REPO/issues/33/comments/12345.
    throw new InvalidReferenceError(
      "reference cannot contain '#'; address the sub-resource by path instead"
    );
  }

  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === "")) {
    throw new InvalidReferenceError("reference path segments must be nonempty");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    // Relative segments would let two different strings denote one resource,
    // which breaks the string-equality dedupe the grammar rests on.
    throw new InvalidReferenceError("reference path cannot contain relative segments");
  }
  const root = ROOT_SEGMENTS[scheme as ReferenceScheme];
  if (segments.length < Math.max(root, 1)) {
    throw new InvalidReferenceError(
      `a ${scheme} reference needs at least ${root || 1} path segment(s)`
    );
  }
  if ((segments.length - root) % 2 !== 0) {
    throw new InvalidReferenceError(
      `a ${scheme} reference must be ${root ? "OWNER/REPO followed by " : ""}collection/id pairs`
    );
  }

  return {
    scheme: scheme as ReferenceScheme,
    segments,
    key: `${scheme}:${segments.join("/")}`,
  };
}

/** True when `value` parses; for validation boundaries that want a boolean. */
export function isReference(value: string): boolean {
  try {
    parseReference(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The containing resource, or null at the root of a scheme.
 *
 * Uniformly "drop the trailing collection/id pair", because the grammar is
 * pairs all the way down. A GitHub repository's parent is its owner, the one
 * place a single segment is dropped.
 */
export function referenceParent(reference: Reference): Reference | null {
  const root = ROOT_SEGMENTS[reference.scheme];
  const segments = [...reference.segments];
  if (segments.length > root) {
    segments.length = segments.length - 2;
  } else if (segments.length > 1) {
    segments.length = segments.length - 1;
  } else {
    return null;
  }
  if (segments.length === 0) return null;
  return {
    scheme: reference.scheme,
    segments,
    key: `${reference.scheme}:${segments.join("/")}`,
  };
}

/**
 * Whether `child` is `ancestor` or lives under it.
 *
 * The prefix test the path grammar exists to make possible: a repository
 * subscription covering an issue event, an issue's obligation covering a
 * comment cited on it. Segment-wise rather than string-prefix, so
 * `github:o/rusa-x` is not read as living under `github:o/rusa`.
 */
export function isDescendantOf(child: Reference, ancestor: Reference): boolean {
  if (child.scheme !== ancestor.scheme) return false;
  if (ancestor.segments.length > child.segments.length) return false;
  return ancestor.segments.every((segment, i) => segment === child.segments[i]);
}

/** GitHub's two issue-shaped collections, in our vocabulary (both plural). */
export type GitHubIssueCollection = "issues" | "pulls";

/** A GitHub issue or pull request, destructured for callers that need its parts. */
export interface GitHubIssueReference {
  owner: string;
  repo: string;
  collection: GitHubIssueCollection;
  number: number;
}

/**
 * Read a reference as a GitHub issue or pull request, or null if it is anything
 * else — including a sub-resource of one, such as a comment.
 *
 * Kept separate from {@link parseReference} because most callers only need the
 * opaque canonical string; only those building API calls or deriving event
 * sources need the pieces.
 */
export function asGitHubIssue(reference: Reference): GitHubIssueReference | null {
  if (reference.scheme !== "github") return null;
  if (reference.segments.length !== 4) return null;
  const [owner, repo, collection, rawNumber] = reference.segments;
  if (collection !== "issues" && collection !== "pulls") return null;
  if (!/^[1-9]\d*$/.test(rawNumber)) return null;
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number)) return null;
  return { owner, repo, collection, number };
}

/**
 * Project a reference out to a browsable URL, when its scheme has one.
 *
 * This is the one place a provider's URL quirks are reconstructed: GitHub
 * addresses a pull request at singular `/pull/`, and a comment only as an
 * anchor on its parent. Keeping that here means the grammar upstream stays
 * uniform — the same split the webhook layer makes when it turns one
 * `issue_comment` event into our issue and review comment kinds.
 */
export function referenceUrl(reference: Reference): string | null {
  if (reference.scheme !== "github") return null;
  const segments = [...reference.segments];

  let anchor = "";
  const commentIndex = segments.indexOf("comments");
  if (commentIndex === segments.length - 2) {
    anchor = `#issuecomment-${segments[commentIndex + 1]}`;
    segments.length = commentIndex;
  }
  if (segments[2] === "pulls") segments[2] = "pull";

  return `https://github.com/${segments.join("/")}${anchor}`;
}
