import { z } from "zod";
import {
  asGitHubTarget,
  GITHUB_OWNER_MAX,
  GITHUB_REPO_MAX,
  parseReference,
  type Reference,
} from "../references/reference.js";

export const OBLIGATION_STATUSES = ["ready", "waiting", "done", "cancelled", "scheduled"] as const;

export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

/**
 * A principal's id. Its kind comes from principal storage, not its spelling.
 */
export type EntityId = string;

/**
 * An obligation's identity claim: "this obligation *is* that external object".
 * Restricted to a GitHub owner, repository, issue or pull request, and unique
 * across live obligations — which is exactly why it is not the same relation as
 * an attached artifact, where many obligations may cite one thing.
 */
export type ObligationExternalRef = Reference;

/** The event predicates v1 can use to finish an obligation. */
export type CompletionMatcherKind = "pr_merged" | "deployed";

/**
 * Versioned, application-validated data stored in a matcher's `spec_json`:
 * the matcher's specification plus, once satisfied, the observation recorded
 * at satisfaction.
 */
export interface CompletionMatcherSpec {
  schemaVersion: 1;
  /**
   * The terminal note observed at satisfaction (e.g. which instance saw the
   * deployed revision). Present exactly when the matcher's `satisfied_at` is
   * set; replacing or clearing the matcher drops it with the other
   * satisfaction columns.
   */
  satisfiedNote?: string;
}

/** The one opt-in matcher currently attached to an obligation, if any. */
export interface CompletionMatcher {
  kind: CompletionMatcherKind;
  /** A canonical PR reference for `pr_merged`, or a 40-hex commit for `deployed`. */
  target: string;
  spec: CompletionMatcherSpec;
  setBy: EntityId;
  setAt: string;
  satisfiedAt: string | null;
  satisfiedRef: string | null;
  closedUnmergedAt: string | null;
}

/**
 * The stored `pr_merged` target. GitHub owner and repository names are
 * case-insensitive, so the canonical form is lowercase and the webhook lookup
 * can use the `(kind, target)` index with an exact comparison.
 */
export function canonicalPullRequestTarget(repo: string, number: number): string {
  return `github:${repo.toLowerCase()}/pulls/${number}`;
}

