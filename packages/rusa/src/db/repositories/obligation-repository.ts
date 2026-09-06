import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  cronExprEverFires,
  isValidCronExpr,
  NonFiringCronExprError,
  nextCronOccurrence,
} from "../../actor/cron-expression.js";
import type { ObligationActivationScheduler } from "../../actor/os-scheduler.js";
import {
  assertObligationStatus,
  type EntityId,
  isBlockingObligationStatus,
  isTerminalObligationStatus,
  type Obligation,
  type ObligationArtifact,
  type ObligationStatus,
  type ObligationTree,
  ObligationValidationError,
  parseExternalRef,
  parseObligationReference,
  prerequisiteEdgeKey,
  validateEntityId,
  validateObligationTitle,
} from "../../obligations/obligation.js";

function isActorEntityId(id: EntityId): boolean {
  return !id.startsWith("human:") && !id.startsWith("system:");
}

interface ObligationRow {
  id: string;
  parent_id: string | null;
  owner_id: string;
  intent: string | null;
  external_ref: string | null;
  status: string;
  priority: number | null;
  effective_priority: number;
  priority_source_id: string;
  created_at: string | null;
  updated_at: string | null;
  creator_id: string | null;
  terminal_note: string | null;
  title: string | null;
  resolution_ref: string | null;
  recurrence_policy: "completion_interval" | "cron" | null;
  recurrence_cron: string | null;
  recurrence_interval_seconds: number | null;
  next_ready_at: string | null;
  has_completion_history: 0 | 1;
}

interface ObligationArtifactRow {
  id: string;
  obligation_id: string;
  ref: string;
  label: string | null;
  attached_by: string | null;
  attached_at: string;
}

export interface CreateObligationInput {
  id?: string;
  parentId?: string | null;
  ownerId: EntityId;
  /** The heading. Required: a node with no heading cannot appear in a call-list. */
  title: string;
  intent?: string | null;
  externalRef?: string | null;
  /** Explicit finite priority. Children inherit when omitted/null; roots default to the clock. */
  priority?: number | null;
  /**
   * The entity raising this obligation, bound by the calling server — never
   * taken from model-supplied payload (#1671 trust boundary). Omitted only by
   * callers with no identity to bind, which records an honest unknown rather
   * than inferring one from `owner`.
   */
  creatorId?: EntityId | null;
  recurrence?:
    | { policy: "cron"; cronExpr: string }
    | { policy: "completion_interval"; intervalSeconds: number }
    | null;
  /**
   * Obligations this one must wait on. Accepted in the same transaction as
   * creation (#212) so a blocked obligation can never exist as `ready`, even
   * transiently: the row is inserted `waiting` from the start when any named
   * prerequisite is not yet `done`.
   */
  blockedBy?: string[];
}

/** One entity blocked on, or unblocked by, another — see #212. */
export interface PrerequisiteAttention {
  dependentId: string;
  dependentOwnerId: EntityId;
  prerequisiteId: string;
}

export type PriorityScope = "subtree" | "self";

export interface ListOwnedObligationsOptions {
  status?: ObligationStatus;
}

export interface ListObligationsOptions {
  ownerId?: EntityId;
  status?: ObligationStatus;
  rootsOnly?: boolean;
  /**
   * Drop terminal (done/cancelled) rows that carry no reason to keep
   * surfacing them: not recurring, and no completion-ledger history. Used by
   * the dashboard's default Work tab load (#241) so a stale `capture:*` stub
   * doesn't cost a tree fetch just to be hidden client-side; recurring or
   * historied terminal rows still come through since the UI shows those by
   * default regardless of the "Show Done" toggle.
   */
  excludeQuietTerminalRoots?: boolean;
}

export interface ObligationPageOptions {
  limit: number;
  offset?: number;
}

export interface ListObligationsPageOptions extends ObligationPageOptions, ListObligationsOptions {}

export interface ChildObligationPageOptions extends ObligationPageOptions {
  blockingOnly?: boolean;
}

export interface OwnedObligationPageOptions extends ObligationPageOptions {
  status?: ObligationStatus;
}

/** An actor gained a ready head it did not previously have. */
export interface ReadyHeadChange {
  ownerId: EntityId;
  /**
   * The owner's new ready head, or `null` when they no longer have one — the
   * queue emptied, or the head became a waiting parent the moment a child was
   * filed under it.
   *
   * Emitting the disappearance matters because a consumer that collapses a
   * run's churn into one net transition cannot otherwise tell "still the head"
   * from "stopped being the head": it would announce a head that had already
   * gone waiting, which is precisely what a live root did on 2026-08-30 when it
   * created a root obligation and immediately nested a child under it.
   */
  head: Obligation | null;
  /**
   * The head this one displaced, or `null` when the owner had no ready head.
   *
   * Carried because `head` alone cannot tell "this obligation reached the head
   * for the first time" from "it reached the head again after being displaced",
   * and a consumer that deduplicates on head identity needs to.
   */
  previousHeadId: string | null;
  /** Monotonically increasing sequence number for head changes on this owner. */
  sequence?: number;
}

export interface ObligationPage {
  obligations: Obligation[];
  total: number;
  hasMore: boolean;
}

export interface RetirementInheritanceResult {
  ready: number;
  waiting: number;
  scheduled: number;
}

const EFFECTIVE_PRIORITY_CTE = `
  WITH RECURSIVE effective_priority(id, effective_priority, priority_source_id) AS (
    SELECT id, priority, id
    FROM obligations
    WHERE parent_id IS NULL
    UNION ALL
    SELECT child.id,
           COALESCE(child.priority, parent.effective_priority),
           CASE WHEN child.priority IS NULL THEN parent.priority_source_id ELSE child.id END
    FROM obligations child
    JOIN effective_priority parent ON parent.id = child.parent_id
  )
`;

const PROJECTED_OBLIGATION = `
  SELECT obligation.*,
         effective_priority.effective_priority,
         effective_priority.priority_source_id,
         EXISTS(
           SELECT 1
           FROM obligation_completions
           WHERE obligation_id = obligation.id
         ) AS has_completion_history
  FROM obligations obligation
  JOIN effective_priority ON effective_priority.id = obligation.id
`;

function validatePriority(priority: number): number {
  if (!Number.isFinite(priority)) {
    throw new ObligationValidationError("obligation priority must be finite");
  }
  return priority;
}

function adjacentFloat(value: number, direction: "up" | "down"): number {
  if (value === 0) return direction === "up" ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const towardGreaterBits = value > 0 ? bits + 1n : bits - 1n;
  const towardLesserBits = value > 0 ? bits - 1n : bits + 1n;
  view.setBigUint64(0, direction === "up" ? towardGreaterBits : towardLesserBits);
  return view.getFloat64(0);
}

function priorityAfter(value: number): number {
  const plusOne = value + 1;
  return Number.isFinite(plusOne) && plusOne > value ? plusOne : adjacentFloat(value, "up");
}

function priorityBefore(value: number): number {
  const minusOne = value - 1;
  return Number.isFinite(minusOne) && minusOne < value ? minusOne : adjacentFloat(value, "down");
}

function strictMidpoint(low: number, high: number): number | null {
  const midpoint = low < 0 && high > 0 ? low / 2 + high / 2 : low + (high - low) / 2;
  return Number.isFinite(midpoint) && midpoint > low && midpoint < high ? midpoint : null;
}

function validatePage(options: ObligationPageOptions): { limit: number; offset: number } {
  const offset = options.offset ?? 0;
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
    throw new ObligationValidationError("obligation page limit must be an integer from 1 to 100");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ObligationValidationError(
      "obligation page offset must be a nonnegative safe integer"
    );
  }
  return { limit: options.limit, offset };
}

/**
 * A terminal note is free prose or nothing. Whitespace-only input collapses to
 * NULL so "no reason given" has exactly one representation — the same invariant
 * 0026's CHECK enforces at the column, kept here so a caller gets the coercion
 * rather than a constraint error.
 */
function normalizeTerminalNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  const trimmed = note.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toObligation(row: ObligationRow): Obligation {
  assertObligationStatus(row.status);
  return {
    id: row.id,
    parentId: row.parent_id,
    ownerId: validateEntityId(row.owner_id),
    intent: row.intent,
    externalRef: row.external_ref === null ? null : parseExternalRef(row.external_ref),
    status: row.status,
    priority: row.priority,
    effectivePriority: validatePriority(row.effective_priority),
    prioritySourceId: row.priority_source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    creatorId: row.creator_id,
    terminalNote: row.terminal_note,
    title: row.title,
    resolutionRef: row.resolution_ref,
    recurrencePolicy: row.recurrence_policy,
    recurrenceCron: row.recurrence_cron,
    recurrenceIntervalSeconds: row.recurrence_interval_seconds,
    nextReadyAt: row.next_ready_at,
    hasCompletionHistory: row.has_completion_history === 1,
  };
}

function toArtifact(row: ObligationArtifactRow): ObligationArtifact {
  return {
    id: row.id,
    obligationId: row.obligation_id,
    ref: row.ref,
    label: row.label,
    attachedBy: row.attached_by,
    attachedAt: row.attached_at,
  };
}

/** Internal persistence boundary for the R3-ratified obligation contract . */
export class ObligationRepository {
  constructor(
    private readonly db: Database.Database,
    private actorExists?: (actorId: string) => boolean,
    private readonly now: () => number = Date.now
  ) {}

  private scheduler?: ObligationActivationScheduler;

  /**
   * Obligation ids whose OS scheduler job needs re-deriving once the current
   * `mutate()` transaction commits. `spawnSync`-backed cron/`at` writes are
   * not transactional — calling them from inside `db.transaction()` risks a
   * committed job for a policy the database then rolls back, or a torn-down
   * job for a policy the database keeps. Recording the id and reconciling it
   * against the *committed* row afterward keeps the OS job derived from
   * durable truth instead of racing it.
   */
  private dirtyScheduleIds = new Set<string>();

