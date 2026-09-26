import { RunStartCancelledError, type RunStartHandle } from "./concurrency-limiter.js";

/** Capability required for a run to reserve exclusive computer control on its instance. */
export const COMPUTER_USE_CAPABILITY = "computer-use";

type Start<T> = () => Promise<T> | RunStartHandle<T>;

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
  constructor(private readonly onError?: (error: unknown) => void) {}

  private holder: { entry: LockEntry<unknown>; token: symbol; preempted?: boolean } | undefined;
  private readonly responsiveQueue: LockEntry<unknown>[] = [];
  private readonly normalQueue: LockEntry<unknown>[] = [];
  private readonly pendingReRequests: Array<() => void> = [];
  private closed = false;

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
    };
    if (this.closed) {
      entry.state = "settled";
      reject(new RunStartCancelledError());
    } else {
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
