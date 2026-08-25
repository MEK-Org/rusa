/**
 * The A/B rig's own before/after quota readings, and the burn between them (an issue).
 *
 * ## What this replaces
 * `ab-report.json.quota` used to be a literal instruction string:
 *
 * ```ts
 * quota: { note: "capture via get_quota MCP before/after; batched delta is the burn" },
 * ```
 *
 * No run has ever recorded its own. So when `g2v3c` died on a 403 at provider run 10 of 10,
 * the report could not say what the window looked like at launch or at death, and the only
 * reason anyone knows the burn was 5h `0% → 100%` is that a human happened to be scraping
 * the panel by hand on either side. The `/usage` panel is not queryable after the fact:
 * a reading not taken at the time is gone permanently.
 *
 * ## Two properties this module is built around
 *
 * **1. A capture never fails the run.** {@link captureQuota} does not throw — every path
 * returns a {@link QuotaCapture} that says what happened, including "the probe threw" and
 * "this provider cannot be probed at all". The whole point is the failure path: a run that
 * dies is precisely the run whose window reading matters, and a capture that propagated its
 * own error would take the evidence down with the run.
 *
 * **2. "Could not read" is a state, not a zero.** `status: "unknown"` is what the kimi probe
 * returns from a worker plane whose OAuth refresh lock is read-only , and it is what
 * any screen-scrape returns when it could not see. A burn computed against an unreadable
 * side would be a number measuring nothing — this arc's recurring failure — so
 * {@link diffQuota} refuses, with the reason attached, rather than producing one.
 *
 * ## The cache trap, stated because it nearly landed
 * `QuotaService.getQuota` is TTL-cached: 5 minutes for claude/agy/kimi and **30 minutes for
 * codex**. A short A/B run finishes well inside the codex TTL, so a naive before/after
 * through one shared service returns the SAME snapshot twice and computes a burn of exactly
 * `0` — a green-looking measurement of nothing at all. Two defences, because one of them is
 * a configuration a caller can get wrong:
 *
 * - the driver builds its capture service with `ttlMs: 0` so every capture is a real probe;
 * - {@link diffQuota} compares the two readings' `scrapedAt` stamps and REFUSES when they
 *   are identical, because that is the cache serving the launch reading at exit.
 *
 * The second one is the load-bearing one: it detects the mistake instead of trusting that
 * nobody made it.
 */

import type { ProviderQuotaSnapshot, QuotaWindowKind } from "../mcp/quota-mcp.js";

/** Providers `QuotaService.getQuota` accepts. Anything else is honestly not-probeable. */
export const PROBEABLE_PROVIDERS = ["claude", "codex", "agy", "kimi"] as const;

export type ProbeableProvider = (typeof PROBEABLE_PROVIDERS)[number];

export function isProbeableProvider(provider: string): provider is ProbeableProvider {
  return (PROBEABLE_PROVIDERS as readonly string[]).includes(provider);
}

/** Which end of the run a reading belongs to. */
export type QuotaPhase = "launch" | "exit";

export type QuotaReadOutcome =
  /** The probe answered with at least one usable window. */
  | "read"
  /** The probe answered, but with no numbers — e.g. `status: "unknown"` . */
  | "unreadable"
  /** The probe threw. Recorded, never rethrown. */
  | "probe-failed"
  /** The run's provider is not one `get_quota` knows how to probe. */
  | "not-probeable";

/** One window's reading, flattened out of {@link ProviderQuotaSnapshot.limits}. */
export interface QuotaWindowReading {
  label: string;
  kind: QuotaWindowKind | null;
  /** Percentage of the window still AVAILABLE, as the provider reports it. */
  percentLeft: number | null;
}

export interface QuotaCapture {
  phase: QuotaPhase;
  provider: string;
  /** When the driver asked — stamped even when nothing came back. */
  requestedAt: string;
  outcome: QuotaReadOutcome;
  /**
   * When the PROBE says it actually scraped the provider, when it says at all. Distinct
   * from {@link requestedAt} on purpose: it is what {@link diffQuota} uses to tell a fresh
   * exit reading from the launch reading served back out of the TTL cache.
   */
  scrapedAt: string | null;
  /** The provider's own status verbatim (`available` / `exhausted` / `unknown` / …). */
  status: string | null;
  windows: QuotaWindowReading[];
  /** What was seen — the sentence a reader gets when there are no numbers. */
  message: string;
}

