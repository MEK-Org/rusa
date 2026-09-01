import {
  asGitHubTarget,
  GITHUB_OWNER_MAX,
  GITHUB_REPO_MAX,
  parseReference,
  type Reference,
} from "../references/reference.js";

export type ObligationStatus = "ready" | "waiting" | "done" | "cancelled";

/**
 * One entity in the mesh's single id space: an actor UUID, `root`, `human:*`,
 * or `system:*`.
 *
 * Deliberately an id alone, not an id plus a `kind`. `mcp/stamp.ts` already
 * mints `human:operator` / `system:mesh` into the
 * same space actor ids live in, and `isHumanOperator(actorId)` reads the
 * category off the prefix — so a stored kind would restate what the id already
 * says, and could drift from it.
 */
export type EntityId = string;

/**
 * An obligation's identity claim: "this obligation *is* that external object".
 * Restricted to a GitHub owner, repository, issue or pull request, and unique
 * across live obligations — which is exactly why it is not the same relation as
 * an attached artifact, where many obligations may cite one thing.
 */
export type ObligationExternalRef = Reference;

export interface Obligation {
  id: string;
  parentId: string | null;
  ownerId: EntityId;
  /**
   * The heading: short, scannable in a queue, and the only part of an
   * obligation a call-list needs to show. Separate from {@link intent} because
   * one field could not be both — an actor writing the fuller statement made
   * the dashboard render five paragraphs as a card title.
   *
   * `null` only for rows that predate the split and never had an intent to
   * derive one from.
   */
  title: string | null;
  /** The fuller statement of what should become true. The body, not the heading. */
  intent: string | null;
  externalRef: ObligationExternalRef | null;
  status: ObligationStatus;
  /** Explicit override; null means inherit from the nearest prioritized ancestor. */
  priority: number | null;
  /** Resolved priority used for cross-owner ordering. */
  effectivePriority: number;
  /** Obligation whose explicit priority supplies effectivePriority. */
  prioritySourceId: string;
  /**
   * When this obligation was created (ISO-8601). `null` only for rows that
   * predate the timestamp columns and have no recoverable creation time —
   * never a stand-in for "now".
   */
  createdAt: string | null;
  /** When this obligation was last mutated (ISO-8601); see {@link createdAt}. */
  updatedAt: string | null;
  /**
   * The entity that raised this obligation. Immutable: reassignment moves
   * {@link ownerId} and leaves this alone, which is the whole point of recording
   * it (#1671). `null` means genuinely unknown — legacy rows, or a caller with
   * no identity to bind — and is never backfilled by inference from `owner`.
   */
  creatorId: EntityId | null;
  /**
   * Why this obligation reached `done` or `cancelled`, in the terminating
   * principal's own words. `null` for a live obligation, for one terminated
   * before the column existed, and for one terminated without a stated reason —
   * "no reason given" and "reason lost" are deliberately the same value, since
   * the store cannot tell them apart and should not pretend to.
   *
   * Load-bearing for cancellation and for human-owned decision children: a
   * cancelled obligation is intent that stopped being current, and a decision
   * marked done is an answer. Neither survives anywhere else in the tree.
   */
  terminalNote: string | null;
  /**
   * Which attached artifact settled this obligation — the message that answered
   * the question, the PR that delivered the work. Always also present in the
   * obligation's artifacts; this column is the denormalised "which one".
   *
   * Distinct from {@link externalRef}, which asserts *identity* ("this
   * obligation is that issue") and is unique across live obligations. A
   * resolution reference asserts only relevance, and nothing stops two
   * obligations citing the same message.
   */
  resolutionRef: string | null;
}

/** One artifact cited by an obligation. */
export interface ObligationArtifact {
  id: string;
  obligationId: string;
  /** A {@link ArtifactRef} in its canonical `kind:value` string form. */
  ref: string;
  /** Optional human-facing gloss: why this artifact is attached. */
  label: string | null;
  /** The entity that attached it, bound server-side. `null` when unknown. */
  attachedBy: EntityId | null;
  attachedAt: string;
}

export interface ObligationTree {
  obligation: Obligation;
  children: ObligationTree[];
  /** Direct, nonterminal children that mechanically keep this node waiting. */
  blockingChildren: Obligation[];
}

export class ObligationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ObligationValidationError";
  }
}

const STATUSES = new Set<ObligationStatus>(["ready", "waiting", "done", "cancelled"]);

export function isTerminalObligationStatus(status: ObligationStatus): boolean {
  return status === "done" || status === "cancelled";
}

export function assertObligationStatus(value: string): asserts value is ObligationStatus {
  if (!STATUSES.has(value as ObligationStatus)) {
    throw new ObligationValidationError(`unsupported obligation status: ${value}`);
  }
}

/** Longest an obligation heading may be; mirrors 0027's column CHECK. */
export const OBLIGATION_TITLE_MAX = 200;

/**
 * A heading is required, single-line, and short. The cap is the point rather
 * than a safety margin: an unbounded title is how `intent` ended up carrying
 * five paragraphs, so a caller that writes an essay here is told so.
 */
export function validateObligationTitle(title: string): string {
  const collapsed = title.trim();
  if (!collapsed) throw new ObligationValidationError("obligation title is required");
  if (/[\r\n]/.test(collapsed)) {
    throw new ObligationValidationError("obligation title must be a single line");
  }
  if (collapsed.length > OBLIGATION_TITLE_MAX) {
    throw new ObligationValidationError(
      `obligation title cannot exceed ${OBLIGATION_TITLE_MAX} characters; put the detail in intent`
    );
  }
  return collapsed;
}

export function validateEntityId(id: EntityId): EntityId {
  if (!id.trim()) throw new ObligationValidationError("entity id is required");
  return id;
}

/**
 * Parse a reference at an obligation boundary, surfacing the grammar's
 * complaint as an {@link ObligationValidationError}. Callers of the obligation
 * store handle one error type; which module noticed the problem is an
 * implementation detail they should not have to know.
 */
export function parseObligationReference(value: string): Reference {
  try {
    return parseReference(value);
  } catch (err) {
    throw new ObligationValidationError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Validate an obligation's identity claim.
 *
 * Narrower than {@link parseReference} on purpose: `external_ref` asserts the
 * obligation *is* the referenced object, and the store enforces one live claim
 * per ref. So it accepts only what can carry that meaning — a GitHub owner,
 * repository, issue, or pull request.
 *
 * Sub-resources are refused. A comment or review is evidence *about* something,
 * never the same thing as it; that belongs in the obligation's artifacts, where
 * many obligations may cite one thing.
 */
export function parseExternalRef(value: string): ObligationExternalRef {
  const reference = parseObligationReference(value);
  const target = asGitHubTarget(reference);
  if (!target) {
    throw new ObligationValidationError(
      "external ref must name a GitHub owner, repository, issue or pull request — " +
        "e.g. github:MEK-Org, github:MEK-Org/rusa, or github:MEK-Org/rusa/issues/33. " +
        "A comment or review is evidence about an obligation, not the same thing as " +
        "it, so attach that as an artifact instead"
    );
  }
  // GitHub's own limits, applied here rather than in the grammar so the caller
  // is told which bound it broke instead of just "not a valid target".
  if (target.owner.length > GITHUB_OWNER_MAX) {
    throw new ObligationValidationError(
      `external ref owner cannot exceed ${GITHUB_OWNER_MAX} characters`
    );
  }
  if (target.level !== "owner" && target.repo.length > GITHUB_REPO_MAX) {
    throw new ObligationValidationError(
      `external ref repository cannot exceed ${GITHUB_REPO_MAX} characters`
    );
  }
  return reference;
}