/** Model-facing shape accepted by the create/set matcher boundary. */
export type CompletionMatcherInput =
  | { kind: "pr_merged"; pr: string }
  | { kind: "deployed"; commit: string };

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
  /** An explicit event→done predicate. It never changes `externalRef`. */
  completionMatcher: CompletionMatcher | null;
  status: ObligationStatus;
  /** Explicit override; null means inherit from the nearest prioritized ancestor. */
  priority: number | null;
  /** Resolved priority used for cross-owner ordering. */
  effectivePriority: number;
  /** Obligation whose explicit priority supplies effectivePriority. */
  prioritySourceId: string;
  /**
   * Locally marks this row responsive (#531). Null does not override ancestry:
   * a descendant of responsive work stays responsive.
   */
  responsive: boolean | null;
  /**
   * Whether this obligation (or an ancestor it inherits from) is responsive:
   * ready/assignment attention for it is delivered as immediately responsive
   * inbox work. Resolved dynamically from ancestry, the same way
   * {@link effectivePriority} is — reparenting into or out of a responsive
   * subtree changes this with no write to the row.
   */
  effectiveResponsive: boolean;
  /**
   * How many ready-attention episodes this obligation has started (0 = never).
   * Initialized to 1 at migration 0049 for rows already in `ready`, 0 for unready rows.
   * An episode starts on each transition into `ready`, and when a snooze on a
   * row that is already `ready` expires or is cleared (#722): the row did not
   * change status, but it became actionable again. Each episode is a new
   * round of responsive attention: the
   * behind-head announcement is deduped per (obligation, episode), so a
   * recurring responsive obligation re-armed behind a persistent head, or a
   * non-recurring one cycling waiting→ready more than once, announces once per
   * episode instead of being swallowed by the previous episode's dedupe key.
   */
  readyCount: number;
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
  /**
   * Where this obligation's work actually stands right now, in its owner's
   * words. Owner-rewritten and replace-only: reading it is reading the current
   * standing, never a history to replay (#302).
   *
   * `null` means no standing has been recorded — an obligation nobody has
   * checkpointed yet, one written before the field existed, or one whose owner
   * cleared it. All three are the same fact, and the store cannot tell them
   * apart.
   *
   * {@link checkpointAt} and {@link checkpointBy} are non-null exactly when
   * this is: a stamp with nothing stamped would say a standing exists when it
   * does not.
   */
  checkpoint: string | null;
  /** When the current checkpoint was written (ISO-8601); null with it. */
  checkpointAt: string | null;
  /** Which entity wrote the current checkpoint; null with it. */
  checkpointBy: EntityId | null;
  recurrencePolicy: "completion_interval" | "cron" | null;
  recurrenceCron: string | null;
  recurrenceIntervalSeconds: number | null;
  nextReadyAt: string | null;
  /**
   * Owner-set deferral deadline (ISO-8601 UTC), or null when not snoozed (#722).
   *
   * A snooze keeps the underlying {@link status}: a snoozed obligation still
   * blocks its parent and dependents exactly as before, and dependency
   * satisfaction never looks at this field. It only defers *automatic ready
   * attention* — the owner's ready head, responsive ready delivery, and the
   * strict head closure check — until the deadline. Events still wake the
   * owner. It survives reassignment (the new owner holds it) and recurrence
   * (completion keeps it); final `done`/`cancelled` clears it.
   */
  snoozedUntil: string | null;
  /**
   * Whether the `obligation_completions` ledger contains any rows, regardless
   * of whether recurrence is still enabled. This keeps a terminal obligation
   * with retained history reachable without making every core obligation read
   * count the whole ledger; exact counts belong to completion-page metadata.
   */
  hasCompletionHistory: boolean;
}

