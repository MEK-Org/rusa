import {
  isBlockingObligationStatus,
  isTerminalObligationStatus,
  type Obligation,
  type ObligationStatus,
} from "../obligations/obligation.js";

// Strict head closure (#382, #828), as one function of durable reads and a
// run's own snapshot, so the mesh and a write operation decide it the same
// way (#1289). Inside a write operation it reads the transaction's state, so
// the verdict and the write it gates cannot be split by another write.

/**
 * The exits a strict head-obligation run has, worded once: the discipline a
 * run is told when its selection arms it.
 */
export const STRICT_HEAD_CLOSURE_EXITS =
  "complete it, cancel it, schedule it, snooze it until a future time with `set_snooze`, add a new unmet prerequisite, create a new live direct child, or write your own current checkpoint and then reassign the still-ready obligation to a distinct active actor";

/** Why one armed head does not count as closed, as returned to the run and recorded. */
export interface HeadClosureShortfall {
  obligationId: string;
  title: string | null;
  reason: string;
  /** The actionable sentence the actor is shown. */
  message: string;
}

/** The fields of a selected strict head that a handoff is judged against. */
export interface SelectedHeadSnapshot {
  ownerId: string;
  checkpoint: string | null;
  checkpointAt: string | null;
  checkpointBy: string | null;
}

/**
 * What a run recorded about its heads when it selected them. The mesh keeps
 * it in main-thread run state; a write operation is given a copy.
 */
