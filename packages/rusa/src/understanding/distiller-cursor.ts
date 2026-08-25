import type { SyncClient } from "@thkp-eng/goals-core";
import type Database from "better-sqlite3";

/**
 * The nightly distiller's durable cursor (ISSUE_NUM phase 2a — lean). A single
 * `last_distilled` ISO + a consecutive-failure counter, stored as KV
 * rows in the EXISTING `understanding_sync_metadata` table (same pattern as its
 * `client_id`/`cursor` rows) — not a dotfile. (A dotfile's "survives a DB reset"
 * argument is void: a DB reset also destroys `mesh_events`, the distiller's input,
 * so losing the cursor is no worse than losing the source.)
 *
 * The advance is the one piece that must run **the same way every time**, so it's
 * deterministic code (driven by the `rusa distill` CLI), never the LLM
 * hand-writing the ISO.
 *
 * The cursor is NOT seeded to a hardcoded epoch — it's seeded once from the latest
 * glass-goals op (the last time the graph was actually updated) and walks forward
 * from there (`distill seed`). {@link MESH_EVENTS_AVAILABLE_FROM} is a SEPARATE
 * fact — the date mesh_events begin to exist — used only to decide whether a given
 * window can read mesh_events ({@link windowIncludesMesh}), not where to start.
 */

/**
 * The date mesh_events begin to exist (actor-mesh era, ~ISSUE_NUM, Jun 2026). NOT the
 * distillation start — only the lower bound below which the mesh source is empty, so
 * pre-this windows distill from git + GitHub history alone (ISSUE_NUM, Operator's epoch fix).
 */
export const MESH_EVENTS_AVAILABLE_FROM = "2026-06-17T00:00:00.000Z";
/** Capped walk-forward window width (days); doubles as the backfill chunk size. */
export const DEFAULT_CAP_DAYS = 3;
/** Consecutive whole-run failures before we force-advance past a window with a gap. */
export const DEFAULT_GAP_THRESHOLD = 3;

const DAY_MS = 86_400_000;
const K_CURSOR = "iu_distiller_cursor";
const K_FAILURES = "iu_distiller_consecutive_failures";

export interface DistillerState {
  /**
   * `last_distilled` — the single forward floor for all sources. `null` until the
   * cursor is seeded (from the latest glass-goals op) via `distill seed`.
   */
  lastDistilled: string | null;
  consecutiveFailures: number;
}

export interface DistillerWindow {
  from: string;
  to: string;
  /** Whether this window can read mesh_events (its end is past the mesh-era floor). */
  includesMesh: boolean;
}

/** Narrow cursor persistence boundary used by the distiller core and MCP. */
export interface DistillerStore {
  getState(): DistillerState;
  setState(state: DistillerState): void;
  seedIfUnset(iso: string): boolean;
}

/**
 * Does the half-open window `[from, to)` overlap the mesh-era range? mesh_events
 * exist only for `ts >= MESH_EVENTS_AVAILABLE_FROM`, so a window can read them iff
 * its end is past that floor. Pre-floor windows distill from git + GitHub only.
 */
export function windowIncludesMesh(to: string): boolean {
  return to > MESH_EVENTS_AVAILABLE_FROM;
}

/**
 * The ISO creation time of the latest op in a glass-goals instance — the last time
 * the graph was actually updated, which seeds the initial cursor (ISSUE_NUM, Operator's epoch
 * fix). Returns null when the graph has no ops (caller falls back). Scans every
 * goal's log entries for the max `creationTime`.
 */
export function latestOpCreatedAt(syncClient: SyncClient): string | null {
  let maxMs = 0;
  for (const goal of syncClient.getGoals().values()) {
    for (const entry of goal.log) {
      if (entry.creationTime > maxMs) maxMs = entry.creationTime;
    }
  }
  return maxMs > 0 ? new Date(maxMs).toISOString() : null;
}

