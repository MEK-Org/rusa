import type { IncomingMessage, ServerResponse } from "node:http";
import type { QuotaThrottleStatus } from "../actor/quota-throttle-status.js";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";

/**
 * Server-side cached per-provider quota endpoint for the dashboard header (ISSUE_NUM,
 * backend half). Wraps the existing `get_quota` probe family (claude ISSUE_NUM/ISSUE_NUM,
 * codex ISSUE_NUM/ISSUE_NUM, agy per-group ISSUE_NUM/ISSUE_NUM) — it never probes itself. The
 * wiring binds `getQuota` to `QuotaService.getQuotaCached` (see
 * `../mcp/quota-mcp.js`), which serves the latest known reading from the shared
 * TTL cache immediately and kicks any needed refresh in the background — so a
 * dashboard page load never triggers-and-awaits a live PTY probe in the request
 * path (issue #10). On a cold cache (e.g. just after a process restart) the
 * cache read returns an `unknown` state and `buildQuotaSnapshot` falls back to
 * the newest durable rows via `listHistory` (observations up to 24h old, see
 * `MAX_HOLD_MS` in `latestStateFromHistory`), so the header still shows the last
 * real reading rather than dimming for the full probe latency.
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
  /**
   * True if this window's assessment or reset was carried forward from a previous scrape
   * rather than freshly observed in the latest probe.
   */
  carriedForward?: boolean;
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
  scope: "provider" | "model";
  kind: string;
  label: string;
  observedAt: string;
  percentLeft: number;
  resetAtIso: string | null;
  controllerError: number | null;
  intervalSeconds: number | null;
}

/** Injected by the wiring that owns the shared `QuotaService` cache. */
export interface QuotaApiDeps {
  /**
   * Returns the latest known quota reading immediately from the shared cache and
   * kicks any refresh in the background — it must NOT trigger-and-await a live
   * PTY probe in the request path (issue #10). Production binds this to
   * `QuotaService.getQuotaCached`. The `Promise` return is a resolved-value
   * convenience for `buildQuotaSnapshot`'s `Promise.all`, not an await on I/O.
   */
  getQuota: (provider: SupportedProvider) => Promise<ProviderQuotaSnapshot>;
  /**
   * Providers configured for this instance, in display order. Omitting this is
   * backwards-compatible for non-runtime callers and exposes every supported
   * provider.
   */
  providers?: readonly SupportedProvider[];
  /** Read-only latest controller decision from the runtime wiring. */
  getThrottle?: (provider: SupportedProvider) => QuotaThrottleStatus | null;
  /** Canonical quota evidence joined to the controller decision persisted for that observation. */
  listHistory?: (provider: SupportedProvider, sinceIso: string) => readonly QuotaHistorySource[];
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
        ...(limit.carriedForward ? { carriedForward: true } : {}),
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
        ...(limit.carriedForward ? { carriedForward: true } : {}),
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
      ...(limit.carriedForward ? { carriedForward: true } : {}),
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
        ...(limit.carriedForward ? { carriedForward: true } : {}),
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

/** Build dashboard history without replaying or re-implementing the controller. */
export function buildQuotaHistory(
  provider: SupportedProvider,
  history: readonly QuotaHistorySource[],
  sinceIso: string,
  untilIso: string
): QuotaHistorySeriesDto[] {
  const sinceMs = Date.parse(sinceIso);
  const untilMs = Date.parse(untilIso);
  const weekly = history
    .filter((point) => {
      const observedMs = Date.parse(point.observedAt);
      return (
        point.scope === "provider" &&
        point.kind === "weekly" &&
        Number.isFinite(observedMs) &&
        observedMs >= sinceMs &&
        observedMs <= untilMs
      );
    })
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
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

function latestStateFromHistory(
  provider: SupportedProvider,
  history: readonly QuotaHistorySource[],
  nowMs: number
): ProviderQuotaSnapshot | null {
  const MAX_HOLD_MS = 24 * 60 * 60 * 1000;
  const eligible = history.filter((point) => {
    const observedMs = Date.parse(point.observedAt);
    const ageMs = nowMs - observedMs;
    return Number.isFinite(observedMs) && ageMs >= 0 && ageMs <= MAX_HOLD_MS;
  });
  const latestObservedAt = eligible
    .map((point) => point.observedAt)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (!latestObservedAt) return null;
  const latest = eligible.filter((point) => point.observedAt === latestObservedAt);
  return {
    provider,
    status: latest.some((point) => point.percentLeft <= 0) ? "exhausted" : "available",
    scrapedAt: latestObservedAt,
    limits: latest.map((point) => ({
      label: point.label,
      kind: point.kind as "session" | "five_hour" | "weekly" | "other",
      scope: point.scope,
      percentLeft: point.percentLeft,
      resetAtIso: point.resetAtIso ?? undefined,
    })),
  };
}

/** Build the current quota snapshot from the shared cache for configured providers. */
export async function buildQuotaSnapshot(deps: QuotaApiDeps): Promise<QuotaSnapshotDto> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const generatedAt = toIso(nowMs);
  const historySince = toIso(nowMs - HISTORY_WINDOW_MS);
  const providers = deps.providers ?? SUPPORTED_PROVIDERS;
  const states = await Promise.all(providers.map((provider) => deps.getQuota(provider)));
  const histories = providers.map((provider) => deps.listHistory?.(provider, historySince) ?? []);
  const providerDtos = providers.map((provider, i) => {
    let state = states[i];
    if (state.status === "unknown" || !state.limits || state.limits.length === 0) {
      state = latestStateFromHistory(provider, histories[i] ?? [], nowMs) ?? state;
    }
    return toProviderDto(provider, state, deps.getThrottle?.(provider) ?? null);
  });
  return {
    generatedAt,
    historySince,
    providers: providerDtos,
    history: deps.listHistory
      ? providers.flatMap((provider, index) =>
          buildQuotaHistory(provider, histories[index] ?? [], historySince, generatedAt)
        )
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
