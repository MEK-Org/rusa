import type { IncomingMessage, ServerResponse } from "node:http";
import {
  KI_INTERVAL,
  KP_INTERVAL,
  MIN_DERIVATIVE_DT_SECONDS,
  type QuotaThrottleStatus,
} from "../actor/quota-throttle-controller.js";
import type { ProviderQuotaSnapshot, QuotaLimit } from "../mcp/quota-mcp.js";

/**
 * Server-side cached per-provider quota endpoint for the dashboard header (ISSUE_NUM,
 * backend half). Wraps the existing `get_quota` probe family (claude ISSUE_NUM/ISSUE_NUM,
 * codex ISSUE_NUM/ISSUE_NUM, agy per-group ISSUE_NUM/ISSUE_NUM) — it never probes itself. Every
 * probe goes through `QuotaService.getQuota` (see `../mcp/quota-mcp.js`), which
 * already serves from a TTL cache and dedupes concurrent callers, so a
 * dashboard page load never triggers a live probe; it reads whatever the
 * shared cache last captured (probe interval governed by `QuotaMcpDeps.ttlMs`,
 * 30 minutes by default for claude/codex/agy).
 *
 * kimi is now served via a host-side PTY scrape of the real CLI's `/usage`
 * display. The CLI owns its credentials; this endpoint only maps
 * ProviderQuotaSnapshot.
 */