/**
 * Decide the seed ISO (pure). Critically distinguishes glass-goals **unreachable**
 * from **genuinely empty** (ISSUE_NUM 2b — root's seed-fallback refinement): seeding is
 * one-shot (`seedIfUnset`), so seeding the mesh-floor during a transient outage would
 * permanently lock a cursor that SKIPS the pre-mesh backfill. So:
 *  - **not reachable** → don't seed (`seed: null`); retry next run.
 *  - reachable, graph has ops → seed at the latest op (walk forward from the last update).
 *  - reachable, graph empty → seed at the mesh-events floor (the only correct floor when
 *    there's no graph history yet).
 */
export function resolveSeed(
  reachable: boolean,
  latestOpISO: string | null
): { seed: string | null; reason: string } {
  if (!reachable) return { seed: null, reason: "glass-goals-unreachable" };
  if (latestOpISO) return { seed: latestOpISO, reason: "glass-goals-latest-op" };
  return { seed: MESH_EVENTS_AVAILABLE_FROM, reason: "empty-graph-mesh-floor" };
}

/** A skipped window after K consecutive failures — logged, not silently dropped. */
export interface DistillerGap {
  from: string;
  to: string;
  reason: string;
}

export interface AdvanceResult {
  state: DistillerState;
  gap?: DistillerGap;
}

/** The capped walk-forward window `[lastDistilled, min(now, lastDistilled + capDays))`. */
export function computeWindow(
  lastDistilled: string,
  nowISO: string,
  capDays: number = DEFAULT_CAP_DAYS
): DistillerWindow {
  const cappedEnd = new Date(new Date(lastDistilled).getTime() + capDays * DAY_MS).toISOString();
  const to = nowISO < cappedEnd ? nowISO : cappedEnd;
  return { from: lastDistilled, to, includesMesh: windowIncludesMesh(to) };
}

/** A cursor state that has been seeded (advance only ever runs post-seed). */
export type SeededState = DistillerState & { lastDistilled: string };

/**
 * The advance policy (pure, deterministic). Advance to the PROCESSED window end
 * (never "now") only when ALL sources succeeded; on failure hold the cursor and
 * increment; after K consecutive failures, force-advance past the window with a
 * logged gap so a persistently-down source can't wedge the loop forever.
 */
export function computeAdvance(
  state: SeededState,
  windowEnd: string,
  allOk: boolean,
  gapThreshold: number = DEFAULT_GAP_THRESHOLD
): AdvanceResult {
  if (allOk) {
    return { state: { ...state, lastDistilled: windowEnd, consecutiveFailures: 0 } };
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  if (consecutiveFailures >= gapThreshold) {
    return {
      state: { ...state, lastDistilled: windowEnd, consecutiveFailures: 0 },
      gap: {
        from: state.lastDistilled,
        to: windowEnd,
        reason: `${consecutiveFailures} consecutive failures — force-advancing past [${state.lastDistilled}, ${windowEnd})`,
      },
    };
  }
  return { state: { ...state, consecutiveFailures } }; // hold the cursor; re-read next run
}

/** KV-backed cursor store over `understanding_sync_metadata`. */
export class DistillerCursorStore implements DistillerStore {
  constructor(private readonly db: Database.Database) {}

  private read(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM understanding_sync_metadata WHERE key = ?")
      .get(key) as { value: string | null } | undefined;
    return row?.value ?? undefined;
  }

  private write(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO understanding_sync_metadata (key, value) VALUES (?, ?)")
      .run(key, value);
  }

  getState(): DistillerState {
    return {
      lastDistilled: this.read(K_CURSOR) ?? null, // null until seeded (distill seed)
      consecutiveFailures: Number.parseInt(this.read(K_FAILURES) ?? "0", 10) || 0,
    };
  }

  setState(state: DistillerState): void {
    this.db.transaction(() => {
      if (state.lastDistilled !== null) this.write(K_CURSOR, state.lastDistilled);
      this.write(K_FAILURES, String(state.consecutiveFailures));
    })();
  }

  /** Seed the cursor from the latest glass-goals op — only if not already set. */
  seedIfUnset(iso: string): boolean {
    if (this.read(K_CURSOR) !== undefined) return false;
    this.write(K_CURSOR, iso);
    return true;
  }
}
