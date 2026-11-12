import type Database from "better-sqlite3";
import {
  type CapabilityGrant,
  type CapabilityGrantStore,
  type CapabilityPolicy,
  effectiveCapabilities,
} from "../actor/capability-grants.js";
import type { ExperimentEnrollment, ExperimentEnrollmentStore } from "../actor/experiments.js";
import {
  assertExperimentAuthority,
  assertGrantAuthority,
  type GrantAuthorityReader,
} from "../actor/grant-authority.js";
import {
  evaluateHeadClosure,
  type HeadClosureQuery,
  type HeadClosureShortfall,
} from "../actor/head-closure.js";
import {
  assertParentExhaustedInboxAuthority,
  type ParentInboxAuthorityReader,
} from "../actor/parent-inbox-authority.js";
import { isHumanOperatorPrincipal, type RootControlPrincipal } from "../actor/root-control.js";
import type { CompletionMatcher, CompletionMatcherInput } from "../obligations/obligation.js";
import { ObligationValidationError } from "../obligations/obligation.js";
import type { ActorRepository } from "../repositories/actor-repository.js";
import type {
  InboxAppendInput,
  InboxEntry,
  MarkHandledResult,
} from "../repositories/inbox-repository.js";
import { InProcessMeshWriter, type MeshWriter } from "./mesh-writer.js";
import type { ActorRunRepository } from "./repositories/actor-run-repository.js";
import type {
  CreateObligationInput,
  ObligationMutationEffect,
  ObligationRepository,
  PriorityScope,
} from "./repositories/obligation-repository.js";
import {
  INBOX_MUTATION_EFFECT,
  type InboxMutationEffect,
  type SqliteInboxRepository,
} from "./repositories/sqlite-inbox-repository.js";
import type { WriteContext, WriteOperationTable } from "./write-worker-runtime.js";

// The mesh's write operations (#1289). Each runs whole inside the writer's
// transaction, so a state check a caller's decision depends on and the
// mutation it guards cannot be split by another write, however long the
// caller waits between submitting the write and seeing its answer.

/** The repositories a write operation reaches, over the writing connection. */
export interface MeshWriteRepos {
  readonly obligations: ObligationRepository;
  readonly inbox: SqliteInboxRepository;
  readonly actors: Pick<ActorRepository, "get">;
  readonly actorRuns: Pick<ActorRunRepository, "completedFocusEntryCounts">;
  readonly grants: CapabilityGrantStore;
  readonly experiments: Pick<ExperimentEnrollmentStore, "enroll" | "unenroll">;
}

/** What a committed write owes the main thread. */
export type MeshEffect = ObligationMutationEffect | InboxMutationEffect;

type Context = WriteContext<MeshWriteRepos, MeshEffect>;

type Recurrence =
  | { policy: "cron"; cronExpr: string }
  | { policy: "completion_interval"; intervalSeconds: number }
  | null;

type MatcherKey = Pick<CompletionMatcher, "kind" | "target" | "setAt">;

/**
 * An obligation no longer matches what its caller authorized the write
 * against, so the write was refused rather than applied to a different
 * situation. Reading the obligation again and retrying re-authorizes it.
 */
export class ObligationChangedError extends ObligationValidationError {
  constructor(message: string) {
    super(message);
    this.name = "ObligationChangedError";
  }
}

/**
 * The owner the caller meant to write to (#1289). A write made after a
 * reassignment is refused, not re-decided, so it never lands on an owner the
 * caller did not see. This protects the caller's intended target; it is not
 * authorization. Authorization is the caller's `canManage`, which reads
 * capability grants and the actor tree as well as the owner. With the
 * in-process writer that check and this commit run with nothing awaited in
 * between; the worker at F must decide it inside the transaction instead
 * (https://github.com/MEK-Org/rusa/issues/1289#issuecomment-6813364620).
 */
interface OwnerPrecondition {
  readonly expectedOwnerId?: string;
}

function assertOwner(context: Context, id: string, expectedOwnerId: string | undefined): void {
  if (expectedOwnerId === undefined) return;
  const ownerId = context.repos.obligations.require(id).ownerId;
  if (ownerId !== expectedOwnerId) {
    throw new ObligationChangedError(
      `obligation ${id} changed owner from ${expectedOwnerId} to ${ownerId} after this write was authorized; read it again and retry`
    );
  }
}

