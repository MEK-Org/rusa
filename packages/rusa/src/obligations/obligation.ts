export type ObligationStatus = "ready" | "waiting" | "done" | "cancelled";

export type ObligationOwner = { kind: "actor"; id: string } | { kind: "human"; id: string };

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
  owner: ObligationOwner;
  intent: string | null;
  externalRef: GitHubExternalRef | null;
  status: ObligationStatus;
  /** Explicit override; null means inherit from the nearest prioritized ancestor. */
  priority: number | null;
  /** Resolved priority used for cross-owner ordering. */
  effectivePriority: number;
  /** Obligation whose explicit priority supplies effectivePriority. */
  prioritySourceId: string;
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

export function validateObligationOwner(owner: ObligationOwner): ObligationOwner {
  if (owner.kind !== "actor" && owner.kind !== "human") {
    throw new ObligationValidationError("obligation owner kind must be actor or human");
  }
  if (!owner.id.trim()) throw new ObligationValidationError("obligation owner id is required");
  return owner;
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
