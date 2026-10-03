import type { Logger } from "../observability/logger.js";
import { RunStartCancelledError, type RunStartHandle } from "./concurrency-limiter.js";

/** Capability required for a run to reserve exclusive computer control on its instance. */
export const COMPUTER_USE_CAPABILITY = "computer-use";

type Start<T> = () => Promise<T> | RunStartHandle<T>;

export interface ComputerUseLockWaitEvent {
  actorId: string;
  holderActorId: string;
  responsive: boolean;
  holderResponsive?: boolean;
}

export interface ComputerUseLockAcquiredEvent {
  actorId: string;
  responsive: boolean;
  waited: boolean;
  waitedMs?: number;
}

export type ComputerUseLockOnError = (error: unknown) => void;

export interface ComputerUseLockOptions {
  onError?: ComputerUseLockOnError;
  logger?: Logger;
  onWait?: (event: ComputerUseLockWaitEvent) => void;
  onAcquired?: (event: ComputerUseLockAcquiredEvent) => void;
}

interface LockEntry<T> {
  readonly actorId: string;
  responsive: boolean;
  readonly start: Start<T>;
  readonly interrupt?: () => void;
  readonly reRequest?: () => void;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
  state: "queued" | "locked" | "settled";
  inner?: RunStartHandle<T>;
  readonly enqueuedAt: number;
  waited: boolean;
}

/**
 * Serializes runs which can control a single execution instance's computer.
 *
 * This is deliberately an instance-local admission layer, not a mesh-wide lock:
 * a follower owns its own desktop and a local leader owns a different one. A
 * responsive waiter asks a normal holder to stop, but the waiter never begins
 * until that holder's gate has actually settled and released its token.
 */
export class ComputerUseLock {
  private readonly onError?: ComputerUseLockOnError;
  private readonly logger?: Logger;
  private readonly onWait?: (event: ComputerUseLockWaitEvent) => void;
  private readonly onAcquired?: (event: ComputerUseLockAcquiredEvent) => void;

  constructor(options?: ComputerUseLockOnError | ComputerUseLockOptions) {
    if (typeof options === "function") {
      this.onError = options;
    } else if (options) {
      this.onError = options.onError;
      this.logger = options.logger;
      this.onWait = options.onWait;
      this.onAcquired = options.onAcquired;
    }
  }

  private holder: { entry: LockEntry<unknown>; token: symbol; preempted?: boolean } | undefined;
  private readonly responsiveQueue: LockEntry<unknown>[] = [];
  private readonly normalQueue: LockEntry<unknown>[] = [];
  private readonly pendingReRequests: Array<() => void> = [];
  private closed = false;

  get currentHolder(): { readonly actorId: string; readonly responsive: boolean } | undefined {
    if (!this.holder) return undefined;
    return {
      actorId: this.holder.entry.actorId,
      responsive: this.holder.entry.responsive,
    };
  }

  get isLocked(): boolean {
    return this.holder !== undefined;
  }

  get queueDepth(): { responsive: number; normal: number } {
    return {
      responsive: this.responsiveQueue.length,
      normal: this.normalQueue.length,
    };
  }

  gate<T>(
    actorId: string,
    responsive: boolean,
    start: Start<T>,
    interrupt?: () => void,
    reRequest?: () => void
  ): RunStartHandle<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const result = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: LockEntry<T> = {
      actorId,
      responsive,
      start,
      interrupt,
      reRequest,
      resolve,
      reject,
      state: "queued",
      enqueuedAt: Date.now(),
      waited: false,
    };
    if (this.closed) {
      entry.state = "settled";
      reject(new RunStartCancelledError());
    } else {
      if (this.holder !== undefined) {
        entry.waited = true;
        this.reportWait(
          entry.actorId,
          this.holder.entry.actorId,
          entry.responsive,
          this.holder.entry.responsive
        );
      }
      this.enqueue(entry);
      this.requestResponsivePreemption(entry);
      this.pump();
    }