/** Run `work` with every mutation it makes emitting its effect to `context`. */
function mutating<T>(context: Context, work: (obligations: ObligationRepository) => T): T {
  const { obligations } = context.repos;
  return obligations.inWriteOperation(context, () => work(obligations));
}

/**
 * Run `work` with every obligation and inbox write it makes emitting its
 * effect to `context`, in the order the writes are made.
 */
function writing<T>(context: Context, work: (repos: MeshWriteRepos) => T): T {
  const { obligations, inbox } = context.repos;
  return obligations.inWriteOperation(context, () =>
    inbox.inWriteOperation(context, () => work(context.repos))
  );
}

/**
 * The heads in `closure` that are not closed, as the inbox mark decides it:
 * their due snoozes are cleared first, through the normal mutation path and
 * attributed to the mesh (#722), then closure is evaluated (#382). Inside a
 * write operation every read and the clearing are the transaction's.
 */
export function inboxClosureShortfalls(
  repos: Pick<MeshWriteRepos, "obligations" | "actors">,
  closure: HeadClosureQuery
): HeadClosureShortfall[] {
  const { obligations, actors } = repos;
  obligations.expireDueSnoozes(closure.heads, "system:mesh");
  return evaluateHeadClosure(
    {
      get: (id) => obligations.get(id),
      listDirectChildEdges: (id) => obligations.listDirectChildEdges(id),
      listPrerequisiteEdges: (id) => obligations.listPrerequisiteEdges(id),
      actorStatus: (id) => actors.get(id)?.status,
    },
    closure
  );
}

/** The parent-clearance check's durable reads, over the writing connection. */
function parentAuthorityReader(repos: MeshWriteRepos): ParentInboxAuthorityReader {
  return {
    actor: (id: string) => repos.actors.get(id),
    readEntry: (actorId: string, entryId: string) => repos.inbox.read(actorId, entryId),
    completedFocusEntryCounts: (actorId: string) =>
      repos.actorRuns.completedFocusEntryCounts(actorId),
  };
}

/**
 * The grant and experiment authority checks' reads, over the writing
 * connection: actor records and grant rows as this transaction sees them,
 * combined with the caller's policy (#1289 D1).
 */
function grantAuthorityReader(
  repos: Pick<MeshWriteRepos, "actors" | "grants">,
  policy: CapabilityPolicy | null
): GrantAuthorityReader {
  return {
    actor: (id) => repos.actors.get(id),
    capabilities: (id) => effectiveCapabilities(repos.grants.list(), id, policy),
  };
}

/** A parent clearing a child's exhausted inbox work. */
interface ParentClearance {
  /** The caller as it named itself; the audit note keeps this form. */
  readonly callerId: string;
  readonly childId: string;
  readonly entryIds: readonly string[];
  /** Already trimmed and non-empty. */
  readonly note: string;
  readonly rootId: string | null;
}

/**
 * The entry-id checks markHandled makes, made before anything is written: one
 * to 100 unique ids, each an entry of `actorId`.
 */
function assertMarkableEntryIds(
  repos: MeshWriteRepos,
  actorId: string,
  entryIds: readonly string[]
): void {
  if (entryIds.length < 1 || entryIds.length > 100 || new Set(entryIds).size !== entryIds.length) {
    throw new Error("markHandled requires 1 to 100 unique entry ids");
  }
  for (const id of entryIds) {
    if (!repos.inbox.read(actorId, id)) throw new Error("inbox entry not found");
  }
}

