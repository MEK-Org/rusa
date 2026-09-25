/** Releases one acquired resource. May be synchronous or return a promise. */
export type Disposer = () => void | Promise<void>;

/** A disposer that threw or rejected, named by the resource it was releasing. */
export interface DisposeFailure {
  resource: string;
  error: unknown;
}

/**
 * The single disposer owner for a composition's long-lived resources.
 *
 * Every timer, listener, server, poller, subscriber, abort controller or
 * handle a composition takes is registered here the moment it is acquired,
 * and nowhere else. Closing releases them newest-first, so a resource is
 * released before anything it was built on. Each disposer is attempted even
 * when an earlier one fails; failures are reported and returned rather than
 * thrown, because an abandoned shutdown leaks everything after the failure.
 *
 * Closing is idempotent: every caller gets the same promise, so a repeated
 * shutdown, or a partial boot closed by its own error path, releases each
 * resource exactly once.
 */
export class ResourceScope {
  private readonly held: { resource: string; dispose: Disposer }[] = [];
  private closing: Promise<readonly DisposeFailure[]> | null = null;
  private onFailure: (failure: DisposeFailure) => void;

  constructor(options: { onFailure?: (failure: DisposeFailure) => void } = {}) {
    this.onFailure = options.onFailure ?? (() => {});
  }

  /** Route disposer failures to a reporter that did not exist when the scope was made. */
  reportFailuresTo(onFailure: (failure: DisposeFailure) => void): void {
    this.onFailure = onFailure;
  }

  get closed(): boolean {
    return this.closing !== null;
  }

  /**
   * Register the disposer for a resource just acquired. A resource acquired
   * after close has begun is released immediately instead of being dropped:
   * there is no later close left to reach it.
   */
  acquire(resource: string, dispose: Disposer): void {
    if (this.closing) {
      void this.attempt(resource, dispose);
      return;
    }
    this.held.push({ resource, dispose });
  }

  /** Release every held resource in reverse acquisition order. */
  close(): Promise<readonly DisposeFailure[]> {
    this.closing ??= this.releaseAll();
    return this.closing;
  }

  private async releaseAll(): Promise<readonly DisposeFailure[]> {
    const failures: DisposeFailure[] = [];
    for (let held = this.held.pop(); held; held = this.held.pop()) {
      const failure = await this.attempt(held.resource, held.dispose);
      if (failure) failures.push(failure);
    }
    return failures;
  }

  private async attempt(resource: string, dispose: Disposer): Promise<DisposeFailure | null> {
    try {
      await dispose();
      return null;
    } catch (error) {
      const failure = { resource, error };
      try {
        this.onFailure(failure);
      } catch {
        // A reporter that throws must not stop the remaining disposers.
      }
      return failure;
    }
  }
}
