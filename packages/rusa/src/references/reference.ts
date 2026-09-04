/**
 * One reference grammar for every external thing the mesh points at.
 *
 * `<scheme>:<path>` — **our** canonical path for the provider's resource, not
 * the provider's own URL. That distinction is the whole design:
 *
 *   github:MEK-Org                                   an owner or organisation
 *   github:MEK-Org/rusa                              a repository
 *   github:MEK-Org/rusa/issues/33                    an issue
 *   github:MEK-Org/rusa/issues/33/comments/12345     a comment on it
 *   github:MEK-Org/rusa/pulls/76                     a pull request
 *   github:MEK-Org/rusa/pulls/76/reviews/9001        a review on it
 *   gchat:spaces/AAAA/messages/BBBB                  a Google Chat message
 *   mesh:messages/<uuid>                             a mesh chat message
 *   mesh:actors/<actor id>/inbox/<entry id>          an actor's inbox entry
 *
 * **The path is alternating `collection/id` pairs.** A reference may cite a
 * resource at any level, including a whole GitHub owner or repository; callers
 * that assert a narrower relation, such as an obligation identity claim, apply
 * that policy after parsing. GitHub resources below an owner are rooted at the
 * repository's standard `OWNER/REPO` name — which is the
 * universal identifier for a repo (git remotes, `gh`, package.json), not a URL
 * path — and every level below it is a pair. Google Chat resource names are
 * already pairs. So containment and parenthood are structural, with no
 * per-entity special cases.
 *
 * **Provider wrinkles stop at the boundary.** GitHub addresses a PR at
 * `/pull/76` but its issues at `/issues/33`, and a comment or review only as
 * an HTML anchor — `#issuecomment-12345` for a conversation comment,
 * `#discussion_r12345` for a diff-anchored review comment (GitHub's own split
 * between `issues/N/comments` and `pulls/N/comments`), and
 * `#pullrequestreview-9001` for a review's own summary. Adopting any of these
 * would import an inconsistency into a grammar whose value comes from being
 * uniform. This
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
 * 2. **Containment is a prefix test** ({@link isDescendantOf}) rather than the
 *    hand-written per-kind hierarchy that event subscriptions previously used.
 * 3. **One spelling.** An abbreviated alternate was considered and rejected:
 *    dedupe is string equality (`UNIQUE(obligation_id, ref)`, `resolution_ref`
 *    as text), and a model writing either spelling would produce duplicate
 *    citations for one thing.
 */

/** Integrations that can be referenced. One per external system, not per entity. */
export const REFERENCE_SCHEMES = ["github", "gchat", "mesh", "system"] as const;

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
 * GitHub is 2 because `OWNER/REPO` is one identifier; system is 1 because the root
 * resource is a top-level domain (e.g. `events`); the others are 0 because their
 * paths are pairs from the start.
 */
