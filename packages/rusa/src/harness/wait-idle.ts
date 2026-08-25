import { abandonedRunHadStarted } from "../actor/mesh-events.js";
import type { MeshEvent } from "../db/repositories/mesh-event-repository.js";

/**
 * Wait for a worker to finish processing a step (design ISSUE_NUM harness). A worker
 * keeps the self-continuation floor until it yields, so ONE operator message can
 * produce several runs. The only durable, provider-agnostic completion signal is the
 * `mesh_events` log, so the driver polls it: a step is done once the actor has
 * produced at least one new `run_end`, has no in-flight run (a `run_start` with
 * neither a `run_end` nor an after-start abandonment), and has been quiet (no new
 * lifecycle event) for `quietMs`.
 *
 * The waiter takes its clock, sleep, and event source as injected deps so it is unit-
 * testable against a scripted event stream (no real mesh, no timers).
 */

export interface ActorActivity {
  runStarts: number;
  /**
   * Completed runs only. This is the step's unit of WORK — it drives progress,
   * the per-step cap, and the baseline carried between steps — so an abandoned
   * run must not inflate it: a coalesce-abort produces no output and costs
   * almost no provider window, and counting it would spend the cap on nothing.
   */
  runEnds: number;
  /**
   * Everything that CLOSES a started run: `run_end`, plus a `run_abandoned` that
   * got as far as starting. This is the step's unit of OUTSTANDING WORK, which
   * is a different question from how much work completed, and conflating the two
   * is the bug: a coalesced run emits `run_start` and no `run_end`, so bracketing
   * on `run_end` alone left the waiter permanently in-flight (ISSUE_NUM, found on
   * review of the producer-side fix).
   *
   * Deliberately NOT every abandonment — see {@link abandonedRunHadStarted}. A
   * run cancelled while queued behind the concurrency cap never started, so
   * counting it here would cancel out an unrelated live run and report idle over
   * a running actor.
   */
  runClosures: number;
}

export interface SummarizeActivityOptions {
  /**
   * Only count events strictly after this event ID.
   */
  afterEventId?: string | null;
  /**
   * Only count events at or after this event ID.
   */
  sinceEventId?: string | null;
}

/** Count the run-lifecycle brackets for one actor in an event list. */
export function summarizeActivity(
  events: readonly MeshEvent[],
  actorId: string,
  opts?: SummarizeActivityOptions
): ActorActivity {
  let startIndex = 0;
  if (opts?.afterEventId) {
    const idx = events.findIndex((e) => e.id === opts.afterEventId);
    if (idx !== -1) {
      startIndex = idx + 1;
    }
  } else if (opts?.sinceEventId) {
    const idx = events.findIndex((e) => e.id === opts.sinceEventId);
    if (idx !== -1) {
      startIndex = idx;
    }
  }

  let runStarts = 0;
  let runEnds = 0;
  let runClosures = 0;
  for (let i = startIndex; i < events.length; i++) {
    const e = events[i];
    if (e.actorId !== actorId) continue;
    if (e.kind === "run_start") runStarts += 1;
    else if (e.kind === "run_end") {
      runEnds += 1;
      runClosures += 1;
    } else if (e.kind === "run_abandoned" && abandonedRunHadStarted(e.payload)) {
      runClosures += 1;
    }
  }
  return { runStarts, runEnds, runClosures };
}

export interface IdleWaitDeps {
  /** Fetch the current event log (all actors; the waiter filters by actorId). */
  poll: () => Promise<readonly MeshEvent[]>;
  sleep: (ms: number) => Promise<void>;
  /** Monotonic-ish clock in ms. */
  now: () => number;
}

export interface IdleWaitOptions {
  actorId: string;
  /** `run_end` count for the actor observed BEFORE the step's message was sent. */
  baselineRunEnds?: number;
  /**
   * `run_start` count for the actor observed BEFORE the step's message was sent.
   * Windowing in-flight calculation from this baseline ensures unclosed historical
   * run_start records do not wedge idle detection .
   */
  baselineRunStarts?: number;
  /**
   * `run_closures` count for the actor observed BEFORE the step's message was sent.
   */
  baselineRunClosures?: number;
  /**
   * Optional full activity baseline observed BEFORE the step's message was sent.
   * When provided, supplies default values for `baselineRunEnds`, `baselineRunStarts`,
   * and `baselineRunClosures`.
   */
  baselineActivity?: ActorActivity;
  /**
   * Optional event ID observed BEFORE the step's message was sent. When provided,
   * activity is windowed strictly after this event ID.
   */
  afterEventId?: string | null;
  /** No new `run_start` for this long (ms) ⇒ self-continuation has ceased. */
  quietMs: number;
  pollMs: number;
  timeoutMs: number;
  /**
   * Optional cap on `run_end`s a single step may consume before the waiter returns
   * (design ISSUE_NUM, G2-v3 rail 1). Self-continuation is ~94% of this rig's burn — one
   * operator message costs 17–21 runs — so a step that keeps continuing is the
   * dominant way an arm eats a provider window. Bounding only on `quietMs` /
   * `timeoutMs` cannot express "let this step have at most N runs": a busy arm never
   * goes quiet and a fast arm burns the cap long before the timeout.
   *
   * Reaching the cap does NOT stop the actor — nothing here can — it stops the driver
   * WAITING, and is recorded as {@link IdleWaitResult.capped} so the step lands in the
   * report as truncated instead of silently degrading the arm. Undefined = no cap.
   */
  maxRunEnds?: number;
}

