import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  assertObligationStatus,
  type EntityId,
  isTerminalObligationStatus,
  type Obligation,
  type ObligationStatus,
  type ObligationTree,
  ObligationValidationError,
  parseExternalRef,
  validateEntityId,
} from "../../obligations/obligation.js";

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
}

export interface CreateObligationInput {
  id?: string;
  parentId?: string | null;
  ownerId: EntityId;
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
}

export type PriorityScope = "subtree" | "self";

export interface ListOwnedObligationsOptions {
  status?: ObligationStatus;
}

export interface ListObligationsOptions {
  ownerId?: EntityId;
  status?: ObligationStatus;
  rootsOnly?: boolean;
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
  head: Obligation;
}

export interface ObligationPage {
  obligations: Obligation[];
  total: number;
  hasMore: boolean;
}

export interface RetirementInheritanceResult {
  ready: number;
  waiting: number;
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
         effective_priority.priority_source_id
  FROM obligations obligation
  JOIN effective_priority ON effective_priority.id = obligation.id
`;

/**
 * Whether an entity id names a mesh actor, as opposed to the operator or a
 * system component. Actor existence is checkable; `human:*` and `system:*` ids
 * are not in the thread registry, so validating them against it would reject
 * legitimate owners.
 */
function isActorEntityId(id: EntityId): boolean {
  return !id.startsWith("human:") && !id.startsWith("system:");
}

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
  };
}

/** Internal persistence boundary for the R3-ratified obligation contract . */
export class ObligationRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly actorExists?: (actorId: string) => boolean,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Notified when an ACTOR owner gains a ready head it did not have before.
   *
   * Set after construction rather than injected: the mesh that consumes this
   * does not exist yet when the repository container is built.
   */
  private readyHeadListener?: (change: ReadyHeadChange) => void;

  setReadyHeadListener(listener: ((change: ReadyHeadChange) => void) | undefined): void {
    this.readyHeadListener = listener;
  }

  /**
   * Current ready head per owner, keyed `kind\0id`.
   *
   * "Head" is the first row of the owner's ready queue, which must stay
   * byte-identical to `listOwned`'s ordering (effective priority, then id) or
   * an actor would be told about a head its own queue does not show first.
   */
  private readyHeads(): Map<string, string> {
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
   * Run a mutation and report any actor whose ready head changed as a result.
   *
   * Diffing a head snapshot rather than reasoning per-operation is deliberate:
   * #1645 requires covering create, reorder, all-children-terminal re-ready,
   * reassignment and retirement inheritance, and several of those move a head
   * for an owner the caller never named (a re-readied parent, the far side of a
   * reassignment, every heir of a retiring actor). An operation-by-operation
   * rule would have to re-derive that fan-out and would silently miss the next
   * producer added; the diff cannot.
   *
   * Notification happens AFTER the transaction returns, so a rolled-back
   * mutation cannot announce a head that was never committed.
   */
  private tracked<T>(run: () => T): T {
    const listener = this.readyHeadListener;
    if (!listener) return run();
    const before = this.readyHeads();
    const result = run();
    const after = this.readyHeads();
    for (const [ownerId, headId] of after) {
      if (before.get(ownerId) === headId) continue;
      // #1645: head attention for the operator belongs in the dashboard/digest,
      // and a system component has no inbox — only actors are woken.
      if (!isActorEntityId(ownerId)) continue;
      const head = this.get(headId);
      if (head) listener({ ownerId, head });
    }
    return result;
  }

  /**
   * The single mutation seam: one transaction, with ready-head tracking around it.
   *
   * Every state-changing repository method routes through here, so a new
   * mutation cannot be added that commits without being observed — the same
   * reason `updated_at` is set at every UPDATE rather than left to a caller.
   */
  private mutate<T>(work: () => T): T {
    return this.tracked(() => this.db.transaction(work)());
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

  create(input: CreateObligationInput): Obligation {
    return this.mutate(() => {
      const stampedAt = this.stamp();
      const creatorId = input.creatorId == null ? null : validateEntityId(input.creatorId);
      const id = input.id ?? randomUUID();
      if (!id.trim()) throw new ObligationValidationError("obligation id is required");
      const parentId = input.parentId ?? null;
      if (parentId === id) throw new ObligationValidationError("obligation cannot parent itself");
      const ownerId = validateEntityId(input.ownerId);
      if (isActorEntityId(ownerId) && this.actorExists && !this.actorExists(ownerId)) {
        throw new ObligationValidationError(`actor owner does not exist: ${ownerId}`);
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

      try {
        this.db
          .prepare(
            `INSERT INTO obligations
               (id, parent_id, owner_id, intent, external_ref, status, priority,
                created_at, updated_at, creator_id)
             VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`
          )
          .run(
            id,
            parentId,
            ownerId,
            input.intent ?? null,
            externalRef,
            priority,
            stampedAt,
            stampedAt,
            creatorId
          );
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
    const seen = new Set<string>();
    const visit = (id: string): ObligationTree => {
      if (seen.has(id)) throw new ObligationValidationError(`obligation cycle detected at: ${id}`);
      seen.add(id);
      const obligation = this.require(id);
      const childObligations = this.listChildren(id);
      const children = childObligations.map((child) => visit(child.id));
      return {
        obligation,
        children,
        blockingChildren: childObligations.filter(
          (child) => !isTerminalObligationStatus(child.status)
        ),
      };
    };
    return visit(rootId);
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
      return this.require(id);
    });
  }

  /** Internal terminal transition; the future service layer owns discharge authorization/ACK. */
  setTerminalStatus(id: string, status: "done" | "cancelled"): Obligation {
    return this.mutate(() => {
      const obligation = this.require(id);
      if (isTerminalObligationStatus(obligation.status)) {
        throw new ObligationValidationError("terminal obligations cannot be reopened or changed");
      }
      const liveChild = this.listChildren(id).find(
        (child) => !isTerminalObligationStatus(child.status)
      );
      if (liveChild) {
        throw new ObligationValidationError(
          `cannot ${status === "cancelled" ? "cancel" : "complete"} obligation with live children`
        );
      }

      this.db
        .prepare("UPDATE obligations SET status = ?, updated_at = ? WHERE id = ?")
        .run(status, this.stamp(), id);
      if (obligation.parentId !== null) this.reReadyParentIfUnblocked(obligation.parentId);
      return this.require(id);
    });
  }

  /**
   * Reparent an obligation. Preserves stored priority override; a NULL stored
   * priority inherits from the new ancestry. Transactionally updates both old
   * and new parents' waiting/ready states and rejects cycles and self-parenting.
   */
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

      if (newParentId !== null) {
        this.db
          .prepare(
            "UPDATE obligations SET status = 'waiting', updated_at = ? WHERE id = ? AND status = 'ready'"
          )
          .run(this.stamp(), newParentId);
      }

      if (oldParentId !== null) {
        this.reReadyParentIfUnblocked(oldParentId);
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
    status: "ready" | "waiting"
  ): number {
    const source = this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM obligations
         WHERE owner_id = ? AND status = ?`
      )
      .get(retiringActorId, status) as { count: number };
    if (source.count === 0) return 0;

    const result = this.db
      .prepare(
        `UPDATE obligations
         SET owner_id = ?, updated_at = ?
         WHERE owner_id = ? AND status = ?`
      )
      .run(parentActorId, this.stamp(), retiringActorId, status);
    return result.changes;
  }

  private reReadyParentIfUnblocked(parentId: string): void {
    const parent = this.require(parentId);
    if (parent.status !== "waiting") return;
    const liveChildren = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM obligations
         WHERE parent_id = ? AND status IN ('ready', 'waiting')`
      )
      .get(parentId) as { count: number };
    if (liveChildren.count !== 0) return;
    this.db
      .prepare("UPDATE obligations SET status = 'ready', updated_at = ? WHERE id = ?")
      .run(this.stamp(), parentId);
  }
}
