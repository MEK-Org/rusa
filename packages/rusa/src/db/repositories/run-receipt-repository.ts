import type Database from "better-sqlite3";
import type { RunTermination } from "../../providers/types.js";
import type { ActorRunModelConfig } from "./actor-run-model-config.js";
import { ActorRunRepository } from "./actor-run-repository.js";
import {
  createRunReceipt,
  parseRunReceipt,
  type RunReceipt,
  type RunReceiptEnvelope,
  runReceiptDigest,
  serializeRunReceipt,
} from "./run-receipt.js";

interface HostReceiptRow {
  id: number;
  run_id: string;
  digest: string;
  receipt: string;
}

/** A committed receipt the leader has not yet durably answered for. */
export interface HostPendingReceipt {
  /** Local commit order, which delivery pages by; never sent. */
  id: number;
  envelope: RunReceiptEnvelope;
}

/**
 * What a terminal write on the host did. `local` closed a run opened without
 * the receipt contract. `receipt` closed a receipt-backed run and committed
 * its receipt. `unresolved` left a receipt-backed run open with no receipt,
 * because its termination was not observed.
 */
export type HostTerminalWrite = "local" | "receipt" | "unresolved";

/** What recovering a previous process's open runs did with each of them. */
export interface HostOpenRunRecovery {
  /** Runs opened without the receipt contract, closed locally as before receipts. */
  local: number;
  /**
   * Receipt-backed runs, of this identity or another, left open with no
   * receipt: nothing observed them end.
   */
  unresolved: Array<{ runId: string; instanceId: string }>;
}

/**
 * The executing host's side of #1020. A run opened under the receipt contract
 * records the identity that opened it; its local terminal and its pending
 * receipt then commit together, so a terminal the host recorded is never one
 * the leader cannot learn about, across any restart. A run opened without the
 * contract closes locally, exactly as before receipts.
 */
export class HostRunReceiptRepository {
  private readonly runs: ActorRunRepository;

  constructor(
    private readonly db: Database.Database,
    private readonly instanceId: string
  ) {
    this.runs = new ActorRunRepository(db);
  }

  /** Open a local run that owes the leader a receipt from this identity. */
  start(opts: {
    id: string;
    actorId: string;
    modelConfig: ActorRunModelConfig;
    startedAt?: string;
  }): void {
    this.db.transaction(() => {
      this.runs.start({ ...opts, startedAt: opts.startedAt ?? new Date().toISOString() });
      this.db
        .prepare(`INSERT INTO host_runs (run_id, instance_id) VALUES (?, ?)`)
        .run(opts.id, this.instanceId);
    })();
  }

  /**
   * Close the open local run as completed and enqueue its receipt if it was
   * opened under the contract. A receipt-backed run closes only when
   * `termination` is the provider's observed exit; otherwise it stays open
   * with no receipt (#1119 runtime treatment A). A run opened without the
   * contract closes locally, exactly as before receipts.
   */
  complete(
    runId: string,
    actorId: string,
    result: { success: boolean; exitCode: number; output: string },
    termination: RunTermination | undefined,
    endedAt = new Date().toISOString()
  ): HostTerminalWrite {
    return this.db.transaction((): HostTerminalWrite => {
      if (!this.ownsRun(runId)) {
        this.runs.complete(runId, { ...result, endedAt });
        return "local";
      }
      if (termination !== "observed") return "unresolved";
      this.runs.complete(runId, { ...result, endedAt });
      this.insert(
        createRunReceipt({
          instanceId: this.instanceId,
          runId,
          actorId,
          endedAt,
          outcome: "completed",
          success: result.success,
          exitCode: result.exitCode,
          output: result.output,
        })
      );
      return "receipt";
    })();
  }

  /**
   * Close the open local run as abandoned by this process's own runtime and
   * enqueue its receipt if it owes one. As with {@link complete}, a
   * receipt-backed run closes only on observed termination: an abandoned run
   * whose provider call was never observed to exit stays open with no
   * receipt.
   */
  abandon(
    runId: string,
    actorId: string,
    reason: string,
    termination: RunTermination | undefined,
    endedAt = new Date().toISOString()
  ): HostTerminalWrite {
    return this.db.transaction((): HostTerminalWrite => {
      if (!this.ownsRun(runId)) {
        this.runs.abandon(runId, reason, endedAt);
        return "local";
      }
      if (termination !== "observed") return "unresolved";
      this.runs.abandon(runId, reason, endedAt);
      this.insert(
        createRunReceipt({
          instanceId: this.instanceId,
          runId,
          actorId,
          endedAt,
          outcome: "abandoned",
          reason,
        })
      );
      return "receipt";
    })();
  }