export interface IdleWaitResult {
  /** false ⇒ returned before the actor went idle (timeout or cap). */
  idle: boolean;
  /** `run_end` count for the actor at return. */
  runEnds: number;
  /**
   * true ⇒ returned because the step exhausted {@link IdleWaitOptions.maxRunEnds}, not
   * because the actor was observed to finish. The step's output is whatever the arm had
   * produced at that point.
   *
   * Read this as "the run budget ran out", NOT as "work was definitely lost". The cap
   * fires the moment the budget is spent, which is necessarily before the quiet window
   * could confirm the arm had stopped on its own — so a step that used exactly its
   * budget and was already done still comes back `capped`. That over-reports truncation
   * by design: `capped` is a warning, and a warning that occasionally fires on a
   * complete step is much cheaper than one that stays silent on a cut-off probe. It is
   * the same asymmetry the whole G2-v3 correction is about.
   */
  capped: boolean;
  /** The event log at return (for the driver to slice the step's new events from). */
  events: readonly MeshEvent[];
}

/**
 * Poll until the actor is idle after a step, or `timeoutMs` elapses, or the step's
 * `run_end`s reach `maxRunEnds`. Idle = progressed past the baseline `run_end` count,
 * no in-flight run, and quiet for `quietMs`. On timeout or cap returns
 * `{ idle: false, ... }` (the driver decides whether a partial step is fatal) rather
 * than throwing, so a single stuck arm doesn't abort the whole comparison.
 */
export async function waitForActorIdle(
  deps: IdleWaitDeps,
  opts: IdleWaitOptions
): Promise<IdleWaitResult> {
  const start = deps.now();
  let lastRunStarts = -1;
  let lastRunClosures = -1;
  let lastActivityAt = start;

  const baselineRunEnds = opts.baselineRunEnds ?? opts.baselineActivity?.runEnds ?? 0;
  const baselineRunStarts = opts.baselineRunStarts ?? opts.baselineActivity?.runStarts ?? 0;
  const baselineRunClosures = opts.baselineRunClosures ?? opts.baselineActivity?.runClosures ?? 0;

  for (;;) {
    const events = await deps.poll();
    const { runStarts, runEnds, runClosures } = summarizeActivity(events, opts.actorId);

    // Reset the quiet clock on ANY lifecycle change — a run_end as well as a
    // run_start. Watching only run_start lets a run longer than quietMs satisfy
    // `quiet` on its first run_end, so a self-continuation's run_start landing a
    // moment later is missed and its run_end slices into the NEXT step's window.
    // An abandonment is such a change too, and it is watched via runClosures.
    if (runStarts !== lastRunStarts || runClosures !== lastRunClosures) {
      lastRunStarts = runStarts;
      lastRunClosures = runClosures;
      lastActivityAt = deps.now();
    }

    const progressed = runEnds > baselineRunEnds;
    // Window the in-flight balance from the baseline step boundary .
    // Comparing lifetime runStarts > runClosures causes any historical unclosed
    // run_start (e.g. from pre-ISSUE_NUM coalesce aborts) to permanently hang the waiter.
    const stepRunStarts =
      opts.afterEventId != null
        ? summarizeActivity(events, opts.actorId, { afterEventId: opts.afterEventId }).runStarts
        : runStarts - baselineRunStarts;
    const stepRunClosures =
      opts.afterEventId != null
        ? summarizeActivity(events, opts.actorId, { afterEventId: opts.afterEventId }).runClosures
        : runClosures - baselineRunClosures;
    const inFlight = stepRunStarts > stepRunClosures;
    const quiet = deps.now() - lastActivityAt >= opts.quietMs;

    if (progressed && !inFlight && quiet) {
      return { idle: true, runEnds, capped: false, events };
    }
    // Check the cap BEFORE the timeout: both are "we stopped waiting", but they are
    // different findings and the report must not conflate a step that burned its run
    // budget with one that hung.
    if (opts.maxRunEnds !== undefined && runEnds - baselineRunEnds >= opts.maxRunEnds) {
      return { idle: false, runEnds, capped: true, events };
    }
    if (deps.now() - start >= opts.timeoutMs) {
      return { idle: false, runEnds, capped: false, events };
    }
    await deps.sleep(opts.pollMs);
  }
}