export const MESH_WRITE_OPERATIONS = {
  /**
   * Mark an actor's inbox entries handled. With `closure`, the heads those
   * entries are attention for must be closed first (#382): their due snoozes
   * are cleared and closure is decided against this transaction's state, so
   * no other write can land between the verdict and the mark. A refusal still
   * commits the cleared snoozes, as clearing them did before the check moved
   * in here, and is returned rather than thrown so it does not roll them back.
   * Entry ids that markHandled itself would reject are rejected before the
   * closure check, so an invalid request always throws and commits nothing.
   */
  "inbox.markHandled": (
    context: Context,
    input: {
      readonly actorId: string;
      readonly entryIds: string[];
      readonly note?: string;
      readonly closure?: HeadClosureQuery | null;
    }
  ):
    | { readonly refused: HeadClosureShortfall[] }
    | { readonly refused: null; readonly entries: MarkHandledResult[] } =>
    writing(context, (repos) => {
      const { closure } = input;
      if (closure && closure.heads.length > 0) {
        assertMarkableEntryIds(repos, input.actorId, input.entryIds);
        const shortfalls = inboxClosureShortfalls(repos, closure);
        if (shortfalls.length > 0) return { refused: shortfalls };
      }
      return {
        refused: null,
        entries: repos.inbox.markHandled(input.actorId, input.entryIds, undefined, input.note),
      };
    }),

  /**
   * The heads of a run that returned which are not closed (#828), decided the
   * way the inbox mark decides it: due snoozes cleared, then closure
   * evaluated, against this transaction's state. The cleared snoozes commit
   * with the answer; a write that throws rolls them back.
   */
  "obligations.closureShortfalls": (
    context: Context,
    input: { readonly closure: HeadClosureQuery }
  ): HeadClosureShortfall[] =>
    mutating(context, () => inboxClosureShortfalls(context.repos, input.closure)),

  /**
   * Append inbox entries, answering only the rows this call inserted: an id
   * already present is left as it is (#1289 C2). The inserted rows are
   * delivered to the append listeners once this commits.
   */
  "inbox.append": (
    context: Context,
    input: { readonly entries: readonly InboxAppendInput[] }
  ): InboxEntry[] => writing(context, (repos) => repos.inbox.append([...input.entries])),

  /**
   * Mark an actor's entries seen: the receipt that a queued run has taken them
   * in. Only the named entries that are still unseen and unhandled when it
   * commits are stamped, so an entry delivered after the mark was requested
   * keeps its arrival. It has no listeners to notify.
   */
  "inbox.markSeen": (
    context: Context,
    input: { readonly actorId: string; readonly entryIds: readonly string[] }
  ): InboxEntry[] => context.repos.inbox.markSeen(input.actorId, input.entryIds),

  /** A parent marks its child's exhausted entries handled, if it still may. */
  "inbox.markChildHandled": (
    context: Context,
    input: ParentClearance
  ): { childId: string; handled: MarkHandledResult[] } =>
    writing(context, (repos) => {
      const { childId, entries } = assertParentExhaustedInboxAuthority(
        parentAuthorityReader(repos),
        input
      );
      const handled = repos.inbox.markHandled(
        childId,
        entries.map((entry) => entry.id),
        undefined,
        `Marked handled by parent (${input.callerId}): ${input.note}`
      );
      return { childId, handled };
    }),

  /**
   * A parent releases its child's exhausted entries for re-handling, if it
   * still may: each is marked handled and replaced by a fresh unhandled copy.
   */
  "inbox.releaseChildSelectionLock": (
    context: Context,
    input: ParentClearance
  ): { childId: string; released: string[]; replacements: InboxEntry[] } =>
    writing(context, (repos) => {
      const { childId, entries } = assertParentExhaustedInboxAuthority(
        parentAuthorityReader(repos),
        input
      );
      const ids = entries.map((entry) => entry.id);
      const { replacements } = repos.inbox.replaceEntries(
        childId,
        ids,
        `Released by parent (${input.callerId}) for re-handling: ${input.note}`,
        entries.map((entry) => ({
          actorId: childId,
          source: entry.source,
          payload: entry.payload,
        }))
      );
      return { childId, released: ids, replacements };
    }),

  /**
   * Create an obligation. `responsiveRefusal` is the caller's answer to "may
   * this principal start a new responsive branch for this owner?": null when
   * it may, else why not. Whether the obligation starts one depends on its
   * parent's committed responsiveness, so the refusal applies only if, inside
   * this transaction, the parent is not already effectively responsive.
   */
  "obligations.create": (
    context: Context,
    input: {
      readonly obligation: CreateObligationInput;
      readonly responsiveRefusal?: string | null;
    }
  ) =>
    mutating(context, (obligations) => {
      const { obligation, responsiveRefusal } = input;
      if (
        obligation.responsive === true &&
        responsiveRefusal &&
        !(obligation.parentId && obligations.require(obligation.parentId).effectiveResponsive)
      ) {
        throw new ObligationValidationError(responsiveRefusal);
      }
      return obligations.create(obligation);
    }),

  "obligations.setTerminalStatus": (
    context: Context,
    input: {
      readonly id: string;
      readonly status: "done" | "cancelled";
      readonly note: string | null;
      readonly resolutionRef: string | null;
      readonly principal: string;
    }
  ) =>
    mutating(context, (obligations) =>
      obligations.setTerminalStatus(
        input.id,
        input.status,
        input.note,
        input.resolutionRef,
        input.principal
      )
    ),

  "obligations.setCompletionMatcher": (
    context: Context,
    input: OwnerPrecondition & {
      readonly id: string;
      readonly matcher: CompletionMatcherInput | null;
      readonly principal: string;
    }
  ) =>
    mutating(context, (obligations) => {
      assertOwner(context, input.id, input.expectedOwnerId);
      return obligations.setCompletionMatcher(input.id, input.matcher, input.principal);
    }),

  "obligations.setRecurrence": (
    context: Context,
    input: OwnerPrecondition & {
      readonly id: string;
      readonly recurrence: Recurrence;
      readonly principal: string;
    }
  ) =>
    mutating(context, (obligations) => {
      assertOwner(context, input.id, input.expectedOwnerId);
      return obligations.setRecurrence(input.id, input.recurrence, input.principal);
    }),

  "obligations.setExternalRef": (
    context: Context,
    input: OwnerPrecondition & {
      readonly id: string;
      readonly ref: string | null;
      readonly principal: string;
    }
  ) =>
    mutating(context, (obligations) => {
      assertOwner(context, input.id, input.expectedOwnerId);
      return obligations.setExternalRef(input.id, input.ref, input.principal);
    }),

  "obligations.setCheckpoint": (
    context: Context,
    input: OwnerPrecondition & {
      readonly id: string;
      readonly checkpoint: string | null;
      readonly principal: string;
    }
  ) =>
    mutating(context, (obligations) => {
      assertOwner(context, input.id, input.expectedOwnerId);
      return obligations.setCheckpoint(input.id, input.checkpoint, input.principal);
    }),

  /**
   * Set or clear a snooze. The caller has already checked, where the host
   * scheduler lives, that a timer could end it
   * ({@link ObligationRepository.assertSnoozeSchedulable}); the timer itself
   * is armed when the effect is delivered there.
   */
  "obligations.setSnooze": (
    context: Context,
    input: OwnerPrecondition & {
      readonly id: string;
      readonly until: string | null;
      readonly principal: string;
    }
  ) =>
    mutating(context, (obligations) => {
      assertOwner(context, input.id, input.expectedOwnerId);
      return obligations.writeSnooze(input.id, input.until, input.principal);
    }),

  "obligations.attachArtifact": (
    context: Context,
    input: {
      readonly id: string;
      readonly ref: string;
      readonly label: string | null;
      readonly attachedBy: string;
    }
  ) =>
    mutating(context, (obligations) =>
      obligations.attachArtifact(input.id, input.ref, {
        label: input.label,
        attachedBy: input.attachedBy,
      })
    ),

  "obligations.markResponsive": (
    context: Context,
    input: OwnerPrecondition & { readonly id: string; readonly principal: string }
  ) =>
    mutating(context, (obligations) => {
      assertOwner(context, input.id, input.expectedOwnerId);
      return obligations.markResponsive(input.id, input.principal);
    }),

  "obligations.movePriority": (
    context: Context,
    input: {
      readonly id: string;
      readonly previousId: string | null;
      readonly nextId: string | null;
      readonly principal: string;
      readonly scope?: PriorityScope;
    }
  ) =>
    mutating(context, (obligations) =>
      obligations.movePriorityInternal(
        input.id,
        input.previousId,
        input.nextId,
        input.principal,
        input.scope
      )
    ),

  "obligations.reassign": (
    context: Context,
    input: OwnerPrecondition & {
      readonly id: string;
      readonly ownerId: string;
      readonly principal: string;
      readonly message?: string | null;
    }
  ) =>
    mutating(context, (obligations) => {
      assertOwner(context, input.id, input.expectedOwnerId);
      return obligations.reassign(input.id, input.ownerId, input.principal, input.message);
    }),

  /**
   * Reparent an obligation. Moving work that is not effectively responsive
   * under an effectively responsive parent promotes it, which is decided
   * here, against committed state: only then must its owner still be
   * `promotion.expectedOwnerId`, and `promotion.refusal`, the caller's answer
   * to "may this principal promote it?", applies.
   */
  "obligations.reparent": (
    context: Context,
    input: {
      readonly id: string;
      readonly parentId: string | null;
      readonly principal: string;
      readonly promotion?: { readonly expectedOwnerId: string; readonly refusal: string | null };
    }
  ) =>
    mutating(context, (obligations) => {
      const { promotion } = input;
      if (
        promotion &&
        input.parentId &&
        obligations.require(input.parentId).effectiveResponsive &&
        !obligations.require(input.id).effectiveResponsive
      ) {
        assertOwner(context, input.id, promotion.expectedOwnerId);
        if (promotion.refusal) throw new ObligationValidationError(promotion.refusal);
      }
      return obligations.reparent(input.id, input.parentId, input.principal);
    }),

  "obligations.addPrerequisite": (
    context: Context,
    input: OwnerPrecondition & {
      readonly id: string;
      readonly prerequisiteId: string;
      readonly principal: string;
    }
  ) =>
    mutating(context, (obligations) => {
      assertOwner(context, input.id, input.expectedOwnerId);
      return obligations.addPrerequisite(input.id, input.prerequisiteId, input.principal);
    }),

  "obligations.removePrerequisite": (
    context: Context,
    input: OwnerPrecondition & {
      readonly id: string;
      readonly prerequisiteId: string;
      readonly principal: string;
    }
  ) =>
    mutating(context, (obligations) => {
      assertOwner(context, input.id, input.expectedOwnerId);
      return obligations.removePrerequisite(input.id, input.prerequisiteId, input.principal);
    }),

  /** Satisfy a completion matcher, if `expected` is still the installed one. */
  "obligations.satisfyCompletionMatcher": (
    context: Context,
    input: {
      readonly id: string;
      readonly expected: MatcherKey;
      readonly satisfaction: { readonly resolutionRef: string; readonly note: string };
    }
  ) =>
    mutating(context, (obligations) =>
      obligations.satisfyCompletionMatcher(input.id, input.expected, input.satisfaction)
    ),

  /** Record an unmerged close, if `expected` is still the installed matcher. */
  "obligations.recordCompletionMatcherClosedUnmerged": (
    context: Context,
    input: { readonly id: string; readonly expected: MatcherKey }
  ) =>
    mutating(context, (obligations) =>
      obligations.recordCompletionMatcherClosedUnmerged(input.id, input.expected)
    ),

  /**
   * Grant a capability, if the grantor still may (#1289 D1). The grantor's
   * authority is decided from this transaction's grant rows and actor tree,
   * so a revocation or reparent committed before this runs refuses it with
   * nothing written. The capability's own validity (allow-list, host-global
   * and operator-provisioned refusals, secret containment) is static and was
   * checked by the caller.
   */
  "grants.grant": (
    context: Context,
    input: { readonly grant: CapabilityGrant; readonly policy: CapabilityPolicy | null }
  ): void => {
    const { grant, policy } = input;
    assertGrantAuthority(grantAuthorityReader(context.repos, policy), {
      grantorId: grant.grantedBy,
      granteeId: grant.actorId,
      capability: grant.capability,
      verb: "grant",
    });
    context.repos.grants.grant(grant);
  },

  /** Revoke a capability, if the revoker still may (#1289 D1); see grants.grant. */
  "grants.revoke": (
    context: Context,
    input: {
      readonly actorId: string;
      readonly capability: string;
      readonly revokedBy: string;
      readonly at: string;
      readonly policy: CapabilityPolicy | null;
    }
  ): void => {
    assertGrantAuthority(grantAuthorityReader(context.repos, input.policy), {
      grantorId: input.revokedBy,
      granteeId: input.actorId,
      capability: input.capability,
      verb: "revoke",
    });
    context.repos.grants.revoke(input.actorId, input.capability, input.at);
  },

  /**
   * Set or clear an operator-provisioned grant for an actor that exists, and
   * answer the row's state as this transaction leaves it (#1289 D1). The
   * caller authenticates the operator and passes that principal; the
   * operation refuses one that is not a human operator, with the same
   * predicate the caller uses, and records it as the grantor. No actor grant
   * confers this, so no grant row is consulted to allow it.
   */
  "grants.setOperatorProvisioned": (
    context: Context,
    input: {
      readonly actorId: string;
      readonly capability: string;
      readonly active: boolean;
      readonly principal: RootControlPrincipal;
      readonly at: string;
    }
  ): { readonly known: boolean; readonly active: boolean } => {
    if (!isHumanOperatorPrincipal(input.principal)) {
      throw new Error(`only an authenticated human operator may provision ${input.capability}`);
    }
    const { grants, actors } = context.repos;
    if (!actors.get(input.actorId)) return { known: false, active: false };
    if (input.active) {
      grants.grant({
        actorId: input.actorId,
        capability: input.capability,
        grantedBy: `operator:${input.principal}`,
        grantedAt: input.at,
      });
    } else {
      grants.revoke(input.actorId, input.capability, input.at);
    }
    return { known: true, active: grants.activeFor(input.actorId).includes(input.capability) };
  },

  /**
   * Enroll an actor in an experiment, if the enroller still may and the actor
   * is not retired (#1289 D1). Answers whether this call enrolled it.
   */
  "experiments.enroll": (
    context: Context,
    input: { readonly enrollment: ExperimentEnrollment; readonly policy: CapabilityPolicy | null }
  ): boolean => {
    const { enrollment, policy } = input;
    const record = assertExperimentAuthority(grantAuthorityReader(context.repos, policy), {
      callerId: enrollment.enrolledBy,
      actorId: enrollment.actorId,
      verb: "enroll",
    });
    if (record.status === "retired") {
      throw new Error(`Cannot enroll a retired thread: ${enrollment.actorId}`);
    }
    return context.repos.experiments.enroll(enrollment);
  },

  /**
   * Remove an enrollment, if the caller still may (#1289 D1). Answers whether
   * a real enrollment was removed.
   */
  "experiments.unenroll": (
    context: Context,
    input: {
      readonly actorId: string;
      readonly experiment: string;
      readonly unenrolledBy: string;
      readonly policy: CapabilityPolicy | null;
    }
  ): boolean => {
    assertExperimentAuthority(grantAuthorityReader(context.repos, input.policy), {
      callerId: input.unenrolledBy,
      actorId: input.actorId,
      verb: "unenroll",
    });
    return context.repos.experiments.unenroll(input.actorId, input.experiment);
  },

  /** A host timer fired: activate or release whatever has come due. */
  "obligations.wakeScheduled": (
    context: Context,
    input: { readonly id: string; readonly principal: string }
  ) => mutating(context, (obligations) => obligations.wakeScheduled(input.id, input.principal)),
} satisfies WriteOperationTable<MeshWriteRepos, MeshEffect>;