  /** A transient OS write failure gets two bounded post-commit re-derivations. */
  private scheduleReconcileRetry(ids: readonly string[], attemptsRemaining = 2): void {
    if (!this.scheduler || attemptsRemaining <= 0 || ids.length === 0) return;
    setTimeout(() => {
      const failed: string[] = [];
      for (const id of ids) {
        try {
          this.reconcileObligationSchedule(id);
        } catch (err) {
          failed.push(id);
          console.warn(
            `[obligations] retry failed to reconcile scheduled activation for ${id}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
      this.scheduleReconcileRetry(failed, attemptsRemaining - 1);
    }, 0);
  }

  private markScheduleDirty(id: string): void {
    if (this.scheduler) this.dirtyScheduleIds.add(id);
  }

  /** Re-derive `id`'s OS scheduler job from its committed row. */
  private reconcileObligationSchedule(id: string): void {
    if (!this.scheduler) return;
    const row = this.db
      .prepare(
        `SELECT status, recurrence_policy, recurrence_cron, next_ready_at FROM obligations WHERE id = ?`
      )
      .get(id) as
      | {
          status: string;
          recurrence_policy: string | null;
          recurrence_cron: string | null;
          next_ready_at: string | null;
        }
      | undefined;

    if (
      row &&
      row.recurrence_policy === "cron" &&
      row.recurrence_cron &&
      row.status !== "cancelled" &&
      row.status !== "done"
    ) {
      this.scheduler.scheduleObligationActivation(id, {
        kind: "cron",
        cronExpr: row.recurrence_cron,
      });
    } else if (row && row.status === "scheduled" && row.next_ready_at) {
      this.scheduler.scheduleObligationActivation(id, {
        kind: "at",
        date: new Date(row.next_ready_at),
      });
    } else {
      this.scheduler.cancelObligationActivation(id);
    }
  }

  setOsScheduler(scheduler: ObligationActivationScheduler): void {
    this.scheduler = scheduler;
  }

  reconcileScheduledObligations(): void {
    if (!this.scheduler) return;
    const validIds = new Set<string>();

    // A cron policy keeps one tagged crontab entry alive across every status
    // except cancelled/done — ready/waiting callbacks are a no-op activation
    // (`activateScheduled` only acts on `scheduled`), so the job stays armed
    // rather than being torn down and reinstalled each cycle. A
    // completion_interval obligation instead gets a one-off `at` job, and only
    // while `scheduled` with a `next_ready_at` to fire at; an occurrence that
    // is already overdue (e.g. the process was down) activates immediately
    // rather than being handed back to the OS scheduler in the past.
    const stmt = this.db.prepare(
      `SELECT id, status, recurrence_policy, recurrence_cron, next_ready_at FROM obligations WHERE recurrence_policy = 'cron' OR status = 'scheduled'`
    );

    for (const row of stmt.all() as {
      id: string;
      status: string;
      recurrence_policy: string | null;
      recurrence_cron: string | null;
      next_ready_at: string | null;
    }[]) {
      try {
        if (
          row.recurrence_policy === "cron" &&
          row.recurrence_cron &&
          row.status !== "cancelled" &&
          row.status !== "done"
        ) {
          validIds.add(row.id);
          this.scheduler.scheduleObligationActivation(row.id, {
            kind: "cron",
            cronExpr: row.recurrence_cron,
          });
        } else if (row.status === "scheduled" && row.next_ready_at) {
          const nextDate = new Date(row.next_ready_at);
          if (nextDate.getTime() <= this.now()) {
            this.activateScheduled(row.id);
          } else {
            validIds.add(row.id);
            this.scheduler.scheduleObligationActivation(row.id, {
              kind: "at",
              date: nextDate,
            });
          }
        }
      } catch (err) {
        // One row's OS scheduler failure — e.g. `at` confirmed unavailable at
        // boot (AtUnavailableError) — must not abort reconciliation for every
        // other row, cron-backed or not, queued behind it.
        console.warn(
          `[obligations] failed to reconcile scheduled activation for ${row.id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    try {
      for (const id of this.scheduler.listObligationActivations()) {
        if (!validIds.has(id)) {
          this.scheduler.cancelObligationActivation(id);
        }
      }
    } catch (err) {
      console.warn(
        `[obligations] failed to reconcile orphaned OS-scheduled activations: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  /**
   * Notified when an ACTOR owner gains a ready head it did not have before.
   *
   * Set after construction rather than injected: the mesh that consumes this
   * does not exist yet when the repository container is built.
   */
  private readyHeadListener?: (change: ReadyHeadChange) => void;

  /**
   * Supply the actor-existence probe after construction.
   *
   * Needed because the production container is built from a `Database` alone,
   * before the actor repository is wired — which is why the constructor argument
   * was never passed there, leaving the guard inert on every production path
   * while reading as if it applied.
   */
  setActorExists(probe: (actorId: string) => boolean): void {
    this.actorExists = probe;
  }

  setReadyHeadListener(listener: ((change: ReadyHeadChange) => void) | undefined): void {
    this.readyHeadListener = listener;
  }

  /**
   * Notified once per (dependent, prerequisite) edge left dangling by a
   * prerequisite reaching `cancelled` (#212). Unlike ready-head, this is a
   * one-shot fact rather than a continuously-recomputed transition — a
   * cancellation happens exactly once — so it needs no sequence number, and a
   * caller wanting restart-safe delivery should key its own durable side
   * effect off `(dependentId, prerequisiteId)` and reconcile at boot from
   * {@link listPrerequisiteCancellationAttention}.
   */
  private cancellationAttentionListener?: (attention: PrerequisiteAttention) => void;

  /**
   * Obligation ids whose prerequisite just landed on `cancelled` this
   * transaction, pending listener delivery once it commits — mirrors
   * {@link dirtyScheduleIds}: a cancellation is not undone by a rollback, and a
   * later mutation in the same transaction cannot un-notify it, so recording
   * the fact here and firing after commit is what keeps delivery matched to
   * durable state instead of racing it.
   */
  private pendingCancellationAttention: PrerequisiteAttention[] = [];

  /**
   * `(dependentId, prerequisiteId)` keys whose cancellation-attention delivery
   * threw on a previous {@link mutate} call (#212) — e.g. a transient inbox
   * append failure. Kept only as keys, not the stale payload: the next
   * mutation re-derives each one from current persisted truth via
   * {@link listPrerequisiteCancellationAttention} before retrying, so a
   * dependent's owner is repaired within this process rather than only after
   * a restart, and a pair that stopped being live (edge removed, dependent
   * went terminal) is dropped instead of retried forever.
   */
  private failedCancellationAttentionKeys = new Set<string>();

  private cancellationAttentionKey(attention: PrerequisiteAttention): string {
    return prerequisiteEdgeKey(attention.dependentId, attention.prerequisiteId);
  }

  setCancellationAttentionListener(
    listener: ((attention: PrerequisiteAttention) => void) | undefined
  ): void {
    this.cancellationAttentionListener = listener;
  }

  /**
   * Every live dependent currently blocked on a cancelled prerequisite,
   * derived fresh from persisted state rather than a separate ledger — a
   * cancellation is permanent, so "is this edge still dangling" is always just
   * "does the prerequisite's row still say cancelled". Used to reconcile
   * durable attention at boot, the same role {@link readyHeadTransitions} plays
   * for ready-head attention.
   */
  listPrerequisiteCancellationAttention(): PrerequisiteAttention[] {
    const rows = this.db
      .prepare(
        `SELECT op.dependent_id AS dependent_id, dependent.owner_id AS dependent_owner_id,
                op.prerequisite_id AS prerequisite_id
         FROM obligation_prerequisites op
         JOIN obligations dependent ON dependent.id = op.dependent_id
         JOIN obligations prerequisite ON prerequisite.id = op.prerequisite_id
         WHERE prerequisite.status = 'cancelled'
           AND dependent.status IN ('ready', 'waiting', 'scheduled')`
      )
      .all() as Array<{
      dependent_id: string;
      dependent_owner_id: string;
      prerequisite_id: string;
    }>;
    return rows.map((row) => ({
      dependentId: row.dependent_id,
      dependentOwnerId: row.dependent_owner_id,
      prerequisiteId: row.prerequisite_id,
    }));
  }

  /**
   * Current ready head per owner, keyed by owner id.
   *
   * "Head" is the first row of the owner's ready queue, which must stay
   * byte-identical to `listOwned`'s ordering (effective priority, then id) or
   * an actor would be told about a head its own queue does not show first.
   */
  /**
   * Current ready head per owner, keyed by owner id.
   *
   * "Head" is the first row of the owner's ready queue, which must stay
   * byte-identical to `listOwned`'s ordering (effective priority, then id) or
   * an actor would be told about a head its own queue does not show first.
   */
  readyHeads(): Map<string, string> {
    const rows = this.db
      .prepare(
        `${EFFECTIVE_PRIORITY_CTE}
         SELECT owner_id, id FROM (
           SELECT obligation.owner_id,
                  obligation.id,
                  ROW_NUMBER() OVER (
                    PARTITION BY obligation.owner_id
                    ORDER BY effective_priority.effective_priority, obligation.id
                  ) AS rank
           FROM obligations obligation
           JOIN effective_priority ON effective_priority.id = obligation.id
           WHERE obligation.status = 'ready'
         )
         WHERE rank = 1`
      )
      .all() as Array<{ owner_id: string; id: string }>;
    return new Map(rows.map((row) => [row.owner_id, row.id]));
  }

  /**
   * Current ready head transition records per owner, persisted transactionally in SQLite.
   */
  readyHeadTransitions(): Array<{
    ownerId: EntityId;
    headId: string;
    previousHeadId: string | null;
    sequence: number;
  }> {
    const rows = this.db
      .prepare(
        `SELECT owner_id, head_id, previous_head_id, sequence
         FROM obligation_ready_heads
         WHERE head_id IS NOT NULL`
      )
      .all() as Array<{
      owner_id: string;
      head_id: string;
      previous_head_id: string | null;
      sequence: number;
    }>;
    return rows.map((row) => ({
      ownerId: row.owner_id,
      headId: row.head_id,
      previousHeadId: row.previous_head_id,
      sequence: row.sequence,
    }));
  }

  /**
   * The single mutation seam: one transaction, with ready-head tracking around it.
   *
   * Every state-changing repository method routes through here, so a new
   * mutation cannot be added that commits without being observed — the same
   * reason `updated_at` is set at every UPDATE rather than left to a caller.
   *
   * Ready-head transitions are written transactionally inside SQLite to
   * guarantee durability across restarts and process downtime.
   */
  private mutate<T>(work: () => T): T {
    const changes: ReadyHeadChange[] = [];
    this.dirtyScheduleIds.clear();
    this.pendingCancellationAttention = [];
    const result = this.db.transaction(() => {
      const before = this.readyHeads();
      const res = work();
      const after = this.readyHeads();

      for (const ownerId of before.keys()) {
        if (!after.has(ownerId) && isActorEntityId(ownerId)) {
          const previousHeadId = before.get(ownerId) ?? null;
          const now = this.stamp();
          this.db
            .prepare(
              `UPDATE obligation_ready_heads
               SET head_id = NULL,
                   previous_head_id = ?,
                   sequence = sequence + 1,
                   updated_at = ?
               WHERE owner_id = ?`
            )
            .run(previousHeadId, now, ownerId);

          const seqRow = this.db
            .prepare(`SELECT sequence FROM obligation_ready_heads WHERE owner_id = ?`)
            .get(ownerId) as { sequence: number } | undefined;
          const sequence = seqRow?.sequence ?? 1;

          changes.push({ ownerId, head: null, previousHeadId, sequence });
        }
      }

      for (const [ownerId, headId] of after) {
        const previousHeadId = before.get(ownerId) ?? null;
        if (previousHeadId === headId) continue;
        if (!isActorEntityId(ownerId)) continue;
        const head = this.get(headId);
        if (!head) continue;

        const now = this.stamp();
        this.db
          .prepare(
            `INSERT INTO obligation_ready_heads (owner_id, head_id, previous_head_id, sequence, updated_at)
             VALUES (?, ?, ?, 1, ?)
             ON CONFLICT(owner_id) DO UPDATE SET
               previous_head_id = excluded.previous_head_id,
               head_id = excluded.head_id,
               sequence = sequence + 1,
               updated_at = excluded.updated_at`
          )
          .run(ownerId, headId, previousHeadId, now);

        const seqRow = this.db
          .prepare(`SELECT sequence FROM obligation_ready_heads WHERE owner_id = ?`)
          .get(ownerId) as { sequence: number } | undefined;
        const sequence = seqRow?.sequence ?? 1;

        changes.push({ ownerId, head, previousHeadId, sequence });
      }

      return res;
    })();

    const listener = this.readyHeadListener;
    if (listener) {
      for (const change of changes) {
        try {
          listener(change);
        } catch (err) {
          console.warn(
            `[obligations] ready-head listener failed for ${change.ownerId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }

    const cancellationAttentionListener = this.cancellationAttentionListener;
    if (cancellationAttentionListener) {
      const toDeliver = [...this.pendingCancellationAttention];
      const queuedKeys = new Set(toDeliver.map((a) => this.cancellationAttentionKey(a)));

      // A prior mutation's delivery may have thrown (e.g. a transient inbox
      // append failure) — retry it here from current persisted truth rather
      // than the stale payload that failed, so it is repaired within this
      // process instead of only after a restart reconciles it.
      if (this.failedCancellationAttentionKeys.size > 0) {
        const stillFailing = new Set(this.failedCancellationAttentionKeys);
        for (const attention of this.listPrerequisiteCancellationAttention()) {
          const key = this.cancellationAttentionKey(attention);
          if (!this.failedCancellationAttentionKeys.has(key) || queuedKeys.has(key)) continue;
          toDeliver.push(attention);
          queuedKeys.add(key);
          stillFailing.delete(key);
        }
        // Anything left here no longer matches a live dangling edge — the
        // edge was removed, or the dependent went terminal — so there is
        // nothing left to retry.
        for (const key of stillFailing) this.failedCancellationAttentionKeys.delete(key);
      }

      for (const attention of toDeliver) {
        const key = this.cancellationAttentionKey(attention);
        try {
          cancellationAttentionListener(attention);
          this.failedCancellationAttentionKeys.delete(key);
        } catch (err) {
          this.failedCancellationAttentionKeys.add(key);
          console.warn(
            `[obligations] cancellation-attention listener failed for ${attention.dependentId}: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
      }
    }
    this.pendingCancellationAttention = [];

    // OS scheduler side effects run only now, against the state the
    // transaction actually committed — never inside it, where a later
    // rollback couldn't take them back with it.
    const toReconcile = Array.from(this.dirtyScheduleIds);
    this.dirtyScheduleIds.clear();
    const failedReconciliations: string[] = [];
    for (const id of toReconcile) {
      try {
        this.reconcileObligationSchedule(id);
      } catch (err) {
        failedReconciliations.push(id);
        console.warn(
          `[obligations] failed to reconcile scheduled activation for ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    this.scheduleReconcileRetry(failedReconciliations);

    return result;
  }

  /**
   * The wall-clock stamp for a write, in the ISO-8601 shape `mesh_events` uses.
   *
   * Derived from the injected clock so tests can pin it, and read once per
   * statement rather than once per transaction: two mutations in one
   * transaction are two mutations, and collapsing them would make an
   * `updated_at` comparison lie about which write was last.
   */
  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private assertFiringCronExpr(expr: string): void {
    if (!isValidCronExpr(expr)) throw new ObligationValidationError("invalid cron expression");
    if (!cronExprEverFires(expr)) throw new NonFiringCronExprError(expr);
  }

  create(input: CreateObligationInput): Obligation {
    return this.mutate(() => {
      const stampedAt = this.stamp();
      const creatorId = input.creatorId == null ? null : validateEntityId(input.creatorId);
      const id = input.id ?? randomUUID();
      if (!id.trim()) throw new ObligationValidationError("obligation id is required");
      const parentId = input.parentId ?? null;
      if (parentId === id) throw new ObligationValidationError("obligation cannot parent itself");
      const ownerId = validateEntityId(input.ownerId);
      const title = validateObligationTitle(input.title);
      if (isActorEntityId(ownerId) && this.actorExists && !this.actorExists(ownerId)) {
        throw new ObligationValidationError(`actor owner does not exist: ${ownerId}`);
      }

      const recurrence = input.recurrence;
      if (recurrence?.policy === "cron") this.assertFiringCronExpr(recurrence.cronExpr);
      if (
        recurrence?.policy === "completion_interval" &&
        (!Number.isInteger(recurrence.intervalSeconds) || recurrence.intervalSeconds <= 0)
      ) {
        throw new ObligationValidationError("recurrence interval must be a positive integer");
      }

      // PROVISIONAL ISSUE_NUM Q72: human IDs are opaque nonempty handles; no registry exists yet.
      const externalRef =
        input.externalRef == null ? null : parseExternalRef(input.externalRef).key;

      if (parentId !== null) {
        const parent = this.get(parentId);
        if (!parent)
          throw new ObligationValidationError(`parent obligation not found: ${parentId}`);
        if (isTerminalObligationStatus(parent.status)) {
          throw new ObligationValidationError("cannot add a child to a terminal obligation");
        }
      }

      const priority =
        input.priority == null
          ? parentId === null
            ? validatePriority(this.now())
            : null
          : validatePriority(input.priority);

      // Resolve and validate every declared prerequisite before writing
      // anything (#212): a blocked obligation must be inserted `waiting`
      // outright, never inserted `ready` and corrected a moment later, or a
      // ready-head diff computed inside this same transaction could still
      // observe it as ready.
      const prerequisiteIds = [...new Set(input.blockedBy ?? [])];
      if (recurrence != null && prerequisiteIds.length > 0) {
        throw new ObligationValidationError(
          "recurring or scheduled obligations cannot participate in prerequisite edges"
        );
      }
      const prerequisites: Obligation[] = [];
      for (const prerequisiteId of prerequisiteIds) {
        if (prerequisiteId === id) {
          throw new ObligationValidationError("obligation cannot be blocked by itself");
        }
        const prerequisite = this.get(prerequisiteId);
        if (!prerequisite) {
          throw new ObligationValidationError(
            `prerequisite obligation not found: ${prerequisiteId}`
          );
        }
        this.assertEligiblePrerequisite(prerequisite);
        // The row being created doesn't exist yet, so it can't be reached by
        // {@link wouldCreateCycle} directly — but once inserted it will add a
        // parent-waits-for-child edge from `parentId`. Naming a prerequisite
        // that can already reach `parentId` would close that loop the moment
        // the insert below lands, so it is rejected before it can.
        //
        // `parentId === prerequisiteId` is the degenerate case of that same
        // loop and needs its own check: {@link wouldCreateCycle} asks whether
        // `parentId` is reachable *from* `prerequisiteId` by following edges
        // out of it, which is never true of a node reaching itself unless a
        // self-loop already exists — so naming the new parent as a
        // prerequisite would otherwise slip through un-rejected.
        if (parentId !== null && prerequisiteId === parentId) {
          throw new ObligationValidationError(
            `prerequisite would create a cycle in the wait-for graph: ${prerequisiteId}`
          );
        }
        if (parentId !== null && this.wouldCreateCycle(parentId, prerequisiteId)) {
          throw new ObligationValidationError(
            `prerequisite would create a cycle in the wait-for graph: ${prerequisiteId}`
          );
        }
        prerequisites.push(prerequisite);
      }
      const initialStatus: ObligationStatus = prerequisites.every((p) => p.status === "done")
        ? "ready"
        : "waiting";

      try {
        this.db
          .prepare(
            `INSERT INTO obligations (id, parent_id, owner_id, title, intent, external_ref, status, priority,
                created_at, updated_at, creator_id, recurrence_policy, recurrence_cron, recurrence_interval_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            parentId,
            ownerId,
            title,
            input.intent ?? null,
            externalRef,
            initialStatus,
            priority,
            stampedAt,
            stampedAt,
            creatorId,
            input.recurrence?.policy ?? null,
            input.recurrence?.policy === "cron" ? input.recurrence.cronExpr : null,
            input.recurrence?.policy === "completion_interval"
              ? input.recurrence.intervalSeconds
              : null
          );
        if (input.recurrence?.policy === "cron") {
          this.markScheduleDirty(id);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("UNIQUE constraint failed: obligations.external_ref")
        ) {
          throw new ObligationValidationError(
            `a nonterminal obligation already uses external ref: ${externalRef}`
          );
        }
        throw error;
      }

      for (const prerequisite of prerequisites) {
        this.db
          .prepare(
            `INSERT INTO obligation_prerequisites (dependent_id, prerequisite_id) VALUES (?, ?)`
          )
          .run(id, prerequisite.id);
        if (prerequisite.status === "cancelled") {
          this.pendingCancellationAttention.push({
            dependentId: id,
            dependentOwnerId: ownerId,
            prerequisiteId: prerequisite.id,
          });
        }
      }

      if (parentId !== null) {
        this.db
          .prepare(
            "UPDATE obligations SET status = 'waiting', updated_at = ? WHERE id = ? AND status = 'ready'"
          )
          .run(this.stamp(), parentId);
      }

      return this.require(id);
    });
  }

  /** Reject a prerequisite v1 cannot yet express readiness against (#212). */
  private assertEligiblePrerequisite(prerequisite: Obligation): void {
    if (prerequisite.recurrencePolicy !== null) {
      throw new ObligationValidationError(
        "recurring or scheduled obligations cannot participate in prerequisite edges"
      );
    }
  }

  /**
   * Reject a dependent v1 cannot yet express recurrence against (#212): a
   * recurring/scheduled obligation re-arms itself on its own cycle, so also
   * gating it on a prerequisite would mix two different "when is this ready
   * again" mechanisms on one row.
   */
  private assertEligibleDependent(dependent: Obligation): void {
    if (dependent.recurrencePolicy !== null) {
      throw new ObligationValidationError(
        "recurring or scheduled obligations cannot participate in prerequisite edges"
      );
    }
  }

  /**
   * Reject enabling recurrence on `id` while it participates in the
   * prerequisite graph on either side (#212) — as a prerequisite some live
   * dependent already names, or as a dependent that already names its own.
   */
  private assertNotInDependencyGraph(id: string): void {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM obligation_prerequisites WHERE prerequisite_id = ? OR dependent_id = ?`
      )
      .get(id, id) as { count: number };
    if (row.count > 0) {
      throw new ObligationValidationError(
        "recurring or scheduled obligations cannot participate in prerequisite edges"
      );
    }
  }

  /**
   * Cancelled-prerequisite edges still dangling on `dependentId` — used to
   * (re-)deliver cancellation-repair attention at an ownership boundary
   * (reassign, retirement inheritance) so the *current* owner is prompted
   * immediately rather than only after a restart reconciles from
   * {@link listPrerequisiteCancellationAttention} (#212).
   */
  private cancelledPrerequisitesOf(dependentId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT op.prerequisite_id AS prerequisite_id
         FROM obligation_prerequisites op
         JOIN obligations prerequisite ON prerequisite.id = op.prerequisite_id
         WHERE op.dependent_id = ? AND prerequisite.status = 'cancelled'`
      )
      .all(dependentId) as Array<{ prerequisite_id: string }>;
    return rows.map((row) => row.prerequisite_id);
  }

  /** True when every prerequisite `id` declares is `done` (vacuously true for none). */
  private prerequisitesSatisfied(id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM obligation_prerequisites op
         JOIN obligations prerequisite ON prerequisite.id = op.prerequisite_id
         WHERE op.dependent_id = ? AND prerequisite.status <> 'done'`
      )
      .get(id) as { count: number };
    return row.count === 0;
  }

  /**
   * Would naming `prerequisiteId` as a prerequisite of `dependentId` close a
   * loop in the combined wait-for graph (#212)? That graph has two edge
   * sources: explicit prerequisite edges, and the existing parent-waits-for-
   * live-child relation — mixing them is what makes "make my parent depend on
   * me" as much a cycle as a direct A-blocks-B-blocks-A chain.
   *
   * Checked by asking whether `dependentId` is already reachable *from*
   * `prerequisiteId` by following wait-for edges forward: if the prospective
   * prerequisite already (transitively) waits for the dependent, adding
   * dependent-waits-for-prerequisite would close that loop.
   */
  private wouldCreateCycle(dependentId: string, prerequisiteId: string): boolean {
    const row = this.db
      .prepare(
        `WITH RECURSIVE waits_for(src, dst) AS (
           SELECT dependent_id, prerequisite_id FROM obligation_prerequisites
           UNION
           SELECT parent_id, id FROM obligations
           WHERE parent_id IS NOT NULL AND status IN ('ready', 'waiting')
         ),
         reachable(node) AS (
           SELECT dst FROM waits_for WHERE src = ?
           UNION
           SELECT waits_for.dst FROM waits_for JOIN reachable ON waits_for.src = reachable.node
         )
         SELECT COUNT(*) AS count FROM reachable WHERE node = ?`
      )
      .get(prerequisiteId, dependentId) as { count: number };
    return row.count > 0;
  }

  /**
   * Declare that `dependentId` waits on `prerequisiteId` (#212). Adding the
   * same edge twice is a no-op, matching {@link attachArtifact}'s idempotence.
   * Demotes an already-`ready` dependent back to `waiting` when the named
   * prerequisite is not yet done — the mirror image of {@link tryRelease}.
   */
  addPrerequisite(dependentId: string, prerequisiteId: string): Obligation {
    return this.mutate(() => {
      if (dependentId === prerequisiteId) {
        throw new ObligationValidationError("obligation cannot be blocked by itself");
      }
      const dependent = this.require(dependentId);
      if (isTerminalObligationStatus(dependent.status)) {
        throw new ObligationValidationError("terminal obligations cannot gain prerequisites");
      }
      const prerequisite = this.require(prerequisiteId);
      this.assertEligiblePrerequisite(prerequisite);
      this.assertEligibleDependent(dependent);

      const existing = this.db
        .prepare(
          `SELECT 1 FROM obligation_prerequisites WHERE dependent_id = ? AND prerequisite_id = ?`
        )
        .get(dependentId, prerequisiteId);
      if (existing) return dependent;

      if (this.wouldCreateCycle(dependentId, prerequisiteId)) {
        throw new ObligationValidationError(
          "prerequisite would create a cycle in the wait-for graph"
        );
      }

      this.db
        .prepare(
          `INSERT INTO obligation_prerequisites (dependent_id, prerequisite_id) VALUES (?, ?)`
        )
        .run(dependentId, prerequisiteId);

      // Attention-queuing and demotion are independent facts about the named
      // prerequisite — a cancelled prerequisite is also a non-done one, so
      // both must run for it, not just one arm of an if/else-if.
      if (prerequisite.status === "cancelled") {
        this.pendingCancellationAttention.push({
          dependentId,
          dependentOwnerId: dependent.ownerId,
          prerequisiteId,
        });
      }
      if (prerequisite.status !== "done" && dependent.status === "ready") {
        this.db
          .prepare("UPDATE obligations SET status = 'waiting', updated_at = ? WHERE id = ?")
          .run(this.stamp(), dependentId);
      }

      return this.require(dependentId);
    });
  }

  /**
   * Remove one prerequisite edge (#212) — the repair action for a dependent
   * left permanently blocked by a cancelled prerequisite. Removing an edge
   * that does not exist is a no-op. Releases the dependent immediately if
   * this was its last unmet prerequisite and it has no live children.
   */
  removePrerequisite(dependentId: string, prerequisiteId: string): Obligation {
    return this.mutate(() => {
      const dependent = this.require(dependentId);
      const result = this.db
        .prepare(
          `DELETE FROM obligation_prerequisites WHERE dependent_id = ? AND prerequisite_id = ?`
        )
        .run(dependentId, prerequisiteId);
      if (result.changes === 0) return dependent;
      this.tryRelease(dependentId);
      return this.require(dependentId);
    });
  }

  /**
   * Bounded page of `id`'s own prerequisites, in `prerequisite_id` order.
   *
   * The edge carries no declaration timestamp, so declaration order is not a
   * fact this table can serve; ordering by the id makes paging deterministic
   * and stable across calls, which is what a cursor actually needs.
   */
  listBlockedByPage(id: string, options: ObligationPageOptions): ObligationPage {
    const { limit, offset } = validatePage(options);
    const rows = this.db
      .prepare(
        `${EFFECTIVE_PRIORITY_CTE} ${PROJECTED_OBLIGATION}
         JOIN obligation_prerequisites edge ON edge.prerequisite_id = obligation.id
         WHERE edge.dependent_id = ?
         ORDER BY edge.prerequisite_id
         LIMIT ? OFFSET ?`
      )
      .all(id, limit + 1, offset) as ObligationRow[];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM obligation_prerequisites WHERE dependent_id = ?`)
        .get(id) as { count: number }
    ).count;
    return {
      obligations: rows.slice(0, limit).map(toObligation),
      total,
      hasMore: rows.length > limit,
    };
  }

  /**
   * Bounded page of obligations `id` unblocks — the reverse of
   * {@link listBlockedByPage}, ordered by `dependent_id` for the same reason.
   */
  listUnblocksPage(id: string, options: ObligationPageOptions): ObligationPage {
    const { limit, offset } = validatePage(options);
    const rows = this.db
      .prepare(
        `${EFFECTIVE_PRIORITY_CTE} ${PROJECTED_OBLIGATION}
         JOIN obligation_prerequisites edge ON edge.dependent_id = obligation.id
         WHERE edge.prerequisite_id = ?
         ORDER BY edge.dependent_id
         LIMIT ? OFFSET ?`
      )
      .all(id, limit + 1, offset) as ObligationRow[];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM obligation_prerequisites WHERE prerequisite_id = ?`)
        .get(id) as { count: number }
    ).count;
    return {
      obligations: rows.slice(0, limit).map(toObligation),
      total,
      hasMore: rows.length > limit,
    };
  }

  get(id: string): Obligation | null {
    const row = this.db
      .prepare(`${EFFECTIVE_PRIORITY_CTE} ${PROJECTED_OBLIGATION} WHERE obligation.id = ?`)
      .get(id) as ObligationRow | undefined;
    return row ? toObligation(row) : null;
  }

  require(id: string): Obligation {
    const obligation = this.get(id);
    if (!obligation) throw new ObligationValidationError(`obligation not found: ${id}`);
    return obligation;
  }

  listChildren(parentId: string): Obligation[] {
    return (
      this.db
        .prepare(
          `${EFFECTIVE_PRIORITY_CTE} ${PROJECTED_OBLIGATION}
           WHERE obligation.parent_id = ?
           ORDER BY effective_priority.effective_priority, obligation.id`
        )
        .all(parentId) as ObligationRow[]
    ).map(toObligation);
  }

  /** Bounded direct-child read for externally serialized projections. */
  listChildrenPage(parentId: string, options: ChildObligationPageOptions): ObligationPage {
    const { limit, offset } = validatePage(options);
    const blockingClause = options.blockingOnly
      ? " AND obligation.status IN ('ready', 'waiting')"
      : "";
    const rows = this.db
      .prepare(
        `${EFFECTIVE_PRIORITY_CTE} ${PROJECTED_OBLIGATION}
         WHERE obligation.parent_id = ?${blockingClause}
         ORDER BY effective_priority.effective_priority, obligation.id
         LIMIT ? OFFSET ?`
      )
      .all(parentId, limit + 1, offset) as ObligationRow[];
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM obligations obligation
           WHERE obligation.parent_id = ?${blockingClause}`
        )
        .get(parentId) as { count: number }
    ).count;
    return {
      obligations: rows.slice(0, limit).map(toObligation),
      total,
      hasMore: rows.length > limit,
    };
  }

  listOwned(ownerId: EntityId, options: ListOwnedObligationsOptions = {}): Obligation[] {
    validateEntityId(ownerId);
    const params: string[] = [ownerId];
    const statusClause = options.status === undefined ? "" : " AND obligation.status = ?";
    if (options.status !== undefined) params.push(options.status);
    return (
      this.db
        .prepare(
          `${EFFECTIVE_PRIORITY_CTE} ${PROJECTED_OBLIGATION}
           WHERE obligation.owner_id = ?${statusClause}
           ORDER BY
             CASE obligation.status WHEN 'ready' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
             effective_priority.effective_priority,
             obligation.id`
        )
        .all(...params) as ObligationRow[]
    ).map(toObligation);
  }

  /** Bounded owner-queue read for externally serialized projections. */
  listOwnedPage(ownerId: EntityId, options: OwnedObligationPageOptions): ObligationPage {
    validateEntityId(ownerId);
    const { limit, offset } = validatePage(options);
    const params: Array<string | number> = [ownerId];
    const statusClause = options.status === undefined ? "" : " AND obligation.status = ?";
    if (options.status !== undefined) params.push(options.status);
    const rows = this.db
      .prepare(
        `${EFFECTIVE_PRIORITY_CTE} ${PROJECTED_OBLIGATION}
         WHERE obligation.owner_id = ?${statusClause}
         ORDER BY
           CASE obligation.status WHEN 'ready' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
           effective_priority.effective_priority,
           obligation.id
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit + 1, offset) as ObligationRow[];
    const total = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM obligations obligation
           WHERE obligation.owner_id = ?${statusClause}`
        )
        .get(...params) as { count: number }
    ).count;
    return {
      obligations: rows.slice(0, limit).map(toObligation),
      total,
      hasMore: rows.length > limit,
    };
  }

  list(options: ListObligationsOptions = {}): Obligation[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.ownerId) {
      clauses.push("obligation.owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.status) {
      clauses.push("obligation.status = ?");
      params.push(options.status);
    }
    if (options.rootsOnly) {
      clauses.push("obligation.parent_id IS NULL");
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return (
      this.db
        .prepare(
          `${EFFECTIVE_PRIORITY_CTE} ${PROJECTED_OBLIGATION}
           ${where}
           ORDER BY
             CASE obligation.status WHEN 'ready' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
             effective_priority.effective_priority,
             obligation.id`
        )
        .all(...params) as ObligationRow[]
    ).map(toObligation);
  }

  listPage(options: ListObligationsPageOptions): ObligationPage {
    const { limit, offset } = validatePage(options);
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.ownerId) {
      clauses.push("obligation.owner_id = ?");
      params.push(options.ownerId);
    }
    if (options.status) {
      clauses.push("obligation.status = ?");
      params.push(options.status);
    }
    if (options.rootsOnly) {
      clauses.push("obligation.parent_id IS NULL");
    }
    if (options.excludeQuietTerminalRoots) {
      clauses.push(
        `(obligation.status NOT IN ('done', 'cancelled')
          OR obligation.recurrence_policy IS NOT NULL
          OR EXISTS (SELECT 1 FROM obligation_completions WHERE obligation_id = obligation.id))`
      );
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `${EFFECTIVE_PRIORITY_CTE} ${PROJECTED_OBLIGATION}
         ${where}
         ORDER BY
           CASE obligation.status WHEN 'ready' THEN 0 WHEN 'waiting' THEN 1 ELSE 2 END,
           effective_priority.effective_priority,
           obligation.id
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit + 1, offset) as ObligationRow[];
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM obligations obligation ${where}`)
        .get(...params) as { count: number }
    ).count;
    return {
      obligations: rows.slice(0, limit).map(toObligation),
      total,
      hasMore: rows.length > limit,
    };
  }

  getTree(rootId: string): ObligationTree {
    const [tree] = this.getForest([rootId]);
    if (!tree) throw new ObligationValidationError(`obligation not found: ${rootId}`);
    return tree;
  }

  /**
   * Trees for several roots in one bulk read, in the order requested.
   *
   * A root and every one of its descendants used to cost one `require()` plus
   * one `listChildren()` — each re-running the whole-table effective-priority
   * CTE — for every node in the subtree (#241). An earlier version of this
   * fix bounded the read to just the requested subtrees with a second
   * recursive CTE; at this table's actual scale (a few hundred rows) that
   * bound bought nothing measurable and added its own bug — a root whose
   * descendant was *also* requested as a separate root reached that
   * descendant via two seed paths, producing a duplicate row that
   * `childrenByParent` (unlike `byId`) didn't dedupe, which surfaced as a
   * false "cycle detected" error. Reading every row once, unfiltered, and
   * assembling every tree from one in-memory parent→children index removes
   * both the bound and the bug: each id appears exactly once (primary key),
   * so no id can reach the assembly step twice.
   */
  getForest(rootIds: readonly string[]): ObligationTree[] {
    if (rootIds.length === 0) return [];
    const rows = this.db
      .prepare(`${EFFECTIVE_PRIORITY_CTE} ${PROJECTED_OBLIGATION}`)
      .all() as ObligationRow[];

    const byId = new Map<string, ObligationRow>();
    const childrenByParent = new Map<string, ObligationRow[]>();
    for (const row of rows) {
      byId.set(row.id, row);
      if (row.parent_id !== null) {
        const siblings = childrenByParent.get(row.parent_id);
        if (siblings) siblings.push(row);
        else childrenByParent.set(row.parent_id, [row]);
      }
    }
    for (const siblings of childrenByParent.values()) {
      siblings.sort((a, b) =>
        a.effective_priority !== b.effective_priority
          ? a.effective_priority - b.effective_priority
          : a.id < b.id
            ? -1
            : a.id > b.id
              ? 1
              : 0
      );
    }

    const visit = (row: ObligationRow, seen: Set<string>): ObligationTree => {
      if (seen.has(row.id)) {
        throw new ObligationValidationError(`obligation cycle detected at: ${row.id}`);
      }
      seen.add(row.id);
      const childRows = childrenByParent.get(row.id) ?? [];
      const childObligations = childRows.map(toObligation);
      return {
        obligation: toObligation(row),
        children: childRows.map((child) => visit(child, seen)),
        blockingChildren: childObligations.filter((child) =>
          isBlockingObligationStatus(child.status)
        ),
      };
    };

    const trees: ObligationTree[] = [];
    for (const rootId of rootIds) {
      const rootRow = byId.get(rootId);
      if (rootRow) trees.push(visit(rootRow, new Set()));
    }
    return trees;
  }

  /** Apply an explicit priority using the v1 subtree/self inheritance contract. */
  setPriorityInternal(id: string, priority: number, scope: PriorityScope = "subtree"): Obligation {
    return this.mutate(() => {
      this.applyPriority(id, validatePriority(priority), scope);
      return this.require(id);
    });
  }

  /**
   * Move one ready obligation between its current owner's adjacent queue neighbors.
   * Midpoints are used when strict space exists; collapsed/equal bands are repaired
   * locally by bumping the affected lower-priority suffix at +1 increments.
   */
  movePriorityInternal(
    id: string,
    previousId: string | null,
    nextId: string | null,
    scope: PriorityScope = "subtree"
  ): Obligation {
    return this.mutate(() => {
      const target = this.require(id);
      if (target.status !== "ready") {
        throw new ObligationValidationError("only ready obligations can be reordered");
      }
      const queue = this.listOwned(target.ownerId, { status: "ready" }).filter(
        (obligation) => obligation.id !== id
      );
      const previousIndex = previousId === null ? -1 : queue.findIndex((o) => o.id === previousId);
      const nextIndex = nextId === null ? queue.length : queue.findIndex((o) => o.id === nextId);
      if (
        (previousId !== null && previousIndex < 0) ||
        (nextId !== null && nextIndex < 0) ||
        nextIndex !== previousIndex + 1
      ) {
        throw new ObligationValidationError(
          "priority move neighbors must be adjacent ready obligations owned by the target owner"
        );
      }

      const previous = previousId === null ? null : queue[previousIndex];
      const next = nextId === null ? null : queue[nextIndex];
      let priority: number;
      let repairSuffix = false;
      if (previous === null && next === null) {
        priority = validatePriority(this.now());
      } else if (previous === null) {
        if (next === null) {
          throw new ObligationValidationError("priority move requires a queue neighbor");
        }
        const half = next.effectivePriority / 2;
        priority =
          Number.isFinite(half) && half < next.effectivePriority
            ? half
            : priorityBefore(next.effectivePriority);
      } else if (next === null) {
        priority = priorityAfter(previous.effectivePriority);
      } else {
        const midpoint = strictMidpoint(previous.effectivePriority, next.effectivePriority);
        if (midpoint !== null) {
          priority = midpoint;
        } else {
          priority = priorityAfter(previous.effectivePriority);
          repairSuffix = true;
        }
      }
      validatePriority(priority);
      if (previous !== null && priority <= previous.effectivePriority) {
        throw new ObligationValidationError("no finite priority exists after the previous item");
      }
      if (!repairSuffix && next !== null && priority >= next.effectivePriority) {
        throw new ObligationValidationError("no finite priority exists before the next item");
      }
      this.applyPriority(id, priority, scope);

      if (repairSuffix) {
        let cursor = priority;
        for (const obligation of queue.slice(nextIndex)) {
          if (obligation.effectivePriority > cursor) break;
          cursor = validatePriority(priorityAfter(cursor));
          // Numeric collision repair is not a semantic subtree reprioritization:
          // preserve explicit descendant exceptions while inherited descendants follow.
          this.db
            .prepare("UPDATE obligations SET priority = ?, updated_at = ? WHERE id = ?")
            .run(cursor, this.stamp(), obligation.id);
        }
      }
      return this.require(id);
    });
  }

  /**
   * Internal-only R3 retirement inheritance seam. This is deliberately not a
   * general reassignment path: retirement transfers every live obligation in
   * bulk, whereas reassign() changes exactly one selected obligation.
   * Root/no-parent behavior remains explicitly unresolved at Q69.
   */
  inheritRetiringActorObligationsInternal(
    retiringActorId: string,
    parentActorId: string | null
  ): RetirementInheritanceResult {
    return this.mutate(() => {
      const retiringOwner = validateEntityId(retiringActorId);
      if (parentActorId === null) {
        throw new ObligationValidationError(
          "retirement inheritance requires an actor parent; root/no-parent behavior is unresolved (ISSUE_NUM Q69)"
        );
      }
      const parentOwner = validateEntityId(parentActorId);
      if (retiringOwner === parentOwner) {
        throw new ObligationValidationError("retiring actor cannot inherit its own obligations");
      }
      if (this.actorExists && !this.actorExists(parentOwner)) {
        throw new ObligationValidationError(`actor owner does not exist: ${parentOwner}`);
      }

      return {
        ready: this.transferOwnedStatus(retiringOwner, parentOwner, "ready"),
        waiting: this.transferOwnedStatus(retiringOwner, parentOwner, "waiting"),
        scheduled: this.transferOwnedStatus(retiringOwner, parentOwner, "scheduled"),
      };
    });
  }

  /**
   * Change the owner of one live obligation without changing its identity,
   * position, ancestry, or state. Authorization belongs to the calling surface.
   */
  reassign(id: string, newOwnerId: EntityId): Obligation {
    return this.mutate(() => {
      const obligation = this.require(id);
      if (isTerminalObligationStatus(obligation.status)) {
        throw new ObligationValidationError("terminal obligations cannot be reassigned");
      }
      const ownerId = validateEntityId(newOwnerId);
      if (isActorEntityId(ownerId) && this.actorExists && !this.actorExists(ownerId)) {
        throw new ObligationValidationError(`actor owner does not exist: ${ownerId}`);
      }
      if (ownerId === obligation.ownerId) {
        return obligation;
      }

      this.db
        .prepare("UPDATE obligations SET owner_id = ?, updated_at = ? WHERE id = ?")
        .run(ownerId, this.stamp(), id);

      // Reassignment moves the standing block to a new owner who has never
      // seen it — re-deliver cancellation-repair attention at the moment of
      // transfer rather than leaving it to boot reconciliation (#212).
      for (const prerequisiteId of this.cancelledPrerequisitesOf(id)) {
        this.pendingCancellationAttention.push({
          dependentId: id,
          dependentOwnerId: ownerId,
          prerequisiteId,
        });
      }

      return this.require(id);
    });
  }

  /**
   * Link, relink, or unlink an obligation's identity claim after creation.
   *
   * `external_ref` was previously write-once at create, which made the common
   * cases impossible: an obligation raised from a conversation and only later
   * given the issue it turned into, or one linked to the wrong number.
   *
   * Passing `null` unlinks. Unlinking is a real operation, not a workaround —
   * the live-uniqueness index means a mislinked obligation otherwise occupies a
   * ref that its rightful claimant cannot then take.
   *
   * Terminal obligations are frozen, consistent with {@link reassign} and
   * `reparent`: a closed obligation's identity is part of the record.
   */
  setExternalRef(id: string, ref: string | null): Obligation {
    return this.mutate(() => {
      const obligation = this.require(id);
      if (isTerminalObligationStatus(obligation.status)) {
        throw new ObligationValidationError(
          "terminal obligations cannot change their external ref"
        );
      }
      const externalRef = ref === null ? null : parseExternalRef(ref).key;
      if (externalRef === (obligation.externalRef?.key ?? null)) {
        return obligation;
      }

      try {
        this.db
          .prepare("UPDATE obligations SET external_ref = ?, updated_at = ? WHERE id = ?")
          .run(externalRef, this.stamp(), id);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("UNIQUE constraint failed: obligations.external_ref")
        ) {
          // Same message as `create`, because it is the same invariant: one
          // live obligation per external ref is what makes the ref an identity.
          throw new ObligationValidationError(
            `a nonterminal obligation already uses external ref: ${externalRef}`
          );
        }
        throw error;
      }
      return this.require(id);
    });
  }

  /** Internal terminal transition; the future service layer owns discharge authorization/ACK. */
  /**
   * Cite an artifact on an obligation. Idempotent per `(obligation, ref)` so a
   * retry — or an actor attaching the same message twice while reasoning about
   * it — is not an error; the first attachment's attribution and timestamp win,
   * which keeps the record of who first cited it honest.
   */
  attachArtifact(
    obligationId: string,
    ref: string,
    options?: { label?: string | null; attachedBy?: EntityId | null }
  ): ObligationArtifact {
    return this.mutate(() => {
      this.require(obligationId);
      const key = parseObligationReference(ref).key;
      const label = options?.label == null ? null : options.label.trim() || null;
      const attachedBy = options?.attachedBy == null ? null : validateEntityId(options.attachedBy);
      this.db
        .prepare(
          `INSERT INTO obligation_artifacts (id, obligation_id, ref, label, attached_by, attached_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(obligation_id, ref) DO NOTHING`
        )
        .run(randomUUID(), obligationId, key, label, attachedBy, this.stamp());
      const row = this.db
        .prepare("SELECT * FROM obligation_artifacts WHERE obligation_id = ? AND ref = ?")
        .get(obligationId, key) as ObligationArtifactRow;
      return toArtifact(row);
    });
  }

  /**
   * The one live obligation claiming this external reference, if any.
   *
   * At most one can exist: `idx_obligations_live_external_ref` is unique over
   * nonterminal rows, which is what makes an external ref an *identity* claim
   * rather than a mere association — and what lets event routing treat the
   * answer as authoritative rather than as one opinion among several.
   *
   * Terminal obligations are excluded deliberately. A closed obligation should
   * stop governing its issue's events, and the same index frees its ref for
   * reuse by a successor.
   */
  findLiveByExternalRef(ref: string): { ownerId: EntityId } | null {
    const row = this.findLiveObligationByExternalRef(ref);
    return row ? { ownerId: row.ownerId } : null;
  }

  /** The live obligation identity behind an external reference, for focus resolution. */
  findLiveObligationByExternalRef(ref: string): { id: string; ownerId: EntityId } | null {
    const row = this.db
      .prepare(
        `SELECT id, owner_id
         FROM obligations
         WHERE external_ref = ? COLLATE NOCASE
           AND status IN ('ready', 'waiting', 'scheduled')
         LIMIT 1`
      )
      .get(ref) as { id: string; owner_id: EntityId } | undefined;
    return row ? { id: row.id, ownerId: row.owner_id } : null;
  }

  /** Every artifact cited by an obligation, oldest first. */
  listCompletionsPage(
    id: string,
    options: ObligationPageOptions
  ): {
    completions: {
      id: string;
      obligationId: string;
      sequence: number;
      completedAt: string;
      note: string | null;
      resolutionRef: string | null;
      nextReadyAt: string | null;
    }[];
    total: number;
    hasMore: boolean;
  } {
    const { limit, offset } = validatePage(options);
    const countRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM obligation_completions WHERE obligation_id = ?`)
      .get(id) as { count: number };
    const total = countRow.count;

    const rows = this.db
      .prepare(
        `SELECT * FROM obligation_completions WHERE obligation_id = ? ORDER BY sequence DESC LIMIT ? OFFSET ?`
      )
      .all(id, limit + 1, offset) as {
      id: string;
      obligation_id: string;
      sequence: number;
      completed_at: string;
      note: string | null;
      resolution_ref: string | null;
      next_ready_at: string | null;
    }[];

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    return {
      total,
      hasMore,
      completions: rows.map((row) => ({
        id: row.id,
        obligationId: row.obligation_id,
        sequence: row.sequence,
        completedAt: row.completed_at,
        note: row.note ?? null,
        resolutionRef: row.resolution_ref ?? null,
        nextReadyAt: row.next_ready_at ?? null,
      })),
    };
  }

  listArtifacts(obligationId: string): ObligationArtifact[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM obligation_artifacts
         WHERE obligation_id = ?
         ORDER BY attached_at, id`
      )
      .all(obligationId) as ObligationArtifactRow[];
    return rows.map(toArtifact);
  }

  setTerminalStatus(
    id: string,
    status: "done" | "cancelled",
    /** Why, in the terminating principal's words. Omitted means no reason given. */
    note?: string | null,
    /**
     * The artifact that settled this — the message that answered the question,
     * the PR that delivered the work. Attached to the obligation if it is not
     * already, so citing evidence never needs two calls.
     */
    resolutionRef?: string | null
  ): Obligation {
    return this.mutate(() => {
      const obligation = this.require(id);
      if (isTerminalObligationStatus(obligation.status)) {
        throw new ObligationValidationError("terminal obligations cannot be reopened or changed");
      }
      if (obligation.status === "scheduled" && status === "done") {
        throw new ObligationValidationError(
          "scheduled obligations cannot be completed until they are ready"
        );
      }
      const liveChild = this.listChildren(id).find((child) =>
        isBlockingObligationStatus(child.status)
      );
      if (liveChild) {
        throw new ObligationValidationError(
          `cannot ${status === "cancelled" ? "cancel" : "complete"} obligation with live children`
        );
      }

      const completedAt = this.stamp();
      const resolution = resolutionRef == null ? null : parseObligationReference(resolutionRef).key;
      if (resolution !== null) {
        // Same transaction as the transition: evidence that arrives only if a
        // second call succeeds is evidence that goes missing on a crash.
        this.db
          .prepare(
            `INSERT INTO obligation_artifacts (id, obligation_id, ref, label, attached_by, attached_at)
             VALUES (?, ?, ?, NULL, NULL, ?)
             ON CONFLICT(obligation_id, ref) DO NOTHING`
          )
          .run(randomUUID(), id, resolution, completedAt);
      }

      if (status === "done" && obligation.recurrencePolicy !== null) {
        const seqRow = this.db
          .prepare(
            `SELECT COALESCE(MAX(sequence), 0) + 1 AS seq FROM obligation_completions WHERE obligation_id = ?`
          )
          .get(id) as { seq: number };
        const seq = seqRow.seq;
        const completionId = randomUUID();

        let nextReadyAt: string | null = null;
        if (
          obligation.recurrencePolicy === "completion_interval" &&
          obligation.recurrenceIntervalSeconds != null
        ) {
          nextReadyAt = new Date(
            new Date(completedAt).getTime() + obligation.recurrenceIntervalSeconds * 1000
          ).toISOString();
        } else if (obligation.recurrencePolicy === "cron" && obligation.recurrenceCron != null) {
          nextReadyAt = nextCronOccurrence(
            obligation.recurrenceCron,
            new Date(completedAt)
          ).toISOString();
        }

        this.db
          .prepare(
            `INSERT INTO obligation_completions (id, obligation_id, sequence, completed_at, note, resolution_ref, next_ready_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            completionId,
            id,
            seq,
            completedAt,
            normalizeTerminalNote(note),
            resolution,
            nextReadyAt
          );

        this.db
          .prepare(
            `UPDATE obligations
           SET status = 'scheduled', next_ready_at = ?, updated_at = ?
           WHERE id = ?`
          )
          .run(nextReadyAt, completedAt, id);

        if (obligation.recurrencePolicy === "completion_interval" && nextReadyAt) {
          this.markScheduleDirty(id);
        }
      } else {
        // Reached for `cancelled` (any recurrence) or `done` with no
        // recurrence — both permanently stop recurrence, so the recurrence
        // columns are cleared alongside the status in the same statement
        // rather than left to describe a cycle that will never resume.
        this.db
          .prepare(
            `UPDATE obligations
             SET status = ?, terminal_note = ?, resolution_ref = ?, updated_at = ?,
                 next_ready_at = NULL, recurrence_policy = NULL, recurrence_cron = NULL,
                 recurrence_interval_seconds = NULL
             WHERE id = ?`
          )
          .run(status, normalizeTerminalNote(note), resolution, completedAt, id);

        // A never-recurring obligation has no cron entry and can never reach
        // `scheduled`, so it never owned an OS activation — only recurring
        // obligations (cron, still-armed while ready/waiting, or
        // completion_interval, owning a pending `at` job while scheduled)
        // need the post-commit reconciliation to tear anything down.
        if (obligation.recurrencePolicy !== null) {
          this.markScheduleDirty(id);
        }

        if (status === "done") {
          this.reevaluateDependents(id);
        } else {
          // Cancelling never satisfies a dependent (#212) — it forfeits the
          // wait forever, so each dependent's owner needs durable attention
          // to remove or replace this edge rather than a silent release.
          // Matches {@link listPrerequisiteCancellationAttention}'s live-dependent
          // filter: a dependent that already reached done/cancelled on its own
          // has nothing left to repair, so it should not receive a prompt just
          // because the now-dangling edge still names it.
          const dependents = this.db
            .prepare(
              `SELECT op.dependent_id AS dependent_id, dependent.owner_id AS dependent_owner_id
               FROM obligation_prerequisites op
               JOIN obligations dependent ON dependent.id = op.dependent_id
               WHERE op.prerequisite_id = ?
                 AND dependent.status IN ('ready', 'waiting', 'scheduled')`
            )
            .all(id) as Array<{ dependent_id: string; dependent_owner_id: string }>;
          for (const dependent of dependents) {
            this.pendingCancellationAttention.push({
              dependentId: dependent.dependent_id,
              dependentOwnerId: dependent.dependent_owner_id,
              prerequisiteId: id,
            });
          }
        }
      }

      if (obligation.parentId !== null) this.tryRelease(obligation.parentId);
      return this.require(id);
    });
  }

  /**
   * Reparent an obligation. Preserves stored priority override; a NULL stored
   * priority inherits from the new ancestry. Transactionally updates both old
   * and new parents' waiting/ready states and rejects cycles and self-parenting.
   */

  setRecurrence(
    id: string,
    recurrence:
      | { policy: "cron"; cronExpr: string }
      | { policy: "completion_interval"; intervalSeconds: number }
      | null
  ): Obligation {
    if (recurrence?.policy === "cron") this.assertFiringCronExpr(recurrence.cronExpr);
    if (
      recurrence?.policy === "completion_interval" &&
      (!Number.isInteger(recurrence.intervalSeconds) || recurrence.intervalSeconds <= 0)
    ) {
      throw new ObligationValidationError("recurrence interval must be a positive integer");
    }
    return this.mutate(() => {
      const obligation = this.require(id);
      if (isTerminalObligationStatus(obligation.status)) {
        throw new ObligationValidationError("terminal obligations cannot be recurring");
      }
      // v1 rejects a prerequisite edge with either endpoint recurring/
      // scheduled at the edge itself (#212, {@link assertEligiblePrerequisite},
      // {@link assertEligibleDependent}) — the same invariant must hold going
      // the other direction: turning recurrence on for an obligation already
      // participating in the graph on either side would let a prohibited edge
      // exist anyway, just created in the opposite order.
      if (recurrence !== null) this.assertNotInDependencyGraph(id);

      if (recurrence === null) {
        // Every state this row can be in — including `scheduled`, where the
        // CHECK constraint demands a non-null recurrence_policy and
        // next_ready_at as long as status stays `scheduled` — is resolved in
        // one UPDATE so no intermediate write is ever checked against a
        // combination that never actually holds. Disabling recurrence while
        // scheduled forfeits the pending cycle: the row finalizes as done.
        if (obligation.status === "scheduled") {
          this.db
            .prepare(
              `UPDATE obligations
               SET status = 'done', recurrence_policy = NULL, recurrence_cron = NULL,
                   recurrence_interval_seconds = NULL, next_ready_at = NULL, updated_at = ?
               WHERE id = ?`
            )
            .run(this.stamp(), id);
          if (obligation.parentId !== null) this.tryRelease(obligation.parentId);
        } else {
          this.db
            .prepare(
              `UPDATE obligations
               SET recurrence_policy = NULL, recurrence_cron = NULL,
                   recurrence_interval_seconds = NULL, next_ready_at = NULL, updated_at = ?
               WHERE id = ?`
            )
            .run(this.stamp(), id);
        }
      } else if (recurrence.policy === "cron") {
        // A currently-scheduled row must keep a non-null next_ready_at in the
        // very statement that changes its policy, or the CHECK constraint
        // rejects the write outright; a ready/waiting row has no such
        // requirement, so next_ready_at stays null until it actually completes.
        const nextReadyAt =
          obligation.status === "scheduled"
            ? nextCronOccurrence(recurrence.cronExpr, new Date(this.now())).toISOString()
            : null;
        this.db
          .prepare(
            `UPDATE obligations SET next_ready_at = ?, recurrence_policy = 'cron', recurrence_cron = ?, recurrence_interval_seconds = NULL, updated_at = ? WHERE id = ?`
          )
          .run(nextReadyAt, recurrence.cronExpr, this.stamp(), id);
      } else if (recurrence.policy === "completion_interval") {
        if (obligation.status === "scheduled") {
          const lastCompletion = this.db
            .prepare(
              `SELECT completed_at FROM obligation_completions WHERE obligation_id = ? ORDER BY sequence DESC LIMIT 1`
            )
            .get(id) as { completed_at: string } | undefined;

          if (lastCompletion) {
            const completedTime = Date.parse(lastCompletion.completed_at);
            const readyTime = completedTime + recurrence.intervalSeconds * 1000;
            if (readyTime <= this.now()) {
              // A recurring/scheduled obligation can never itself be a
              // dependent (#212, {@link assertNotInDependencyGraph}), so this
              // direct scheduled→ready transition has no prerequisite to check.
              this.db
                .prepare(
                  `UPDATE obligations SET status = 'ready', next_ready_at = NULL, recurrence_policy = 'completion_interval', recurrence_cron = NULL, recurrence_interval_seconds = ?, updated_at = ? WHERE id = ?`
                )
                .run(recurrence.intervalSeconds, this.stamp(), id);
            } else {
              const nextReadyAt = new Date(readyTime).toISOString();
              this.db
                .prepare(
                  `UPDATE obligations SET next_ready_at = ?, recurrence_policy = 'completion_interval', recurrence_cron = NULL, recurrence_interval_seconds = ?, updated_at = ? WHERE id = ?`
                )
                .run(nextReadyAt, recurrence.intervalSeconds, this.stamp(), id);
            }
          }
        } else {
          this.db
            .prepare(
              `UPDATE obligations SET recurrence_policy = 'completion_interval', recurrence_cron = NULL, recurrence_interval_seconds = ?, updated_at = ? WHERE id = ?`
            )
            .run(recurrence.intervalSeconds, this.stamp(), id);
        }
      }
      this.markScheduleDirty(id);
      return this.require(id);
    });
  }

  activateScheduled(id: string): Obligation | null {
    return this.mutate(() => {
      const obligation = this.get(id);
      if (!obligation) return null;
      if (obligation.status !== "scheduled") return obligation;
      // A recurring/scheduled obligation can never itself be a dependent
      // (#212, {@link assertNotInDependencyGraph}), so this transition has no
      // prerequisite to check.
      this.db
        .prepare(
          `UPDATE obligations SET status = 'ready', next_ready_at = NULL, updated_at = ? WHERE id = ?`
        )
        .run(this.stamp(), id);

      return this.require(id);
    });
  }

  reparent(id: string, newParentId: string | null): Obligation {
    return this.mutate(() => {
      const obligation = this.require(id);
      if (isTerminalObligationStatus(obligation.status)) {
        throw new ObligationValidationError("terminal obligations cannot be reparented");
      }
      if (newParentId === id) {
        throw new ObligationValidationError("obligation cannot parent itself");
      }
      if (newParentId === obligation.parentId) {
        return this.require(id);
      }
      if (newParentId !== null) {
        const newParent = this.get(newParentId);
        if (!newParent) {
          throw new ObligationValidationError(`parent obligation not found: ${newParentId}`);
        }
        if (isTerminalObligationStatus(newParent.status)) {
          throw new ObligationValidationError("cannot add a child to a terminal obligation");
        }
        const isDescendant = this.db
          .prepare(
            `WITH RECURSIVE ancestors(id, parent_id) AS (
               SELECT id, parent_id FROM obligations WHERE id = ?
               UNION ALL
               SELECT o.id, o.parent_id
               FROM obligations o
               JOIN ancestors a ON o.id = a.parent_id
             )
             SELECT COUNT(*) AS count FROM ancestors WHERE id = ?`
          )
          .get(newParentId, id) as { count: number };
        if (isDescendant.count > 0) {
          throw new ObligationValidationError(
            `cannot reparent obligation to its own descendant: ${newParentId}`
          );
        }
        // Hierarchy-only cycles are caught above, but reparenting also adds a
        // parent-waits-for-child edge from `newParentId` to `id` — if `id`
        // already (transitively, via an explicit prerequisite chain) waits
        // for `newParentId`, that new edge would close the loop (#212).
        if (this.wouldCreateCycle(newParentId, id)) {
          throw new ObligationValidationError(
            `cannot reparent obligation: ${id} already waits for ${newParentId}`
          );
        }
      }

      const oldParentId = obligation.parentId;

      if (newParentId === null && obligation.priority === null) {
        this.db
          .prepare(
            "UPDATE obligations SET parent_id = ?, priority = ?, updated_at = ? WHERE id = ?"
          )
          .run(null, validatePriority(this.now()), this.stamp(), id);
      } else {
        this.db
          .prepare("UPDATE obligations SET parent_id = ?, updated_at = ? WHERE id = ?")
          .run(newParentId, this.stamp(), id);
      }

      if (newParentId !== null && isBlockingObligationStatus(obligation.status)) {
        this.db
          .prepare(
            "UPDATE obligations SET status = 'waiting', updated_at = ? WHERE id = ? AND status = 'ready'"
          )
          .run(this.stamp(), newParentId);
      }

      if (oldParentId !== null) {
        this.tryRelease(oldParentId);
      }

      return this.require(id);
    });
  }

  reorder(
    id: string,
    previousId: string | null,
    nextId: string | null,
    scope: PriorityScope = "subtree"
  ): Obligation {
    return this.movePriorityInternal(id, previousId, nextId, scope);
  }

  private applyPriority(id: string, priority: number, scope: PriorityScope): void {
    if (scope !== "subtree" && scope !== "self") {
      throw new ObligationValidationError("priority scope must be subtree or self");
    }
    const obligation = this.require(id);
    if (isTerminalObligationStatus(obligation.status)) {
      throw new ObligationValidationError("terminal obligations cannot be reprioritized");
    }

    if (scope === "self") {
      this.db
        .prepare(
          `UPDATE obligations
           SET priority = ?, updated_at = ?
           WHERE parent_id = ? AND priority IS NULL`
        )
        .run(obligation.effectivePriority, this.stamp(), id);
    } else {
      this.db
        .prepare(
          `WITH RECURSIVE descendants(id) AS (
             SELECT id FROM obligations WHERE parent_id = ?
             UNION ALL
             SELECT child.id
             FROM obligations child
             JOIN descendants parent ON child.parent_id = parent.id
           )
           UPDATE obligations SET priority = NULL, updated_at = ?
           WHERE id IN (SELECT id FROM descendants)`
        )
        // The CTE's parent_id placeholder is bound FIRST: it precedes the SET
        // clause in statement text, which is where better-sqlite3 takes order from.
        .run(id, this.stamp());
    }
    this.db
      .prepare("UPDATE obligations SET priority = ?, updated_at = ? WHERE id = ?")
      .run(priority, this.stamp(), id);
  }

  /** Transfer ownership while preserving the obligation's stored/effective priority. */
  private transferOwnedStatus(
    retiringActorId: string,
    parentActorId: string,
    status: "ready" | "waiting" | "scheduled"
  ): number {
    const source = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM obligations
         WHERE owner_id = ? AND status = ?`
      )
      .get(retiringActorId, status) as { count: number };
    if (source.count === 0) return 0;

    // Captured before the transfer, while `dependent.owner_id` still names
    // the retiring actor: the inheriting owner has never seen these dangling
    // edges, so each gets fresh attention at this ownership boundary rather
    // than waiting for boot reconciliation (#212).
    const cancelledBlocked = this.db
      .prepare(
        `SELECT DISTINCT op.dependent_id AS dependent_id, op.prerequisite_id AS prerequisite_id
         FROM obligation_prerequisites op
         JOIN obligations dependent ON dependent.id = op.dependent_id
         JOIN obligations prerequisite ON prerequisite.id = op.prerequisite_id
         WHERE dependent.owner_id = ? AND dependent.status = ? AND prerequisite.status = 'cancelled'`
      )
      .all(retiringActorId, status) as Array<{ dependent_id: string; prerequisite_id: string }>;

    const result = this.db
      .prepare(
        `UPDATE obligations
         SET owner_id = ?, updated_at = ?
         WHERE owner_id = ? AND status = ?`
      )
      .run(parentActorId, this.stamp(), retiringActorId, status);

    for (const { dependent_id: dependentId, prerequisite_id: prerequisiteId } of cancelledBlocked) {
      this.pendingCancellationAttention.push({
        dependentId,
        dependentOwnerId: parentActorId,
        prerequisiteId,
      });
    }

    return result.changes;
  }

  /**
   * Re-ready `id` if it is `waiting` for no reason anymore (#212): neither a
   * live child (the pre-existing rule) nor an unmet named prerequisite. Both
   * conditions must clear — one relation cannot release a wait the other
   * relation still holds.
   */
  private tryRelease(id: string): void {
    const obligation = this.require(id);
    if (obligation.status !== "waiting") return;
    const liveChildren = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM obligations
         WHERE parent_id = ? AND status IN ('ready', 'waiting')`
      )
      .get(id) as { count: number };
    if (liveChildren.count !== 0) return;
    if (!this.prerequisitesSatisfied(id)) return;
    this.db
      .prepare("UPDATE obligations SET status = 'ready', updated_at = ? WHERE id = ?")
      .run(this.stamp(), id);
  }

  /** Release every dependent that was only waiting on `prerequisiteId` (#212). */
  private reevaluateDependents(prerequisiteId: string): void {
    const dependents = this.db
      .prepare(`SELECT dependent_id FROM obligation_prerequisites WHERE prerequisite_id = ?`)
      .all(prerequisiteId) as Array<{ dependent_id: string }>;
    for (const { dependent_id: dependentId } of dependents) {
      this.tryRelease(dependentId);
    }
  }
}