  /**
   * Recover the local runs a previous process, or this one at shutdown, left
   * open. A run opened without the receipt contract closes locally, as before
   * receipts. A receipt-backed run stays open with no receipt, whichever
   * identity opened it: its provider ran in a detached process group that can
   * outlive the host process, so a restart or shutdown does not establish
   * that it ended. Only an observed termination writes its terminal.
   */
  recoverOpen(reason: string, endedAt = new Date().toISOString()): HostOpenRunRecovery {
    return this.db.transaction(() => {
      const open = this.db
        .prepare(
          `SELECT r.id, h.instance_id
           FROM actor_runs r LEFT JOIN host_runs h ON h.run_id = r.id
           WHERE r.outcome IS NULL ORDER BY r.started_at, r.id`
        )
        .all() as Array<{ id: string; instance_id: string | null }>;
      const recovery: HostOpenRunRecovery = { local: 0, unresolved: [] };
      for (const run of open) {
        if (run.instance_id === null) {
          this.runs.abandon(run.id, reason, endedAt);
          recovery.local += 1;
        } else {
          recovery.unresolved.push({ runId: run.id, instanceId: run.instance_id });
        }
      }
      return recovery;
    })();
  }

  /** This identity's receipts the leader has not acknowledged after local `afterId`, oldest first. */
  listUnacked(afterId: number, limit: number): HostPendingReceipt[] {
    return (
      this.db
        .prepare(
          `SELECT id, run_id, digest, receipt FROM host_run_receipts
           WHERE instance_id = ? AND id > ? ORDER BY id LIMIT ?`
        )
        .all(this.instanceId, afterId, limit) as HostReceiptRow[]
    ).map((row) => ({
      id: row.id,
      envelope: { runId: row.run_id, digest: row.digest, receipt: row.receipt },
    }));
  }

  /**
   * Drop each receipt the leader has durably answered for; repeating it
   * changes nothing. The closed `actor_runs` row remains the host's record of
   * the terminal, and closing a run twice throws, so a dropped receipt is
   * never committed again.
   */
  markAcked(runIds: string[]): number {
    const drop = this.db.prepare(
      `DELETE FROM host_run_receipts WHERE instance_id = ? AND run_id = ?`
    );
    return this.db.transaction(() =>
      runIds.reduce((changed, runId) => changed + drop.run(this.instanceId, runId).changes, 0)
    )();
  }

  private ownsRun(runId: string): boolean {
    const owner = this.db
      .prepare(`SELECT instance_id FROM host_runs WHERE run_id = ?`)
      .get(runId) as { instance_id: string } | undefined;
    if (owner && owner.instance_id !== this.instanceId) {
      throw new Error(`run ${runId} belongs to instance ${owner.instance_id}`);
    }
    return owner !== undefined;
  }