/** Per-window burn between two captures. */
export interface QuotaWindowDelta {
  label: string;
  kind: QuotaWindowKind | null;
  beforePercentLeft: number | null;
  afterPercentLeft: number | null;
  /**
   * Percentage points CONSUMED between the two readings (`before - after`), or null when
   * one side is missing this window. Negative means the window RESET mid-run, which is not
   * a burn and must not be averaged into one — see the note.
   */
  consumedPoints: number | null;
  /** Why `consumedPoints` is null or untrustworthy. Null when the delta is plain. */
  note: string | null;
}

export type QuotaBurn =
  | { computed: true; windows: QuotaWindowDelta[]; message: string }
  | { computed: false; windows: QuotaWindowDelta[]; reason: string; message: string };

/** What lands in `ab-report.json.quota`, and in `quota.json` when the run dies. */
export interface QuotaEvidence {
  provider: string;
  launch: QuotaCapture | null;
  exit: QuotaCapture | null;
  burn: QuotaBurn;
  /** How the run ended, when it ended badly — the reason the exit reading matters. */
  runError: string | null;
}

export interface CaptureQuotaDeps {
  /**
   * Reads one provider's quota. Returns the snapshot verbatim; may throw — the caller
   * records the throw rather than propagating it.
   */
  readQuota: (provider: ProbeableProvider) => Promise<ProviderQuotaSnapshot>;
  /** Wall clock, injectable for tests. */
  now?: () => Date;
}

function windowsOf(snapshot: ProviderQuotaSnapshot): QuotaWindowReading[] {
  return (snapshot.limits ?? []).map((limit) => ({
    label: limit.label,
    kind: limit.kind ?? null,
    percentLeft: typeof limit.percentLeft === "number" ? limit.percentLeft : null,
  }));
}

/**
 * Take one reading. Never throws.
 *
 * A caller that wraps this in a try/catch has misunderstood it: the error path is a
 * RESULT here, because the run this measures may be dying while it runs.
 */
export async function captureQuota(
  phase: QuotaPhase,
  provider: string,
  deps: CaptureQuotaDeps
): Promise<QuotaCapture> {
  const now = deps.now ?? (() => new Date());
  const requestedAt = now().toISOString();
  const base = { phase, provider, requestedAt } as const;

  if (!isProbeableProvider(provider)) {
    return {
      ...base,
      outcome: "not-probeable",
      scrapedAt: null,
      status: null,
      windows: [],
      message:
        `${provider} is not a provider get_quota can probe ` +
        `(probeable: ${PROBEABLE_PROVIDERS.join(", ")}) — no reading taken, and none is ` +
        `implied. This is NOT CAPTURED, not zero burn.`,
    };
  }

  let snapshot: ProviderQuotaSnapshot;
  try {
    snapshot = await deps.readQuota(provider);
  } catch (err) {
    return {
      ...base,
      outcome: "probe-failed",
      scrapedAt: null,
      status: null,
      windows: [],
      message:
        `quota probe threw at ${phase}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Recorded rather than raised — a capture must never be the thing that ends the run.`,
    };
  }

  const windows = windowsOf(snapshot);
  const usable = windows.filter((w) => w.percentLeft !== null);
  const scrapedAt = snapshot.scrapedAt ?? null;
  const status = snapshot.status ?? null;

  if (usable.length === 0) {
    return {
      ...base,
      outcome: "unreadable",
      scrapedAt,
      status,
      windows,
      message:
        `quota UNREADABLE at ${phase} — probe returned status "${status ?? "none"}" with no ` +
        `numbered window${snapshot.message ? `: ${snapshot.message}` : "."} ` +
        `This is what the run saw; it is not a reading of zero.`,
    };
  }

  return {
    ...base,
    outcome: "read",
    scrapedAt,
    status,
    windows,
    message: `quota read at ${phase} — ${usable
      .map((w) => `${w.label} ${w.percentLeft}% left`)
      .join(", ")}`,
  };
}

/**
 * Key a window is matched on across the two readings.
 *
 * `kind` first because it is the normalized classification the whole DTO layer keys off,
 * and `label` is free text the provider TUI is free to reword between two scrapes 25
 * minutes apart. Falling back to `label` keeps an unclassified window comparable to itself
 * rather than dropping it.
 */
function windowKey(w: QuotaWindowReading): string {
  return w.kind ?? w.label;
}