export type MeshWriteOperations = typeof MESH_WRITE_OPERATIONS;

/** The writer every converted caller shares (#1289). */
export type MeshObligationWriter = MeshWriter<MeshWriteOperations>;

/**
 * Deliver one committed effect on the main thread, to the main thread's
 * repository: its listeners, retry state and host scheduler live there. An
 * obligation effect's attention sinks append through the writer, so its
 * delivery settles once those nested writes and their effects have (#1289 C2).
 */
export function deliverMeshEffect(repos: MeshWriteRepos, effect: MeshEffect): Promise<void> | void {
  if (effect.kind === INBOX_MUTATION_EFFECT) repos.inbox.deliverMutationEffect(effect);
  else return repos.obligations.deliverMutationEffect(effect);
}

/**
 * The writer over the main connection (#1289), until the write worker takes
 * over. One instance per connection: its delivery sequencer is what keeps every
 * converted caller's effects in commit order, so the process shares one.
 * Writes outside it, on the same connection and repository, remain the same
 * one writer and the same one sequence owner.
 */
export function createInProcessMeshWriter(
  db: Database.Database,
  repos: MeshWriteRepos
): MeshObligationWriter {
  repos.obligations.installHistoryCapture();
  return new InProcessMeshWriter<MeshWriteRepos, MeshEffect, MeshWriteOperations>(
    db,
    repos,
    MESH_WRITE_OPERATIONS,
    (effect) => deliverMeshEffect(repos, effect)
  );
}