export interface ObligationCompletion {
  id: string;
  obligationId: string;
  sequence: number;
  completedAt: string;
  note: string | null;
  resolutionRef: string | null;
  nextReadyAt: string | null;
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

/** A snooze refused because this process has no timer that could end it (#722). */
export class SnoozeTimerUnavailableError extends ObligationValidationError {
  constructor(message: string) {
    super(message);
    this.name = "SnoozeTimerUnavailableError";
  }
}

const STATUSES = new Set<ObligationStatus>(OBLIGATION_STATUSES);

export function isBlockingObligationStatus(status: ObligationStatus): boolean {
  return status === "ready" || status === "waiting";
}

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

/**
 * Longest a checkpoint may be.
 *
 * Deliberately a write-boundary rule rather than a column CHECK, unlike
 * {@link OBLIGATION_TITLE_MAX}: blankness and stamp coherence are
 * representation invariants the store must never disagree with its writers
 * about, while a length limit is a judgment about what stays legible — and
 * `list_owned` returns whole obligations on every wake, so an unbounded
 * standing field would be paid for in every reader's context. 500 characters
 * is intentionally enough for the concrete head/gates/refs/next-action shape,
 * not a scratchpad: even a default 50-item page is bounded to 25,000 characters.
 * Keeping it here means retuning it is an edit, not a table rebuild.
 */
export const OBLIGATION_CHECKPOINT_MAX = 500;

/**
 * Normalize a checkpoint write: prose, or nothing.
 *
 * Whitespace-only collapses to `null` — the same coercion a terminal note
 * gets, so "no standing recorded" has exactly one representation and a caller
 * clearing with a blank string is understood rather than handed a constraint
 * error.
 */
export function normalizeCheckpoint(checkpoint: string | null | undefined): string | null {
  if (checkpoint == null) return null;
  const trimmed = checkpoint.trim();
  if (!trimmed) return null;
  if (trimmed.length > OBLIGATION_CHECKPOINT_MAX) {
    throw new ObligationValidationError(
      `obligation checkpoint cannot exceed ${OBLIGATION_CHECKPOINT_MAX} characters; ` +
        "a checkpoint is where the work stands, not the record of how it got there — " +
        "cite the detail as an artifact instead"
    );
  }
  return trimmed;
}

/**
 * Upper bound on a reassignment message (#941), on the same reasoning as
 * {@link OBLIGATION_CHECKPOINT_MAX}: it says why the obligation is arriving,
 * and the detail belongs in an artifact.
 */
export const OBLIGATION_REASSIGN_MESSAGE_MAX = 500;

/** Normalize a reassignment message: prose, or nothing. */
export function normalizeReassignMessage(message: string | null | undefined): string | null {
  if (message == null) return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  if (trimmed.length > OBLIGATION_REASSIGN_MESSAGE_MAX) {
    throw new ObligationValidationError(
      `reassignment message cannot exceed ${OBLIGATION_REASSIGN_MESSAGE_MAX} characters; ` +
        "cite the detail as an artifact instead"
    );
  }
  return trimmed;
}

/**
 * Whether a stored deadline (`snoozed_until`, `next_ready_at`) has come due.
 *
 * Due at the start of the deadline's minute, not its exact millisecond: `at`
 * runs jobs at minute granularity, so a wake for 09:00:30 arrives at 09:00:00.
 * Both deadlines it arms can carry seconds — a snooze keeps the caller's
 * instant, and a completion-interval `next_ready_at` is completion time plus
 * the interval — so comparing against the exact instant would make that
 * callback look early. (Cron occurrences are minute-aligned either way.)
 * Unparseable input is never due.
 */
export function isDeadlineDue(iso: string, now: Date = new Date()): boolean {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  return now.getTime() >= Math.floor(at / 60_000) * 60_000;
}

/** The actionable-ready predicate: ready, and not deferred by a snooze (#722). */
export function isReadyForAttention(
  obligation: Pick<Obligation, "status" | "snoozedUntil">
): boolean {
  return obligation.status === "ready" && obligation.snoozedUntil === null;
}

/**
 * Normalize a snooze write: a future instant as UTC ISO-8601, or `null` to
 * clear (#722).
 *
 * Only an explicit offset (`Z` or `±hh:mm`) is accepted, because a zone-less
 * wall-clock time would silently resolve in the host's zone. A deadline that is
 * already due is refused rather than treated as a clear: the caller asked to
 * defer, and a snooze that expires on arrival defers nothing. There is no upper
 * bound; how long to defer is the owner's call.
 */
export function normalizeSnoozeUntil(
  until: string | null | undefined,
  now: Date = new Date()
): string | null {
  if (until == null) return null;
  const trimmed = until.trim();
  const parsed = z.iso.datetime({ offset: true }).safeParse(trimmed);
  if (!parsed.success) {
    throw new ObligationValidationError(
      "snooze deadline must be an ISO-8601 timestamp with a timezone offset " +
        "(e.g. 2026-10-05T09:00:00Z), or null to clear the snooze"
    );
  }
  const at = new Date(trimmed);
  if (Number.isNaN(at.getTime())) {
    throw new ObligationValidationError(`snooze deadline is not a valid time: ${until}`);
  }
  const normalized = at.toISOString();
  if (isDeadlineDue(normalized, now)) {
    throw new ObligationValidationError(
      `snooze deadline must be in the future (got ${normalized}); pass null to clear a snooze`
    );
  }
  return normalized;
}

/**
 * The exact-once key for one `(dependent, prerequisite)` prerequisite edge
 * (#212).
 *
 * An obligation id is only required to be non-empty, so any delimiter is legal
 * inside one and joining a pair on a fixed separator is lossy: `("a:b", "c")`
 * and `("a", "b:c")` collapse to the same string. Both users of this key
 * deduplicate a one-shot cancellation-repair notice, so a collision does not
 * merely look untidy — it drops one dependent owner's prompt entirely.
 * Length-prefixing each component keeps the pair recoverable from the
 * encoding, so distinct pairs are always distinct keys.
 */
export function prerequisiteEdgeKey(dependentId: string, prerequisiteId: string): string {
  return `${dependentId.length}:${dependentId}${prerequisiteId.length}:${prerequisiteId}`;
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

/**
 * Mutation kinds corresponding to the six tracked lifecycle fields (#185, #722).
 *
 * Maps directly to whichever tracked field changed on this obligation row
 * ("reassign" for ownerId, "reparent" for parentId, "priority" for priority,
 * "status" for status, "external_ref" for externalRef, "snooze" for
 * snoozedUntil).
 *
 * If a single mutation touches multiple tracked fields on the same row (such as
 * reparenting to root without explicit priority, which clears parentId and sets
 * priority), the mutation kind reflects the highest-precedence changed field
 * (`owner > parent > priority > status > external_ref > snooze`).
 *
 * Collateral updates to distinct rows (such as parent readiness status demotions
 * or promotions) record the exact field modified on that row ("status").
 * Consuming code inspecting exact field transitions should inspect the keys of
 * `before` and `after` in the versioned payload.
 */
export const OBLIGATION_MUTATION_KINDS = [
  "reassign",
  "reparent",
  "priority",
  "status",
  "external_ref",
  "snooze",
  "checkpoint",
] as const;

export type ObligationMutationKind = (typeof OBLIGATION_MUTATION_KINDS)[number];

/**
 * Tracked fields on an obligation row whose changes are recorded in history.
 *
 * These represent sparse deltas: only fields that changed in this mutation
 * are present in `before` and `after`. Absent fields were unchanged, not unset.
 */
export interface ObligationHistoryState {
  checkpoint?: string | null;
  ownerId?: string;
  parentId?: string | null;
  priority?: number | null;
  status?: ObligationStatus;
  externalRef?: string | null;
  /** Immutable terminal explanation captured with a status transition. */
  terminalNote?: string | null;
  /** Immutable resolution citation captured with a status transition. */
  resolutionRef?: string | null;
  /** Snooze deadline (#722); null when not snoozed. */
  snoozedUntil?: string | null;
  /**
   * Why a reassignment was made (#941), given by the acting principal. Not a
   * tracked column: it exists only on the `after` side of the owner change it
   * accompanied.
   */
  message?: string;
}

/**
 * One immutable, attributable mutation history record (#185).
 */
export interface ObligationHistoryEntry {
  id: number;
  obligationId: string;
  mutationKind: ObligationMutationKind;
  actingPrincipal: EntityId;
  timestamp: string;
  before: ObligationHistoryState;
  after: ObligationHistoryState;
}

/**
 * Original payload version. Detail history fields use version 2; readers accept both.
 * The schema carries no SQLite json_* validator; consuming code validates
 * and owns schema evolution at this boundary.
 */
export const OBLIGATION_HISTORY_SCHEMA_VERSION = 1;

/**
 * Lift a throwing domain validator into a zod check, so a history field is held
 * to the same spelling of the rule its live column is read under. If that rule
 * ever grows, history follows without a second copy to keep in step.
 */
function validatedBy(validate: (value: string) => unknown) {
  return z.string().superRefine((value, ctx) => {
    try {
      validate(value);
    } catch (err) {
      ctx.addIssue({
        code: "custom",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * A `parentId` is an obligation id, not an {@link EntityId}: it is only required
 * to be non-empty (see {@link prerequisiteEdgeKey}). The live column is a
 * foreign key, so this can only ever reject a hand-edited payload.
 */
const historyObligationIdSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "obligation id is required");

/**
 * Tracked-field values as they were, validated at the read boundary (#185).
 *
 * `ownerId` is read under the same {@link validateEntityId} as the live row.
 * `externalRef` is held to the reference *grammar* only, deliberately short of
 * {@link parseExternalRef}'s identity policy: that policy governs what a live
 * claim may be, while history records what the claim *was*. Correcting a live
 * ref after the policy narrows appends the refused value here as `before`, and
 * an append-only log cannot be fixed up afterwards, so policy is not a
 * trip-wire for reading it.
 *
 * Validation is fail-closed for the whole `listHistory` call, the same as every
 * other repository reader (`rows.map(toObligation)`): an audit trail that
 * silently drops the rows it cannot read is worse than one that refuses.
 */
export const obligationHistoryStateSchema = z
  .object({
    checkpoint: z.string().nullable().optional(),
    ownerId: validatedBy(validateEntityId).optional(),
    parentId: historyObligationIdSchema.nullable().optional(),
    priority: z.number().nullable().optional(),
    status: z.enum(OBLIGATION_STATUSES).optional(),
    externalRef: validatedBy(parseObligationReference).nullable().optional(),
    terminalNote: z.string().nullable().optional(),
    resolutionRef: validatedBy(parseObligationReference).nullable().optional(),
    snoozedUntil: z.iso.datetime().nullable().optional(),
    message: z.string().optional(),
  })
  .strict();

/** Fields only payload version 2 may carry. */
function hasDetailField(state: ObligationHistoryState): boolean {
  return state.checkpoint !== undefined || state.message !== undefined;
}

export const obligationHistoryPayloadSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    before: obligationHistoryStateSchema,
    after: obligationHistoryStateSchema,
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.schemaVersion === 1 && [payload.before, payload.after].some(hasDetailField)) {
      ctx.addIssue({ code: "custom", message: "detail history fields require schemaVersion 2" });
    }
  });

export interface ObligationHistoryPayload {
  schemaVersion: 1 | 2;
  before: ObligationHistoryState;
  after: ObligationHistoryState;
}

export function buildHistoryPayload(
  before: ObligationHistoryState,
  after: ObligationHistoryState
): string {
  return JSON.stringify({
    schemaVersion: [before, after].some(hasDetailField) ? 2 : OBLIGATION_HISTORY_SCHEMA_VERSION,
    before,
    after,
  });
}

export function parseHistoryPayload(json: string): ObligationHistoryPayload {
  try {
    const raw = JSON.parse(json);
    return obligationHistoryPayloadSchema.parse(raw);
  } catch (cause) {
    throw new ObligationValidationError(
      `invalid obligation history payload: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
}

/**
 * The stored shape of one history row, validated whole at the read boundary.
 *
 * The table constrains its scalars only to "non-empty", because a CHECK is a
 * migration to change and the set of mutation kinds is expected to grow. That
 * makes the row's TypeScript type a claim the database does not enforce, so each
 * field's typed claim is validated here instead — the same place and for the same
 * reason the JSON half is checked. `acting_principal` is validated into `EntityId`
 * via `validateEntityId` (matching `toObligation` for `owner_id`), `timestamp` is
 * strictly parsed as ISO-8601 UTC, and `mutation_kind` is validated against the
 * closed set of enum kinds. Validating one half and casting the other would let a
 * hand-edited or future-version row arrive at a caller typed as something it is
 * not.
 */
const obligationHistoryRowSchema = z
  .object({
    id: z.number().int().positive(),
    obligation_id: z.string().trim().min(1),
    mutation_kind: z.enum(OBLIGATION_MUTATION_KINDS),
    acting_principal: z.string().trim().min(1),
    timestamp: z.iso.datetime(),
    payload: z.string(),
  })
  .strict();

/** Validate one stored history row, scalars and payload alike, into its entry. */
export function parseHistoryRow(row: unknown): ObligationHistoryEntry {
  let parsed: z.infer<typeof obligationHistoryRowSchema>;
  try {
    parsed = obligationHistoryRowSchema.parse(row);
  } catch (cause) {
    throw new ObligationValidationError(
      `invalid obligation history row: ${cause instanceof Error ? cause.message : String(cause)}`
    );
  }
  const payload = parseHistoryPayload(parsed.payload);
  return {
    id: parsed.id,
    obligationId: parsed.obligation_id,
    mutationKind: parsed.mutation_kind,
    actingPrincipal: validateEntityId(parsed.acting_principal),
    timestamp: parsed.timestamp,
    before: payload.before,
    after: payload.after,
  };
}