  /** Commit a receipt as the exact bytes every delivery of it sends. */
  private insert(receipt: RunReceipt): void {
    const serialized = serializeRunReceipt(receipt);
    this.db
      .prepare(
        `INSERT INTO host_run_receipts (instance_id, run_id, receipt, digest, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        this.instanceId,
        receipt.runId,
        serialized,
        runReceiptDigest(serialized),
        new Date().toISOString()
      );
  }
}

export type RunReceiptConflictKind = "run_conflict" | "wrong_instance" | "unknown_run";

/**
 * Stored conflicts per identity. A conflict carries at most one bounded
 * receipt document; past this many, a further conflict is refused unstored
 * and stays pending on its host, so the leader's store stays bounded.
 */
export const RUN_RECEIPT_CONFLICTS_MAX_PER_INSTANCE = 1000;

/** The conflict bound refused a receipt; nothing was written. */
export class RunReceiptConflictLimitError extends Error {
  constructor(readonly kind: RunReceiptConflictKind) {
    super(`run receipt conflict limit reached (${kind})`);
    this.name = "RunReceiptConflictLimitError";
  }
}

/**
 * What the leader durably did with one receipt. `applied` wrote the run's
 * terminal. `duplicate` is a retry of the applied receipt and changed
 * nothing. `conflict` stored the receipt without applying it, leaving any
 * accepted terminal untouched; a retry of the same conflict answers the same
 * way and stores nothing more.
 */
export type RunReceiptOutcome =
  | { status: "applied"; actorRunClosed: boolean }
  | { status: "duplicate" }
  | { status: "conflict"; kind: RunReceiptConflictKind };

export interface RunReceiptApplyResult {
  outcome: RunReceiptOutcome;
  receipt: RunReceipt;
}

/**
 * The leader's side of #1020: one applied terminal per run, never replaced,
 * from the instance that owns the run.
 */
export class InstanceRunReceiptRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Register a remote run under the receipt contract together with its
   * `actor_runs` row, so a run is receipt-backed exactly when it exists. The
   * run ID is host-minted and untrusted: one that collides with any existing
   * run throws on the `actor_runs` primary key and writes nothing, so it
   * cannot overwrite that run or change its actor or owning instance.
   *
   * The receipt travels apart from the event stream that carries `runStart`,
   * so it can arrive first and be stored as an `unknown_run` conflict. The
   * registering host's first such receipt is then applied here, in the same
   * transaction (#1119), and returned. Any other early receipt keeps its
   * stored `unknown_run` label: for a run that now exists, that row arrived
   * before `runStart` and was not the receipt applied.
   */
  startRun(opts: {
    runId: string;
    instanceId: string;
    actorId: string;
    modelConfig: ActorRunModelConfig;
    startedAt?: string;
  }): RunReceiptOutcome | undefined {
    const startedAt = opts.startedAt ?? new Date().toISOString();
    return this.db.transaction((): RunReceiptOutcome | undefined => {
      new ActorRunRepository(this.db).start({
        id: opts.runId,
        actorId: opts.actorId,
        startedAt,
        modelConfig: opts.modelConfig,
      });
      this.db
        .prepare(`INSERT INTO instance_runs (run_id, instance_id) VALUES (?, ?)`)
        .run(opts.runId, opts.instanceId);
      const early = this.db
        .prepare(
          `SELECT id, digest, receipt, received_at FROM instance_receipt_conflicts
           WHERE instance_id = ? AND run_id = ? AND kind = 'unknown_run'
           ORDER BY id LIMIT 1`
        )
        .get(opts.instanceId, opts.runId) as
        | { id: number; digest: string; receipt: string; received_at: string }
        | undefined;
      if (!early) return undefined;
      this.db.prepare(`DELETE FROM instance_receipt_conflicts WHERE id = ?`).run(early.id);
      return this.writeTerminal(
        opts.instanceId,
        { runId: opts.runId, digest: early.digest, receipt: early.receipt },
        parseRunReceipt(early.receipt),
        early.received_at
      );
    })();
  }

  /**
   * Receipt-backed runs still open here: no terminal receipt has arrived for
   * them. This is the recovery inventory; it does not say whether a run is
   * still executing or its terminal was lost (#1119 ruling).
   */
  unresolvedRuns(limit: number): {
    runs: number;
    sample: Array<{ runId: string; instanceId: string }>;
  } {
    const open = `FROM actor_runs r JOIN instance_runs i ON i.run_id = r.id WHERE r.outcome IS NULL`;
    const { runs } = this.db.prepare(`SELECT COUNT(*) AS runs ${open}`).get() as { runs: number };
    const sample = this.db
      .prepare(
        `SELECT r.id AS runId, i.instance_id AS instanceId ${open} ORDER BY r.started_at, r.id LIMIT ?`
      )
      .all(limit) as Array<{ runId: string; instanceId: string }>;
    return { runs, sample };
  }

  /**
   * Note a successful provider return for a receipt-backed run, as seen over
   * the transport. It spends the run's share of the durable selected-work
   * recovery budget (#1119) and nothing else: the run stays open until its
   * receipt. Repeating it keeps the first time; returns whether the run is
   * receipt-backed here.
   */
  recordReturn(runId: string, returnedAt = new Date().toISOString()): boolean {
    return (
      this.db
        .prepare(`UPDATE instance_runs SET returned_at = COALESCE(returned_at, ?) WHERE run_id = ?`)
        .run(returnedAt, runId).changes === 1
    );
  }

  isReceiptBacked(runId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM instance_runs WHERE run_id = ?`).get(runId) !== undefined;
  }