export interface HeadClosureBaseline {
  readonly selectedHeads: ReadonlyMap<string, SelectedHeadSnapshot | null>;
  readonly preExistingChildIds: ReadonlyMap<string, ReadonlySet<string>>;
  readonly preExistingPrerequisiteIds: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Everything closure needs that is not in the database: whose run it is, the
 * heads being judged, the run's baseline, and the mesh's thread aliasing and
 * retirement state. All of it is plain data, so it can be handed to a writer.
 */
export interface HeadClosureQuery {
  /** The run's actor, already resolved. */
  readonly actorId: string;
  readonly heads: readonly string[];
  readonly baseline: HeadClosureBaseline;
  /** The thread the legacy `root` alias names, if any. */
  readonly rootId: string | null;
  /** Actors being retired right now, which the durable record cannot show. */
  readonly retiring: ReadonlySet<string>;
}

/** The durable reads closure makes. */
export interface HeadClosureReader {
  get(id: string): Obligation | null;
  listDirectChildEdges(
    parentId: string
  ): Array<{ id: string; status: ObligationStatus; creatorId: string | null }>;
  listPrerequisiteEdges(
    dependentId: string
  ): Array<{ prerequisiteId: string; status: ObligationStatus }>;
  /** The actor's durable record status, or undefined when it has none. */
  actorStatus(actorId: string): string | undefined;
}

/**
 * Every head in `query.heads` that is not closed. A head is closed when it is
 * terminal, snoozed, handed off with this run's checkpoint, or waiting on a
 * new live direct child or a new unmet prerequisite. Snoozes whose deadline
 * has passed must already have been cleared, so they no longer excuse a head.
 */
export function evaluateHeadClosure(
  reader: HeadClosureReader,
  query: HeadClosureQuery
): HeadClosureShortfall[] {
  const { actorId, baseline } = query;
  const resolve = (id: string) => (id === "root" && query.rootId ? query.rootId : id);
  const shortfalls: HeadClosureShortfall[] = [];
  for (const obligationId of new Set(query.heads)) {
    const obligation = reader.get(obligationId);
    if (!obligation || !isBlockingObligationStatus(obligation.status)) continue;
    if (obligation.snoozedUntil !== null) continue;

    let reason: string | null;
    if (obligation.status === "ready") {
      reason = strictHandoffShortfall(
        reader,
        query,
        resolve,
        obligation,
        baseline.selectedHeads.get(obligationId) ?? null
      );
    } else {
      const preExistingChildren = baseline.preExistingChildIds.get(obligationId) ?? new Set();
      const hasNewlyCreatedLiveChild = reader
        .listDirectChildEdges(obligationId)
        .some(
          (child) =>
            child.creatorId === actorId &&
            !isTerminalObligationStatus(child.status) &&
            !preExistingChildren.has(child.id)
        );
      const preExistingPrerequisites =
        baseline.preExistingPrerequisiteIds.get(obligationId) ?? new Set();
      const hasNewlyAddedUnmetPrerequisite = reader
        .listPrerequisiteEdges(obligationId)
        .some(
          (prerequisite) =>
            !preExistingPrerequisites.has(prerequisite.prerequisiteId) &&
            !isTerminalObligationStatus(prerequisite.status)
        );
      reason =
        hasNewlyCreatedLiveChild || hasNewlyAddedUnmetPrerequisite
          ? null
          : "obligation is waiting on pre-existing work but gained neither a newly created live direct child nor a newly added unmet prerequisite during this run";
    }
    if (reason !== null)
      shortfalls.push(headClosureShortfall(obligationId, obligation.title, reason));
  }
  return shortfalls;
}

export function headClosureShortfall(
  obligationId: string,
  title: string | null,
  reason: string
): HeadClosureShortfall {
  return {
    obligationId,
    title,
    reason,
    message: `selected head obligation ${obligationId} ("${title ?? obligationId}") was not finished or decomposed. Reason: ${reason}. Every selected head must ${STRICT_HEAD_CLOSURE_EXITS}.`,
  };
}

/**
 * Why a still-ready strict head does not count as handed off by this run, or
 * null when it does (#420).
 *
 * A handoff is the outgoing owner's own act: the run started with this actor
 * owning the head, the head now belongs to a distinct actor that can be
 * woken, and the checkpoint it carries was written by this actor during the
 * run. The selection-time owner is load-bearing rather than a restatement of
 * the run's actor: head attention is delivered to the owner, but ownership can
 * move between delivery and selection (an ancestor reassigns it elsewhere),
 * and without the snapshot such a run could return closed on a transfer it
 * never performed. The checkpoint is compared against the same snapshot so a
 * standing left from an earlier run cannot stand in for this one.
 *
 * The obligation row and the ready-head transition are already committed by
 * the repository before this runs, which is what makes the disposition
 * durable: the live listener delivers the recipient's attention in-process,
 * and boot reconciliation restores it if the process is interrupted between
 * that commit and the wake.
 */
function strictHandoffShortfall(
  reader: HeadClosureReader,
  query: HeadClosureQuery,
  resolve: (id: string) => string,
  obligation: Obligation,
  selected: SelectedHeadSnapshot | null
): string | null {
  const outgoingActorId = query.actorId;
  const recipientId = resolve(obligation.ownerId);
  if (recipientId === outgoingActorId) return "obligation is still ready";
  const moved = `obligation is still ready and moved to ${obligation.ownerId}`;
  if (!selected) {
    return `${moved}, but it could not be read when selected, so the transfer cannot be attributed to this run`;
  }
  if (resolve(selected.ownerId) !== outgoingActorId) {
    return `${moved}, but this actor did not own it when selected, so the transfer is not this run's handoff`;
  }
  if (!obligation.checkpoint || obligation.checkpointBy !== outgoingActorId) {
    return `${moved} without a checkpoint written by this actor`;
  }
  if (
    obligation.checkpoint === selected.checkpoint &&
    obligation.checkpointAt === selected.checkpointAt &&
    obligation.checkpointBy === selected.checkpointBy
  ) {
    return `${moved} with a checkpoint left over from before this run rather than rewritten during it`;
  }
  if (!isWakeableRecipient(reader, query, resolve, obligation.ownerId)) {
    return `${moved}, which is not an active actor that can be woken`;
  }
  return null;
}

/**
 * Whether a handoff recipient will ever be woken for the work: an actor in
 * the tree — not a human or system principal, which no inbox serves — whose
 * durable record is active and which is not mid-retirement. The durable
 * record is used rather than liveness on purpose: an active recipient may be
 * between process restart and rehydration, when the committed ready-head
 * transition is exactly what restores its queue. Retirement is the one
 * non-restart state that record cannot show.
 */
function isWakeableRecipient(
  reader: HeadClosureReader,
  query: HeadClosureQuery,
  resolve: (id: string) => string,
  ownerId: string
): boolean {
  if (ownerId.startsWith("system:")) return false;
  const id = resolve(ownerId);
  return reader.actorStatus(id) === "active" && !query.retiring.has(id);
}