    return {
      result,
      get started() {
        return entry.inner?.started ?? entry.state === "locked";
      },
      promote: () => {
        if (entry.state === "queued") {
          entry.responsive = true;
          this.remove(entry);
          this.responsiveQueue.push(entry as LockEntry<unknown>);
          this.requestResponsivePreemption(entry);
          this.pump();
          return;
        }
        entry.inner?.promote();
      },
      cancel: () => {
        if (entry.state === "queued") {
          this.remove(entry);
          entry.state = "settled";
          reject(new RunStartCancelledError());
          return true;
        }
        return entry.inner?.cancel?.() ?? false;
      },
    };
  }

  /**
   * Enters this instance's lock only after the caller's provider gate admits
   * the run. The capability predicate is likewise read at that boundary, so a
   * grant or revoke while provider pacing is pending applies to this run.
   */
  gateAfterProvider<T, Selected>(
    actorId: string,
    responsive: boolean,
    providerGate: (start: (selected: Selected) => Promise<T>) => Promise<T> | RunStartHandle<T>,
    start: (selected: Selected) => Promise<T>,
    shouldLock: () => boolean,
    interrupt?: () => void,
    reRequest?: () => void
  ): Promise<T> | RunStartHandle<T> {
    let lockHandle: RunStartHandle<T> | undefined;
    let lockResponsive = responsive;
    const providerHandle = providerGate((selected) => {
      if (!shouldLock()) return start(selected);
      lockHandle = this.gate(actorId, lockResponsive, () => start(selected), interrupt, reRequest);
      return lockHandle.result;
    });
    if (!isRunStartHandle(providerHandle)) return providerHandle;
    return {
      result: providerHandle.result,
      get started() {
        // While provider admission waits on this lock, Actor must still be
        // able to promote or cancel the lock entry.
        return lockHandle?.started ?? providerHandle.started;
      },
      promote: () => {
        // Provider pacing may not admit the run until after this call. Keep
        // the promoted state for the lock entry created at that later boundary.
        lockResponsive = true;
        providerHandle.promote();
        lockHandle?.promote();
      },
      cancel: () => lockHandle?.cancel?.() ?? providerHandle.cancel?.call(providerHandle) ?? false,
    };
  }

  /** Stops queued runs and interrupts the holder during instance teardown. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.responsiveQueue, ...this.normalQueue]) {
      entry.state = "settled";
      entry.reject(new RunStartCancelledError());
    }
    this.responsiveQueue.length = 0;
    this.normalQueue.length = 0;
    this.pendingReRequests.length = 0;
    this.holder?.entry.interrupt?.();
  }

  private enqueue<T>(entry: LockEntry<T>): void {
    (entry.responsive ? this.responsiveQueue : this.normalQueue).push(entry as LockEntry<unknown>);
  }

  private remove<T>(entry: LockEntry<T>): void {
    for (const queue of [this.responsiveQueue, this.normalQueue]) {
      const index = queue.indexOf(entry as LockEntry<unknown>);
      if (index >= 0) queue.splice(index, 1);
    }
  }

  private requestResponsivePreemption<T>(entry: LockEntry<T>): void {
    if (!entry.responsive || !this.holder || this.holder.entry.responsive || this.holder.preempted)
      return;
    this.holder.preempted = true;
    this.holder.entry.interrupt?.();
  }

  private pump(): void {
    if (this.closed || this.holder) return;
    if (this.responsiveQueue.length === 0) {
      this.drainPreemptedReRequests();
    }
    const entry = this.responsiveQueue.shift() ?? this.normalQueue.shift();
    if (!entry || entry.state !== "queued") return;
    entry.state = "locked";
    const token = Symbol(`computer-use-lock:${entry.actorId}`);
    this.holder = { entry, token };
    const waited = entry.waited;
    const waitedMs = waited ? Math.max(0, Date.now() - entry.enqueuedAt) : undefined;
    this.reportAcquired(entry.actorId, entry.responsive, waited, waitedMs);
    let started: Promise<unknown>;
    try {
      const inner = entry.start();
      if (isRunStartHandle(inner)) entry.inner = inner;
      started = isRunStartHandle(inner) ? inner.result : inner;
    } catch (err) {
      started = Promise.reject(err);
    }
    void started.then(entry.resolve, entry.reject).finally(() => this.release(entry, token));
  }

  private reportWait(
    actorId: string,
    holderActorId: string,
    responsive: boolean,
    holderResponsive?: boolean
  ): void {
    this.logger?.info("computer_use_wait", {
      actorId,
      holderActorId,
      responsive,
      holderResponsive,
    });
    this.onWait?.({
      actorId,
      holderActorId,
      responsive,
      holderResponsive,
    });
  }

  private reportAcquired(
    actorId: string,
    responsive: boolean,
    waited: boolean,
    waitedMs?: number
  ): void {
    this.logger?.info("computer_use_acquired", {
      actorId,
      responsive,
      waited,
      waitedMs,
    });
    this.onAcquired?.({
      actorId,
      responsive,
      waited,
      waitedMs,
    });
  }

  private release(entry: LockEntry<unknown>, token: symbol): void {
    // A late completion from an already-settled holder must never free a newer lock.
    if (this.holder?.entry !== entry || this.holder.token !== token) return;
    const wasPreempted = this.holder.preempted;
    const reRequest = entry.reRequest;
    entry.state = "settled";
    this.holder = undefined;
    if (wasPreempted && reRequest) {
      this.pendingReRequests.push(reRequest);
    }
    this.pump();
  }

  private drainPreemptedReRequests(): void {
    if (this.closed || this.pendingReRequests.length === 0) return;
    const callbacks = this.pendingReRequests.splice(0);
    for (const reRequest of callbacks) {
      try {
        reRequest();
      } catch (err) {
        this.onError?.(err);
      }
    }
  }
}

function isRunStartHandle<T>(value: Promise<T> | RunStartHandle<T>): value is RunStartHandle<T> {
  return "result" in value && "promote" in value;
}
