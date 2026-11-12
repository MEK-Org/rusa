import type Database from "better-sqlite3";
import type { CompletionMatcher, CompletionMatcherInput } from "../obligations/obligation.js";
import { ObligationValidationError } from "../obligations/obligation.js";
import { InProcessMeshWriter, type MeshWriter } from "./mesh-writer.js";
import type {
  CreateObligationInput,
  ObligationMutationEffect,
  ObligationRepository,
  PriorityScope,
} from "./repositories/obligation-repository.js";
import type { WriteContext, WriteOperationTable } from "./write-worker-runtime.js";

// The mesh's write operations (#1289). Each runs whole inside the writer's
// transaction, so a state check a caller's decision depends on and the
// mutation it guards cannot be split by another write, however long the
// caller waits between submitting the write and seeing its answer.

/** The repositories a write operation reaches, over the writing connection. */
export interface MeshWriteRepos {
  readonly obligations: ObligationRepository;
}

/** What a committed write owes the main thread. */
export type MeshEffect = ObligationMutationEffect;

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

export const MESH_WRITE_OPERATIONS = {
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
 * repository: its listeners, retry state and host scheduler live there.
 */
export function deliverMeshEffect(repos: MeshWriteRepos, effect: MeshEffect): void {
  repos.obligations.deliverMutationEffect(effect);
}

/**
 * The writer over the main connection (#1289), until the write worker takes
 * over. One instance per connection: its backlog is what keeps every
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