/** The providers this endpoint can serve when configured by the runtime. */
const SUPPORTED_PROVIDERS = ["claude", "codex", "agy", "kimi"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

/**
 * Fixed duration of a window, keyed by its `id`. Every provider models the
 * same two window shapes today — a 7-day weekly window and a short
 * session/5h window — so this is a simple id switch rather than a per-window
 * config: "weekly" is 7 days, everything else is 5 hours.
 */
function windowMsFor(id: string): number {
  return id === "weekly" ? WEEK_MS : FIVE_HOUR_MS;
}

/** One usage window within a provider (or provider group) — e.g. "session", "weekly", "5h". */
export interface QuotaWindowDto {
  id: string;
  label: string;
  /** 0–100, or null when the underlying probe hasn't produced a reading for this window yet. */
  usedPercent: number | null;
  status: "available" | "exhausted" | "unknown" | "disabled" | "unsupported";
  /**
   * Normalized absolute ISO-8601 instant for reset , when the
   * backend's LLM parse could resolve one or infer one — null when the reset text is
   * ambiguous or relative-only.
   */
  resetAtIso: string | null;
  /**
   * True for the window the frontend should surface as this provider's (or
   * group's) single headline number today. The dashboard's separate "primary
   * tier → main ring" config knob (frontend follow-up) is independent of this
   * flag — `headline` just marks the best default per-indicator number.
   */
  headline: boolean;
  /**
   * Fixed duration of this window in milliseconds (weekly = 7d, session/5h =
   * 5h). Lets the frontend compute how far through the window `resetAt` is
   * without needing to know each provider's window length itself.
   */
  windowMs: number;
  /**
   * ISO-8601 instant the underlying provider was actually scraped (ISSUE_NUM, ask
   * 5) — stamped once at probe time in `ProviderQuotaSnapshot.scrapedAt` and
   * passed through unchanged here, including on cache hits. Null when the
   * state behind this window never reached a probe (kimi, or an
   * error/unsupported state) rather than a fetch/render time.
   */
  scrapedAt: string | null;
}

export interface ProviderQuotaDto {
  provider: SupportedProvider;
  status: "available" | "exhausted" | "unknown" | "unsupported";
  /** Headline used% for this provider's single indicator (mirrors the headline window's). */
  usedPercent: number | null;
  tier: string | null;
  message: string | null;
  /** Flat provider quota windows. */
  windows: QuotaWindowDto[];
  /** Same `scrapedAt` pass-through as `QuotaWindowDto`, mirrored at the provider level. */
  scrapedAt: string | null;
  /** Latest closed-loop throttle decision, or null when quota throttling is disabled/unavailable. */
  throttle: QuotaThrottleStatus | null;
}

export interface QuotaHistoryPointDto {
  /** The real PTY scrape instant, not the dashboard fetch time. */
  observedAt: string;
  /** 0–100 quota remaining. This intentionally falls as quota is consumed. */
  remainingPercent: number;
  /**
   * Pace controller error (remainingPercent - timeRemainingPct) in percentage points,
   * centered at 0. Positive = surplus quota / additional quota to burn, negative = underwater / burning fast.
   * Null when resetAtIso is unavailable for this reading.
   */
  error?: number | null;
  /** Normalized absolute ISO-8601 instant for reset, when available. */
  resetAtIso?: string | null;
  /** Inferred throttle interval at this instant */
  intervalSeconds?: number | null;
}

export interface QuotaHistorySeriesDto {
  provider: SupportedProvider;
  windowId: string;
  label: string;
  points: QuotaHistoryPointDto[];
}

export interface QuotaSnapshotDto {
  generatedAt: string;
  /** Inclusive lower bound for the quota history returned with this snapshot. */
  historySince: string;
  providers: ProviderQuotaDto[];
  /** Durable real-scrape readings from the prior 3 days, grouped by quota pool. */
  history: QuotaHistorySeriesDto[];
}

export interface QuotaHistorySource {
  scrapedAt: string;
  inferredParsedState: ProviderQuotaSnapshot | null;
}

export interface PersistedQuotaHistorySource {
  bucketKey: string;
  kind: string;
  label: string;
  observedAt: string;
  percentLeft: number;
  resetAtIso: string | null;
  controllerError: number | null;
  intervalSeconds: number | null;
}

export interface QuotaHistoryWindowSelection {
  windowId: string;
  label: string;
  /** Stable identity for one logical pool across independently parsed scrapes. */
  poolKey: string;
}

/** Injected by the wiring that owns the shared `QuotaService` cache. */
export interface QuotaApiDeps {
  getQuota: (provider: SupportedProvider) => Promise<ProviderQuotaSnapshot>;
  /**
   * Providers configured for this instance, in display order. Omitting this is
   * backwards-compatible for non-runtime callers and exposes every supported
   * provider.
   */
  providers?: readonly SupportedProvider[];
  /** Read-only latest controller decision from the runtime wiring. */
  getThrottle?: (provider: SupportedProvider) => QuotaThrottleStatus | null;
  /** Durable quota scrape history. Absent in standalone/UI-only deployments. */
  listHistory?: (provider: SupportedProvider, sinceIso: string) => readonly QuotaHistorySource[];
  /** Canonical quota evidence joined to the controller decisions actually persisted at scrape time. */
  listPersistedHistory?: (
    provider: SupportedProvider,
    sinceIso: string
  ) => readonly PersistedQuotaHistorySource[];
  /** Wall-clock timestamp source, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function windowIdentity(kind?: string): { id: string; isWeekly: boolean } {
  const id = kind ?? "other";
  const isWeekly = id === "weekly";
  return { id, isWeekly };
}

function claudeWindows(state: ProviderQuotaSnapshot): QuotaWindowDto[] {
  const scrapedAt = state.scrapedAt ?? null;
  if (state.limits && state.limits.length > 0) {
    return state.limits.map((limit) => {
      // ISSUE_NUM: key off the LLM-classified `kind`, never the free-text `label`
      // — label wording varies run to run (e.g. "Current session" vs
      // "Session"), which broke the dashboard's fixed-id ring lookup
      // (kDefaultQuotaProviders). Mirrors agyGroups' `id: limit.kind` below.
      const { id, isWeekly } = windowIdentity(limit.kind);
      return {
        id,
        label: limit.label,
        usedPercent: 100 - limit.percentLeft,
        status: limit.percentLeft <= 0 ? "exhausted" : "available",
        resetAtIso: limit.resetAtIso ?? null,
        headline: isWeekly,
        windowMs: windowMsFor(id),
        scrapedAt,
      };
    });
  }

  // No structured limits — the snapshot no longer carries top-level headline
  // fields, so there is nothing to synthesize a fallback window from.
  return [];
}

function codexWindows(state: ProviderQuotaSnapshot): QuotaWindowDto[] {
  const scrapedAt = state.scrapedAt ?? null;
  if (state.limits && state.limits.length > 0) {
    return state.limits.map((limit) => {
      // ISSUE_NUM: see claudeWindows above — key off `kind`, not label.
      const { id, isWeekly } = windowIdentity(limit.kind);
      return {
        id,
        label: limit.label,
        usedPercent: 100 - limit.percentLeft,
        status: limit.percentLeft <= 0 ? "exhausted" : "available",
        resetAtIso: limit.resetAtIso ?? null,
        headline: isWeekly,
        windowMs: windowMsFor(id),
        scrapedAt,
      };
    });
  }
  // No structured limits (e.g. exhausted banner or unknown state) — the
  // snapshot no longer carries top-level headline fields, so there is nothing
  // to synthesize a fallback window from.
  return [];
}

function agyWindows(state: ProviderQuotaSnapshot): QuotaWindowDto[] {
  if (!state.limits) return [];
  const scrapedAt = state.scrapedAt ?? null;
  return state.limits
    .filter((limit) => limit.scope === "provider")
    .map((limit) => ({
      id: limit.kind ?? "other",
      label: limit.label,
      usedPercent: 100 - limit.percentLeft,
      status: limit.percentLeft <= 0 ? "exhausted" : "available",
      resetAtIso: limit.resetAtIso ?? null,
      headline: limit.kind === "weekly",
      windowMs: windowMsFor(limit.kind ?? "other"),
      scrapedAt,
    }));
}

function kimiWindows(state: ProviderQuotaSnapshot): QuotaWindowDto[] {
  if (state.limits && state.limits.length > 0) {
    return state.limits.map((limit) => {
      // ISSUE_NUM: see claudeWindows above — key off `kind`, not label.
      const { id, isWeekly } = windowIdentity(limit.kind);
      return {
        id,
        label: limit.label,
        usedPercent: 100 - limit.percentLeft,
        status: limit.percentLeft <= 0 ? "exhausted" : "available",
        resetAtIso: limit.resetAtIso ?? null,
        headline: isWeekly,
        windowMs: windowMsFor(id),
        // kimi's pty probe never stamps scrapedAt → always null (ISSUE_NUM ask 5).
        scrapedAt: state.scrapedAt ?? null,
      };
    });
  }

  // No structured limits — the snapshot no longer carries top-level headline
  // fields, so there is nothing to synthesize a fallback window from.
  return [];
}

function toProviderDto(
  provider: SupportedProvider,
  state: ProviderQuotaSnapshot,
  throttle: QuotaThrottleStatus | null
): ProviderQuotaDto {
  const windows = windowsForProvider(provider, state);
  const headlineWindow = windows.find((w) => w.headline);

  // The provider-level headline number mirrors the headline window's reading.
  // When there is no headline window (no structured limits), there is no
  // headline number — the snapshot no longer carries a top-level usedPercent.
  const usedPercent = headlineWindow ? headlineWindow.usedPercent : null;

  return {
    provider,
    status: state.status,
    usedPercent,
    // The snapshot no longer carries a subscription tier; the DTO field stays
    // (the dashboard model parses it as nullable) but is always null.
    tier: null,
    message: state.message ?? null,
    windows,
    scrapedAt: state.scrapedAt ?? null,
    throttle,
  };
}

const HISTORY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

function windowsForProvider(
  provider: SupportedProvider,
  state: ProviderQuotaSnapshot
): QuotaWindowDto[] {
  return provider === "claude"
    ? claudeWindows(state)
    : provider === "codex"
      ? codexWindows(state)
      : provider === "kimi"
        ? kimiWindows(state)
        : agyWindows(state);
}

function normalizePoolLabel(label: string): string {
  return label.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

/**
 * Identity carried by the persisted parsed JSON already: normalized window
 * kind + scope + source label. Reset text and percentages deliberately do not
 * participate because they change within one pool.
 */
function quotaPoolKey(limit: QuotaLimit): string {
  return [
    limit.kind ?? "other",
    limit.scope ?? "unspecified",
    normalizePoolLabel(limit.label),
  ].join("\u0000");
}

function historyWindowsForProvider(
  provider: SupportedProvider,
  state: ProviderQuotaSnapshot
): Array<{ window: QuotaWindowDto; poolKey: string }> {
  const limits =
    provider === "agy"
      ? (state.limits ?? []).filter((limit) => limit.scope === "provider")
      : (state.limits ?? []);
  const windows = windowsForProvider(provider, state);
  return windows.flatMap((window, index) => {
    const limit = limits[index];
    return limit ? [{ window, poolKey: quotaPoolKey(limit) }] : [];
  });
}

function selectWeeklyPool(
  provider: SupportedProvider,
  state: ProviderQuotaSnapshot
): QuotaHistoryWindowSelection | undefined {
  const selected = historyWindowsForProvider(provider, state).find(
    ({ window }) => window.id === "weekly"
  );
  return selected
    ? {
        windowId: selected.window.id,
        label: selected.window.label,
        poolKey: selected.poolKey,
      }
    : undefined;
}

function latestHistoricalWeeklyPool(
  provider: SupportedProvider,
  scrapes: readonly QuotaHistorySource[],
  sinceIso: string,
  untilIso: string
): QuotaHistoryWindowSelection | undefined {
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  const newestFirst = [...scrapes].sort(
    (a, b) => Date.parse(b.scrapedAt) - Date.parse(a.scrapedAt)
  );
  for (const scrape of newestFirst) {
    const observedMs = Date.parse(scrape.scrapedAt);
    if (
      !scrape.inferredParsedState ||
      !Number.isFinite(observedMs) ||
      observedMs < sinceMs ||
      observedMs > untilMs
    ) {
      continue;
    }
    const selection = selectWeeklyPool(provider, scrape.inferredParsedState);
    if (selection) return selection;
  }
  return undefined;
}

/**
 * Convert durable parsed scrapes into one remaining-quota line for the selected
 * logical pool. The discriminator is derived from fields already persisted in
 * inferred_parsed_state, so changing parse order or temporarily omitting another weekly
 * pool cannot splice unrelated readings into this series.
 */
export function buildQuotaHistory(
  provider: SupportedProvider,
  scrapes: readonly QuotaHistorySource[],
  sinceIso: string,
  untilIso: string,
  selection: QuotaHistoryWindowSelection
): QuotaHistorySeriesDto[] {
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  const pointsByInstant = new Map<string, QuotaHistoryPointDto>();

  const chronological = [...scrapes].sort(
    (a, b) => Date.parse(a.scrapedAt) - Date.parse(b.scrapedAt)
  );

  let bucketInterval = 0;
  let lastResetMs = -1;
  let prevMs = -1;
  let prevError = 0;

  for (const scrape of chronological) {
    const observedMs = Date.parse(scrape.scrapedAt);
    if (
      !scrape.inferredParsedState ||
      !Number.isFinite(observedMs) ||
      observedMs < sinceMs ||
      observedMs > untilMs
    ) {
      continue;
    }
    const selected = historyWindowsForProvider(provider, scrape.inferredParsedState).find(
      (candidate) =>
        candidate.window.id === selection.windowId && candidate.poolKey === selection.poolKey
    );
    const window = selected?.window;
    if (!window || window.usedPercent === null || !Number.isFinite(window.usedPercent)) continue;
    const remainingPercent = Math.min(100, Math.max(0, 100 - window.usedPercent));
    let error: number | null = null;
    let intervalSeconds: number | null = null;
    const resetAtIso = window.resetAtIso ?? null;
    if (resetAtIso && window.windowMs > 0) {
      const resetMs = Date.parse(resetAtIso);
      if (Number.isFinite(resetMs)) {
        const timeRemainingPct = Math.min(
          100,
          Math.max(0, ((resetMs - observedMs) / window.windowMs) * 100)
        );
        // Dashboard error: positive = surplus
        error = remainingPercent - timeRemainingPct;

        // Controller error: positive = hot
        const controllerError = timeRemainingPct - remainingPercent;

        if (Math.abs(resetMs - lastResetMs) > 60 * 60 * 1000) {
          bucketInterval = 0;
          prevMs = observedMs;
          prevError = controllerError;
          lastResetMs = resetMs;
        }

        const dtSeconds = (observedMs - prevMs) / 1000;
        if (dtSeconds >= MIN_DERIVATIVE_DT_SECONDS) {
          const deltaError = controllerError - prevError;
          const pTerm = KP_INTERVAL * deltaError;
          const iTerm = KI_INTERVAL * controllerError * Math.abs(controllerError) * dtSeconds;

          bucketInterval = Math.max(0, bucketInterval + pTerm + iTerm);
          prevMs = observedMs;
          prevError = controllerError;
        }
        if (remainingPercent <= 0) {
          intervalSeconds = null;
        } else {
          intervalSeconds = bucketInterval;
        }
      }
    }
    pointsByInstant.set(scrape.scrapedAt, {
      observedAt: scrape.scrapedAt,
      remainingPercent,
      error,
      resetAtIso,
      intervalSeconds,
    });
  }

  if (pointsByInstant.size === 0) return [];
  return [
    {
      provider,
      windowId: selection.windowId,
      label: selection.label,
      points: [...pointsByInstant.values()].sort(
        (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)
      ),
    },
  ];
}

/** Build dashboard history without replaying or re-implementing the controller. */
export function buildPersistedQuotaHistory(
  provider: SupportedProvider,
  history: readonly PersistedQuotaHistorySource[],
  sinceIso: string,
  untilIso: string
): QuotaHistorySeriesDto[] {
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  const weekly = history.filter((point) => {
    const observedMs = Date.parse(point.observedAt);
    return (
      point.kind === "weekly" &&
      Number.isFinite(observedMs) &&
      observedMs >= sinceMs &&
      observedMs <= untilMs
    );
  });
  if (weekly.length === 0) return [];
  const latest = weekly.at(-1);
  return [
    {
      provider,
      windowId: "weekly",
      label: latest?.label ?? "Weekly",
      points: weekly.map((point) => ({
        observedAt: point.observedAt,
        remainingPercent: point.percentLeft,
        // The public chart convention is positive = quota surplus; persisted
        // controller error is positive = consuming too fast.
        error: point.controllerError === null ? null : -point.controllerError,
        resetAtIso: point.resetAtIso,
        intervalSeconds: point.intervalSeconds,
      })),
    },
  ];
}

/** Build the current quota snapshot from the shared cache for configured providers. */
export async function buildQuotaSnapshot(deps: QuotaApiDeps): Promise<QuotaSnapshotDto> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const generatedAt = toIso(nowMs);
  const historySince = toIso(nowMs - HISTORY_WINDOW_MS);
  const providers = deps.providers ?? SUPPORTED_PROVIDERS;
  const states = await Promise.all(providers.map((provider) => deps.getQuota(provider)));
  const providerDtos = providers.map((provider, i) => {
    let state = states[i];
    if (state.status === "unknown" || !state.limits || state.limits.length === 0) {
      if (deps.listHistory) {
        const historicalRows = deps.listHistory(provider, historySince);
        const newestFirst = [...historicalRows].sort(
          (a, b) => Date.parse(b.scrapedAt) - Date.parse(a.scrapedAt)
        );
        const MAX_HOLD_MS = 24 * 60 * 60 * 1000;
        for (const row of newestFirst) {
          const ageMs = nowMs - Date.parse(row.scrapedAt);
          if (ageMs > MAX_HOLD_MS) continue;
          if (
            row.inferredParsedState &&
            row.inferredParsedState.status !== "unknown" &&
            row.inferredParsedState.limits &&
            row.inferredParsedState.limits.length > 0
          ) {
            state = { ...row.inferredParsedState, scrapedAt: row.scrapedAt };
            break;
          }
        }
      }
    }
    return toProviderDto(provider, state, deps.getThrottle?.(provider) ?? null);
  });
  return {
    generatedAt,
    historySince,
    providers: providerDtos,
    history: deps.listPersistedHistory
      ? providers.flatMap((provider) =>
          buildPersistedQuotaHistory(
            provider,
            deps.listPersistedHistory?.(provider, historySince) ?? [],
            historySince,
            generatedAt
          )
        )
      : deps.listHistory
        ? providers.flatMap((provider, i) => {
            const historicalRows = deps.listHistory?.(provider, historySince) ?? [];
            // Prefer the current ring's first weekly pool. If the current probe
            // has no usable limits, freeze selection from the newest valid
            // durable row so known history is not misreported as absent.
            const weeklyPool =
              selectWeeklyPool(provider, states[i]) ??
              latestHistoricalWeeklyPool(provider, historicalRows, historySince, generatedAt);
            return weeklyPool
              ? buildQuotaHistory(provider, historicalRows, historySince, generatedAt, weeklyPool)
              : [];
          })
        : [],
  };
}

const PATH = "/api/quota";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Dispatch `GET /api/quota` — the dashboard's cached per-provider quota
 * snapshot. Returns true if it owned the request, false to fall through.
 * `deps` absent (e.g. no live QuotaService bound) → 503, static UI unaffected.
 */
export async function handleQuotaApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: QuotaApiDeps | null
): Promise<boolean> {
  if (url.pathname !== PATH) return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }
  if (!deps) {
    sendJson(res, 503, {
      error: "quota API unavailable (no QuotaService bound)",
    });
    return true;
  }
  try {
    const snapshot = await buildQuotaSnapshot(deps);
    sendJson(res, 200, snapshot);
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
