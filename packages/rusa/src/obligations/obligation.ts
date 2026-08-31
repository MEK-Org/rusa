export type ObligationStatus = "ready" | "waiting" | "done" | "cancelled";

/**
 * One entity in the mesh's single id space: an actor UUID, `root`, `human:*`,
 * or `system:*`.
 *
 * Deliberately an id alone, not an id plus a `kind`. `mcp/stamp.ts` already
 * mints `human:operator` / `system:mesh` / `system:tracker-hygiene` into the
 * same space actor ids live in, and `isHumanOperator(actorId)` reads the
 * category off the prefix — so a stored kind would restate what the id already
 * says, and could drift from it.
 */
export type EntityId = string;

export type GitHubExternalRef = {
  kind: "github_issue" | "github_pr";
  owner: string;
  repo: string;
  number: number;
  /**
   * The canonical string form of the ref exactly as parsed
   * (`github_issue:OWNER/REPO#N` or `github_pr:OWNER/REPO#N`), preserved
   * verbatim by {@link parseExternalRef}. Used as the stable persisted
   * identifier / lookup key for the external ref (see obligation-repository).
   */
  key: string;
};

export interface Obligation {
  id: string;
  parentId: string | null;
  ownerId: EntityId;
  intent: string | null;
  externalRef: GitHubExternalRef | null;
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

const EXTERNAL_REF_RE = /^(github_issue|github_pr):([^/:#\s]+)\/([^/#\s]+)#([1-9]\d*)$/;
const STATUSES = new Set<ObligationStatus>(["ready", "waiting", "done", "cancelled"]);

export function isTerminalObligationStatus(status: ObligationStatus): boolean {
  return status === "done" || status === "cancelled";
}

export function assertObligationStatus(value: string): asserts value is ObligationStatus {
  if (!STATUSES.has(value as ObligationStatus)) {
    throw new ObligationValidationError(`unsupported obligation status: ${value}`);
  }
}

export function validateEntityId(id: EntityId): EntityId {
  if (!id.trim()) throw new ObligationValidationError("entity id is required");
  return id;
}

export function parseExternalRef(value: string): GitHubExternalRef {
  const match = EXTERNAL_REF_RE.exec(value);
  if (!match) {
    throw new ObligationValidationError(
      "external ref must be github_issue:OWNER/REPO#N or github_pr:OWNER/REPO#N"
    );
  }
  const [, kind, owner, repo, numberText] = match;
  const number = Number(numberText);
  if (!Number.isSafeInteger(number)) {
    throw new ObligationValidationError("external ref number must be a positive safe integer");
  }
  if (owner.length > 39) {
    throw new ObligationValidationError("external ref owner cannot exceed 39 characters");
  }
  if (repo.length > 100) {
    throw new ObligationValidationError("external ref repository cannot exceed 100 characters");
  }
  return {
    kind: kind as GitHubExternalRef["kind"],
    owner,
    repo,
    number,
    key: value,
  };
}
