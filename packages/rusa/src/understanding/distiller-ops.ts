import type { MeshEventKind } from "../db/repositories/mesh-event-repository.js";
import {
  computeAdvance,
  computeWindow,
  type DistillerStore,
  type SeededState,
} from "./distiller-cursor.js";

/**
 * The distiller **cursor operations**  — pure functions over a {@link DistillerStore}
 * that own the durable `lastDistilled` cursor so the LLM never hand-writes it: `gate`
 * (day-activity check), `seed` (one-time cursor seed), `window` (capped scan window),
 * `advance` (commit the cursor per policy). These are
 * actor-invoked, so they are exposed via the **distiller MCP**  — NOT the `rusa`
 * CLI (per ISSUE_NUM: actor-invoked ops go through MCP). Reading the activity itself is the
 * actor's own job (git/gh/mesh via the runbook).
 */

const NOT_SEEDED = "distiller cursor not seeded — call the distiller MCP `distill_seed` first";

/**
 * The mesh_event kinds that count as **substantive** activity for the nightly day-gate
 * . These are CONTENT + topology events — real actor collaboration and mesh
 * structure changes. Heartbeat / turn-lifecycle kinds (`scheduled_wake` and ALL `run_*` +
 * `continuation_capped`) are deliberately EXCLUDED: they're per-turn noise, not content —
 * and counting them would make the gate self-trigger every night (the distiller's own
 * nightly wake writes a `scheduled_wake` + its run brackets). Excluding *all* `run_*`
 * (rather than filtering by actorId) is both simpler and correct: the substantive work
 * always also surfaces as one of the kinds below.
 */
export const SUBSTANTIVE_EVENT_KINDS: readonly MeshEventKind[] = [
  "message_sent",
  "actor_spawned",
  "actor_retired",
  "actor_revived",
  "handle_granted",
  "capability_granted",
  "capability_revoked",
  "event_source_subscribed",
  "event_source_unsubscribed",
];

/**
 * `gate`: is there substantive mesh activity since the last successful distill? The gate
 * window is the **full** `[lastDistilled, now)` (NOT the capped scan window from
 * `distill window`) — so a quiet steady-state night skips, while a backlog whose activity
 * sits beyond the per-run cap still runs (the capped scan + cursor advance then walk
 * toward it over successive runs, never stalling). A genuinely empty stretch holds the
 * cursor harmlessly until activity appears. `countSince(since, until)` counts
 * {@link SUBSTANTIVE_EVENT_KINDS} in `[since, until)` — injected for testability.
 */
export function distillGate(
  store: DistillerStore,
  nowISO: string,
  countSince: (sinceISO: string, untilISO: string) => number
): { active: boolean; since: string; until: string; count: number } {
  const s = store.getState();
  if (s.lastDistilled === null) throw new Error(NOT_SEEDED);
  const count = countSince(s.lastDistilled, nowISO);
  return { active: count > 0, since: s.lastDistilled, until: nowISO, count };
}

/** `seed`: set the cursor (only if unset) from the latest glass-goals op. */
export function distillSeed(
  store: DistillerStore,
  seedISO: string
): { seeded: boolean; cursor: string } {
  const seeded = store.seedIfUnset(seedISO);
  return { seeded, cursor: store.getState().lastDistilled ?? seedISO };
}

/** `window`: the capped walk-forward window + whether it can read mesh. */
export function distillWindow(
  store: DistillerStore,
  nowISO: string,
  capDays?: number
): { from: string; to: string; includesMesh: boolean } {
  const s = store.getState();
  if (s.lastDistilled === null) throw new Error(NOT_SEEDED);
  const w = computeWindow(s.lastDistilled, nowISO, capDays);
  return { from: w.from, to: w.to, includesMesh: w.includesMesh };
}

/** `advance`: commit the cursor to the processed window end per the advance policy. */
export function distillAdvance(
  store: DistillerStore,
  to: string,
  ok: boolean
): {
  lastDistilled: string | null;
  consecutiveFailures: number;
  gap: { from: string; to: string } | null;
} {
  const s = store.getState();
  if (s.lastDistilled === null) throw new Error(NOT_SEEDED);
  if (to < s.lastDistilled) {
    throw new Error(
      `refusing to move the cursor backward: to=${to} < lastDistilled=${s.lastDistilled}`
    );
  }
  const { state: next, gap } = computeAdvance(s as SeededState, to, ok);
  store.setState(next);
  return {
    lastDistilled: next.lastDistilled,
    consecutiveFailures: next.consecutiveFailures,
    gap: gap ? { from: gap.from, to: gap.to } : null,
  };
}
