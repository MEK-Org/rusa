import type { GracefulShutdown } from "../actor/graceful-shutdown.js";
import type { DrainSeam } from "./orchestrator.js";

/**
 * Bounded poll for a quiescence predicate — resolves as soon as it's true, or at
 * `timeoutMs`, whichever first. NEVER waits past the deadline. `sleep`/`now` are
 * injected so tests drive it with a fake clock.
 *
 * Macrotask-before-first-check (elder review): a run that passed `await beforeRun()`
 * just before the brake engaged is committed, but its `executing` flag is set one
 * MICROTASK after beforeRun resolves. A synchronous first check could observe that
 * committed run as absent (flag still pending) and wrongly report quiescence. So we
 * cross one MACROTASK (`sleep(0)` = setTimeout) before the first conclusive check:
 * macrotasks run after the microtask queue drains, so every committed run's flag is
 * set by then. This turns "no in-flight run is ever missed" from a probability into
 * a guarantee. (Cost: one event-loop tick — negligible.)
 */
export async function waitForQuiescence(
  isQuiescent: () => boolean,
  opts: {
    timeoutMs: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  }
): Promise<{ quiesced: boolean; waitedMs: number }> {
  const intervalMs = Math.max(1, opts.intervalMs ?? 500);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const start = now();
  const deadline = start + Math.max(0, opts.timeoutMs);

  // Drain the microtask queue before the first conclusive read (see above).
  await sleep(0);
  if (isQuiescent()) return { quiesced: true, waitedMs: now() - start };
  while (now() < deadline) {
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
    if (isQuiescent()) return { quiesced: true, waitedMs: now() - start };
  }
  return { quiesced: false, waitedMs: now() - start };
}

/**
 * Production {@link DrainSeam}: drive the mesh's in-memory {@link GracefulShutdown}
 * brake directly (no HTTP, no separate process) and wait for the mesh to quiesce.
 *
 * **Self-excluding barrier (elder fix #1):** the `update` tool runs inside root's
 * OWN run, so root is in `runningThreadIds` (its executing flag is set). A naive
 * "wait until runningThreadIds is empty" would DEADLOCK — root waiting on itself.
 * The barrier is therefore `runningThreadIds \ {selfId} == ∅`: no OTHER actor
 * running. Because `beforeRun → executing` is synchronous, an actor that passed its
 * gate before we engaged the brake is already counted, so no in-flight run is
 * missed; and the brake stops any NEW run from starting. Bounded by `timeoutMs`
 * (we exit anyway on timeout — abandoning a stuck actor beats wedging forever).
 */
export class MeshDrainer implements DrainSeam {
  constructor(
    private readonly graceful: GracefulShutdown,
    private readonly runningThreadIds: () => Set<string>,
    private readonly selfId: string,
    private readonly intervalMs = 500
  ) {}

  engage(reason: string): void {
    this.graceful.request(reason);
  }

  cancel(): void {
    this.graceful.cancel();
  }

  /** Count of actors OTHER than self currently executing a run. */
  private othersRunning(): number {
    const ids = this.runningThreadIds(); // a fresh snapshot Set each call
    ids.delete(this.selfId);
    return ids.size;
  }

  waitForQuiescence(timeoutMs: number): Promise<{ quiesced: boolean; waitedMs: number }> {
    return waitForQuiescence(() => this.othersRunning() === 0, {
      timeoutMs,
      intervalMs: this.intervalMs,
    });
  }
}