  /**
   * Apply one receipt from `instanceId` in a single transaction. The caller
   * has authenticated `instanceId`; a receipt naming another instance throws
   * before anything is written, as does a malformed one or one the conflict
   * bound refuses ({@link RunReceiptConflictLimitError}), and is not
   * acknowledged.
   */
  apply(
    instanceId: string,
    envelope: RunReceiptEnvelope,
    receivedAt = new Date().toISOString()
  ): RunReceiptApplyResult {
    if (runReceiptDigest(envelope.receipt) !== envelope.digest) {
      throw new Error("invalid run receipt: digest does not match");
    }
    const receipt = parseRunReceipt(envelope.receipt);
    if (receipt.instanceId !== instanceId) {
      throw new Error("invalid run receipt: instance does not match the sender");
    }
    if (receipt.runId !== envelope.runId) {
      throw new Error("invalid run receipt: run does not match the envelope");
    }
    return this.db.transaction(
      (): RunReceiptApplyResult => ({
        outcome: this.decide(instanceId, envelope, receipt, receivedAt),
        receipt,
      })
    )();
  }

  private decide(
    instanceId: string,
    envelope: RunReceiptEnvelope,
    receipt: RunReceipt,
    receivedAt: string
  ): RunReceiptOutcome {
    const { runId, digest } = envelope;
    const conflict = (kind: RunReceiptConflictKind): RunReceiptOutcome => {
      // The same refused receipt retried after a lost acknowledgment stores nothing more.
      const stored = this.db
        .prepare(
          `SELECT 1 FROM instance_receipt_conflicts
           WHERE instance_id = ? AND run_id = ? AND digest = ? LIMIT 1`
        )
        .get(instanceId, runId, digest);
      if (stored) return { status: "conflict", kind };
      const { count } = this.db
        .prepare(`SELECT COUNT(*) AS count FROM instance_receipt_conflicts WHERE instance_id = ?`)
        .get(instanceId) as { count: number };
      if (count >= RUN_RECEIPT_CONFLICTS_MAX_PER_INSTANCE) {
        throw new RunReceiptConflictLimitError(kind);
      }
      this.db
        .prepare(
          `INSERT INTO instance_receipt_conflicts
             (instance_id, run_id, kind, digest, receipt, received_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(instanceId, runId, kind, digest, envelope.receipt, receivedAt);
      return { status: "conflict", kind };
    };
    const launch = this.db
      .prepare(`SELECT instance_id FROM instance_runs WHERE run_id = ?`)
      .get(runId) as { instance_id: string } | undefined;
    const terminal = this.db
      .prepare(`SELECT instance_id, digest FROM instance_run_terminals WHERE run_id = ?`)
      .get(runId) as { instance_id: string; digest: string } | undefined;
    const owner = launch?.instance_id ?? terminal?.instance_id;
    if (owner !== undefined && owner !== instanceId) return conflict("wrong_instance");
    // The applied receipt retried after a lost acknowledgment answers as before.
    if (terminal?.digest === digest) return { status: "duplicate" };
    if (terminal) return conflict("run_conflict");
    if (!launch) return conflict("unknown_run");
    return this.writeTerminal(instanceId, envelope, receipt, receivedAt);
  }

  /**
   * Record a run's one terminal and close its open `actor_runs` row. Only the
   * digest is kept: retries and conflicts compare digests, and the closed row
   * carries the receipt's content.
   */
  private writeTerminal(
    instanceId: string,
    envelope: RunReceiptEnvelope,
    receipt: RunReceipt,
    receivedAt: string
  ): RunReceiptOutcome {
    this.db
      .prepare(
        `INSERT INTO instance_run_terminals (run_id, instance_id, digest, received_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(envelope.runId, instanceId, envelope.digest, receivedAt);
    const closed =
      receipt.outcome === "completed"
        ? this.db
            .prepare(
              `UPDATE actor_runs
               SET ended_at = ?, outcome = 'completed', success = ?, exit_code = ?, output = ?
               WHERE id = ? AND outcome IS NULL`
            )
            .run(
              receipt.endedAt,
              receipt.success ? 1 : 0,
              receipt.exitCode,
              receipt.output,
              receipt.runId
            )
        : this.db
            .prepare(
              `UPDATE actor_runs SET ended_at = ?, outcome = 'abandoned', abandon_reason = ?
               WHERE id = ? AND outcome IS NULL`
            )
            .run(receipt.endedAt, receipt.reason, receipt.runId);
    return { status: "applied", actorRunClosed: closed.changes === 1 };
  }
}