const ROOT_SEGMENTS: Record<ReferenceScheme, number> = {
  github: 2,
  gchat: 0,
  mesh: 0,
  system: 1,
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
  // A scheme's root may be named partially: `github:OWNER` is an organisation
  // or user, above any repository. Required for consistency as much as for
  // convenience — `referenceParent` walks a repo up to its owner, so a grammar
  // that produced owner refs but refused to parse them would contradict itself.
  const isPartialRoot =
    (root > 1 && segments.length < root) ||
    (scheme === "gchat" && segments.length === 1 && segments[0] === "spaces");
  if (segments.length < 1) {
    throw new InvalidReferenceError(`a ${scheme} reference needs at least one path segment`);
  }
  if (!isPartialRoot && (segments.length - root) % 2 !== 0) {
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
  if (reference.scheme === "gchat" && segments.length === 1 && segments[0] === "spaces") {
    return null;
  }
  if (reference.scheme === "gchat" && segments.length === 2 && segments[0] === "spaces") {
    return {
      scheme: "gchat",
      segments: ["spaces"],
      key: "gchat:spaces",
    };
  }
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

/** A GitHub branch, destructured for callers that need its parts. */
export interface GitHubBranchReference {
  owner: string;
  repo: string;
  branch: string;
}

/**
 * Read a reference as a GitHub branch, or null if it is anything else.
 */
export function asGitHubBranch(reference: Reference): GitHubBranchReference | null {
  if (reference.scheme !== "github") return null;
  if (reference.segments.length !== 4) return null;
  const [owner, repo, collection, rawBranch] = reference.segments;
  if (!owner || !repo || collection !== "branches" || !rawBranch) return null;
  try {
    return { owner, repo, branch: decodeURIComponent(rawBranch) };
  } catch {
    return null;
  }
}

/**
 * Format a canonical GitHub branch reference.
 *
 * Strips any leading `refs/heads/` prefix and URL-encodes the branch name if it
 * contains slashes.
 */
export function githubBranchReference(repo: string, branch: string): string {
  const cleanBranch = branch.replace(/^refs\/heads\//, "");
  return `github:${repo}/branches/${encodeURIComponent(cleanBranch)}`;
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
  const target = asGitHubTarget(reference);
  if (target?.level !== "issue" && target?.level !== "pull") return null;
  return {
    owner: target.owner,
    repo: target.repo,
    collection: target.level === "pull" ? "pulls" : "issues",
    number: target.number,
  };
}

/**
 * A GitHub resource an obligation may claim as its identity: an organisation or
 * user, a repository, an issue, or a pull request.
 *
 * Deliberately excludes sub-resources. A comment or a review is evidence
 * *about* something, never the same thing as it, so it belongs in the
 * obligation's artifacts rather than in its identity claim.
 */
export type GitHubTarget =
  | { level: "owner"; owner: string }
  | { level: "repo"; owner: string; repo: string }
  | { level: "issue" | "pull"; owner: string; repo: string; number: number };

/** GitHub's own limits on an owner / repository name. */
export const GITHUB_OWNER_MAX = 39;
export const GITHUB_REPO_MAX = 100;

/**
 * Read a reference as a claimable GitHub target, or null if it is anything else
 * — including a sub-resource of one.
 *
 * Answers *shape* only. Length bounds are GitHub policy rather than grammar, so
 * they live with the caller that can report which one was exceeded — a bare
 * null here would collapse "this is not a target" and "this owner name is too
 * long" into one unactionable answer.
 */
export function asGitHubTarget(reference: Reference): GitHubTarget | null {
  if (reference.scheme !== "github") return null;
  const [owner, repo, collection, rawNumber] = reference.segments;
  if (!owner) return null;

  if (reference.segments.length === 1) return { level: "owner", owner };
  if (!repo) return null;
  if (reference.segments.length === 2) return { level: "repo", owner, repo };
  if (reference.segments.length !== 4) return null;
  if (collection !== "issues" && collection !== "pulls") return null;
  if (!/^[1-9]\d*$/.test(rawNumber)) return null;
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number)) return null;
  return { level: collection === "pulls" ? "pull" : "issue", owner, repo, number };
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
  const branch = asGitHubBranch(reference);
  if (branch) {
    return `https://github.com/${branch.owner}/${branch.repo}/tree/${encodeURIComponent(branch.branch)}`;
  }
  const segments = [...reference.segments];
  // `pulls/N/comments` is GitHub's own split from `issues/N/comments`: a
  // diff-anchored review comment rather than a conversation comment, so it
  // needs the `discussion_r` anchor instead of `issuecomment`.
  const isPullRequest = segments[2] === "pulls";

  let anchor = "";
  const commentIndex = segments.indexOf("comments");
  const reviewIndex = segments.indexOf("reviews");
  if (commentIndex === segments.length - 2) {
    anchor = isPullRequest
      ? `#discussion_r${segments[commentIndex + 1]}`
      : `#issuecomment-${segments[commentIndex + 1]}`;
    segments.length = commentIndex;
  } else if (isPullRequest && reviewIndex === segments.length - 2) {
    anchor = `#pullrequestreview-${segments[reviewIndex + 1]}`;
    segments.length = reviewIndex;
  }
  if (segments[2] === "pulls") segments[2] = "pull";

  return `https://github.com/${segments.join("/")}${anchor}`;
}