function pairWindows(
  before: QuotaWindowReading[],
  after: QuotaWindowReading[]
): QuotaWindowDelta[] {
  const seen: string[] = [];
  const keys: string[] = [];
  for (const w of [...before, ...after]) {
    const key = windowKey(w);
    if (!seen.includes(key)) {
      seen.push(key);
      keys.push(key);
    }
  }

  return keys.map((key) => {
    const b = before.find((w) => windowKey(w) === key) ?? null;
    const a = after.find((w) => windowKey(w) === key) ?? null;
    const beforePercentLeft = b?.percentLeft ?? null;
    const afterPercentLeft = a?.percentLeft ?? null;

    if (beforePercentLeft === null || afterPercentLeft === null) {
      // Emitted rather than dropped: a window present on one side only is a fact about the
      // run, and a list that silently omits it makes "not captured" look like "not there".
      const missing = beforePercentLeft === null ? "launch" : "exit";
      return {
        label: a?.label ?? b?.label ?? key,
        kind: a?.kind ?? b?.kind ?? null,
        beforePercentLeft,
        afterPercentLeft,
        consumedPoints: null,
        note: `no numbered reading for this window at ${missing} — burn NOT CAPTURED for it`,
      };
    }

    const consumedPoints = beforePercentLeft - afterPercentLeft;
    return {
      label: a?.label ?? b?.label ?? key,
      kind: a?.kind ?? b?.kind ?? null,
      beforePercentLeft,
      afterPercentLeft,
      consumedPoints,
      note:
        consumedPoints < 0
          ? "window has MORE left at exit than at launch — it reset mid-run, so this is " +
            "not a burn figure and must not be read as one"
          : null,
    };
  });
}

function refuse(reason: string, windows: QuotaWindowDelta[] = []): QuotaBurn {
  return {
    computed: false,
    // Both raw sides are kept, but every subtraction is stripped. On the cache-hit path the
    // arithmetic would otherwise be a clean `0` sitting in the artifact next to a refusal,
    // and a reader — or a scorer — that finds a number will use it.
    windows: windows.map((w) => ({
      ...w,
      consumedPoints: null,
      note: w.note ?? `not computed — ${reason}`,
    })),
    reason,
    message: `burn NOT COMPUTED — ${reason}. The readings above are what the run saw; do not infer a burn from them.`,
  };
}

/**
 * The burn between two captures, or an explicit refusal with its reason.
 *
 * There is deliberately no third option where it returns zeroes. A `0` in this field has
 * to mean "measured, and nothing was consumed" — if it can also mean "we couldn't tell",
 * the field is worse than absent, because it reads like a measurement.
 */
export function diffQuota(before: QuotaCapture | null, after: QuotaCapture | null): QuotaBurn {
  if (!before && !after) return refuse("neither end of the run took a reading");
  if (!before) return refuse("no launch reading was taken");
  if (!after) return refuse("no exit reading was taken — the run ended before one could be");

  if (before.outcome !== "read" || after.outcome !== "read") {
    const bad = [
      before.outcome !== "read" ? `launch=${before.outcome}` : null,
      after.outcome !== "read" ? `exit=${after.outcome}` : null,
    ].filter((s): s is string => s !== null);
    return refuse(
      `a reading is missing numbers (${bad.join(", ")}) — "${before.outcome === "read" ? after.message : before.message}"`,
      pairWindows(before.windows, after.windows)
    );
  }

  // The cache trap. Identical scrape stamps mean the exit call was served the launch
  // reading out of the TTL cache and no second probe ever ran, which would otherwise
  // compute a perfect, entirely fictional burn of 0.
  if (before.scrapedAt !== null && before.scrapedAt === after.scrapedAt) {
    return refuse(
      `both readings carry the same scrapedAt (${before.scrapedAt}) — the exit reading is ` +
        `the launch reading served from the quota TTL cache, not a second probe`,
      pairWindows(before.windows, after.windows)
    );
  }

  const windows = pairWindows(before.windows, after.windows);
  const measured = windows.filter((w) => w.consumedPoints !== null);
  if (measured.length === 0) {
    return refuse("no window has a numbered reading at BOTH ends", windows);
  }

  return {
    computed: true,
    windows,
    message: `burn — ${measured
      .map(
        (w) =>
          `${w.label} ${w.beforePercentLeft}% → ${w.afterPercentLeft}% left (${w.consumedPoints} pts)`
      )
      .join(", ")}`,
  };
}

/** Assemble the field that lands in the report, and in `quota.json` when the run dies. */
export function quotaEvidence(opts: {
  provider: string;
  launch: QuotaCapture | null;
  exit: QuotaCapture | null;
  runError: string | null;
}): QuotaEvidence {
  return {
    provider: opts.provider,
    launch: opts.launch,
    exit: opts.exit,
    burn: diffQuota(opts.launch, opts.exit),
    runError: opts.runError,
  };
}
