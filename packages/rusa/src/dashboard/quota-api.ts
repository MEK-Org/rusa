import type { IncomingMessage, ServerResponse } from "node:http";
import type { QuotaThrottleStatus } from "../actor/quota-throttle-status.js";
import type { ProviderQuotaSnapshot } from "../mcp/quota-mcp.js";
import {
  DEFAULT_STALE_AFTER_MS,
  HISTORY_WINDOW_MS,
  type PublishedHistoryRecord,
} from "../quota/coordinator-protocol.js";
import { estimateLane, type LaneReading, quotaLaneKey } from "../quota/lane-estimate.js";
import { isProviderScopedWindow } from "../quota/window-scope.js";

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
   * error/unsupported state) rather than a fetch/render time. For an
   * `estimated` window this is the last real reading the estimate extends.
   */
  scrapedAt: string | null;
  /**
   * True when `usedPercent` is a read-time estimate rather than a reading
   * (#759): the lane had no fresh reading, so its last real reading is carried
   * forward at the window's observed consumption pace. Computed per request and
   * never persisted or fed back into observations or pacing.
   */
  estimated: boolean;
}

/**
 * A model-scoped window (#752), e.g. Claude's "Current week (Fable)". Carried
 * apart from the provider's own `windows` so no consumer can read a model's
 * allocation as the provider-wide one; `modelIds` is the scope's canonical
 * configured model IDs, never inferred from the display label.
 */
export interface QuotaModelWindowDto extends QuotaWindowDto {
  modelIds: string[];
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
  /** Model-scoped windows with a known model identity, in snapshot order. */
  modelWindows: QuotaModelWindowDto[];
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
  /** Explicit lane identity; never inferred from the display label. */
  scope: "provider" | "model";
  /** Canonical model IDs when [scope] is model; empty for provider rows. */
  modelIds: string[];
  label: string;
  points: QuotaHistoryPointDto[];
}

export interface QuotaSnapshotDto {
  generatedAt: string;
  providers: ProviderQuotaDto[];
}

export interface QuotaHistoryDto {
  generatedAt: string;
  /** Inclusive lower bound for the quota history returned with this snapshot. */
  historySince: string;
  /**
   * Durable real-scrape readings from the prior `HISTORY_WINDOW_MS` (3 days),
   * grouped by quota pool, each series bounded to `MAX_HISTORY_POINTS_PER_SERIES`.
   */
  history: QuotaHistorySeriesDto[];
}

export type QuotaHistorySource = PublishedHistoryRecord;

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
  /**
   * Awaited per provider before `GET /api/quota/history` reads `listHistory`
   * (#707): refills a provider whose history has never been read, or whose last
   * read failed, instead of serving empty history until the next periodic
   * refresh. Must resolve (never reject) within a bounded time.
   */
  readThroughHistory?: (provider: SupportedProvider) => Promise<void>;
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
        estimated: false,
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
        estimated: false,
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
  return state.limits.map((limit) => ({
    id: limit.kind ?? "other",
    label: limit.label,
    usedPercent: 100 - limit.percentLeft,
    status: limit.percentLeft <= 0 ? "exhausted" : "available",
    resetAtIso: limit.resetAtIso ?? null,
    headline: limit.kind === "weekly",
    windowMs: windowMsFor(limit.kind ?? "other"),
    scrapedAt,
    estimated: false,
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
        estimated: false,
      };
    });
  }

  // No structured limits — the snapshot no longer carries top-level headline
  // fields, so there is nothing to synthesize a fallback window from.
  return [];
}

/**
 * The snapshot's model-scoped windows that name their models. A legacy
 * `"model"` row names none, so it cannot be attributed to any model and is
 * dropped here as it is from the provider's own windows.
 */
function modelWindowsFor(state: ProviderQuotaSnapshot): QuotaModelWindowDto[] {
  const scrapedAt = state.scrapedAt ?? null;
  return (state.limits ?? []).flatMap((limit) => {
    const modelIds =
      typeof limit.scope === "object" && limit.scope !== null ? (limit.scope.models ?? []) : [];
    if (modelIds.length === 0) return [];
    const { id, isWeekly } = windowIdentity(limit.kind);
    return [
      {
        id,
        label: limit.label,
        usedPercent: 100 - limit.percentLeft,
        status: limit.percentLeft <= 0 ? "exhausted" : "available",
        resetAtIso: limit.resetAtIso ?? null,
        headline: isWeekly,
        windowMs: windowMsFor(id),
        scrapedAt,
        estimated: false,
        modelIds: [...modelIds],
      },
    ];
  });
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
    modelWindows: modelWindowsFor(state),
    scrapedAt: state.scrapedAt ?? null,
    throttle,
  };
}

export { HISTORY_WINDOW_MS };

/**
 * Most points one history series may carry to the dashboard. Five-minute
 * readings over the 3-day range would be ~865 per series; 672 keeps the bound
 * #708 shipped. It is not a measured response or paint budget.
 */
export const MAX_HISTORY_POINTS_PER_SERIES = 672;

/**
 * Thin a time-ordered series to at most `MAX_HISTORY_POINTS_PER_SERIES` real
 * readings: the newest reading in each equal time bucket of the range.
 * Readings are chosen, never averaged or filled, so an unobserved stretch
 * stays empty and every controller field is the stored one.
 */
function boundHistoryPoints(
  points: readonly QuotaHistorySource[],
  sinceMs: number,
  untilMs: number
): readonly QuotaHistorySource[] {
  if (points.length <= MAX_HISTORY_POINTS_PER_SERIES) return points;
  const lastBucket = MAX_HISTORY_POINTS_PER_SERIES - 1;
  const bucketMs = Math.max(1, (untilMs - sinceMs) / MAX_HISTORY_POINTS_PER_SERIES);
  // The range is inclusive of `untilMs`; a reading exactly there joins the
  // last bucket rather than opening one past the bound.
  const bucketOf = (point: QuotaHistorySource): number =>
    Math.min(lastBucket, Math.floor((Date.parse(point.observedAt) - sinceMs) / bucketMs));
  return points.filter((point, i) => {
    const next = points[i + 1];
    return next === undefined || bucketOf(next) !== bucketOf(point);
  });
}

/**
 * A provider's windows are its provider-scoped ones only, decided by the same
 * `isProviderScopedWindow` rule observation ingestion applies (issue #249). The
 * filter lives here, ahead of the per-provider mappers, so every provider gets
 * one rule: a codex panel that carries a model reserve at 100% left used to hand
 * that row the weekly headline and report the provider as 0% used while its own
 * weekly window was half spent. Model rows are dropped from provider
 * presentation rather than relabelled — the extractor's scope metadata is
 * consumed as-is, and no window is invented or re-scoped here.
 */
function windowsForProvider(
  provider: SupportedProvider,
  state: ProviderQuotaSnapshot
): QuotaWindowDto[] {
  const providerScoped: ProviderQuotaSnapshot = {
    ...state,
    limits: state.limits?.filter(isProviderScopedWindow),
  };
  return provider === "claude"
    ? claudeWindows(providerScoped)
    : provider === "codex"
      ? codexWindows(providerScoped)
      : provider === "kimi"
        ? kimiWindows(providerScoped)
        : agyWindows(providerScoped);
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
        point.kind === "weekly" &&
        (point.scope === "provider" ||
          (point.scope === "model" && point.models !== undefined && point.models.length > 0)) &&
        Number.isFinite(observedMs) &&
        observedMs >= sinceMs &&
        observedMs <= untilMs
      );
    })
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  if (weekly.length === 0) return [];
  const groups = new Map<string, QuotaHistorySource[]>();
  for (const point of weekly) {
    const key =
      point.scope === "provider" ? "provider" : `model:${(point.models ?? []).join("\u0000")}`;
    const group = groups.get(key);
    if (group) group.push(point);
    else groups.set(key, [point]);
  }
  return [...groups.values()].map((group) => {
    const points = boundHistoryPoints(group, sinceMs, untilMs);
    const latest = points.at(-1);
    const scope = latest?.scope ?? "provider";
    return {
      provider,
      windowId: "weekly",
      scope,
      modelIds: scope === "model" ? [...(latest?.models ?? [])] : [],
      label: latest?.label ?? "Weekly",
      points: points.map((point) => ({
        observedAt: point.observedAt,
        remainingPercent: point.percentLeft,
        // The public chart convention is positive = quota surplus; persisted
        // controller error is positive = consuming too fast.
        error: point.controllerError === null ? null : -point.controllerError,
        resetAtIso: point.resetAtIso,
        intervalSeconds: point.intervalSeconds,
      })),
    };
  });
}

const MAX_FALLBACK_HOLD_MS = 24 * 60 * 60 * 1000;

function latestStateFromHistory(
  provider: SupportedProvider,
  history: readonly QuotaHistorySource[],
  nowMs: number
): ProviderQuotaSnapshot | null {
  const eligible = history.filter((point) => {
    const observedMs = Date.parse(point.observedAt);
    const ageMs = nowMs - observedMs;
    return Number.isFinite(observedMs) && ageMs >= 0 && ageMs <= MAX_FALLBACK_HOLD_MS;
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
      // Model rows keep their canonical IDs so the fallback serves the same
      // model windows a live read would (#752).
      scope:
        point.scope === "model" && point.models && point.models.length > 0
          ? { provider, models: [...point.models] }
          : point.scope,
      percentLeft: point.percentLeft,
      resetAtIso: point.resetAtIso ?? undefined,
    })),
  };
}

/**
 * Replace every window without a fresh reading by its read-time estimate
 * (#759), and add a window for each lane the newest reading dropped but whose
 * history can still be dead-reckoned. A window is fresh when it is in the
 * newest reading, that reading is no older than the lane's stale threshold,
 * and its window has not reset. A window with nothing to estimate from keeps
 * what it showed before. Nothing here is written anywhere.
 */
function withEstimates(
  dto: ProviderQuotaDto,
  history: readonly QuotaHistorySource[],
  staleAfterMs: number,
  nowMs: number
): ProviderQuotaDto {
  const lanes = new Map<string, QuotaHistorySource[]>();
  for (const record of history) {
    const key = quotaLaneKey(record.scope, record.models ?? [], record.kind);
    const lane = lanes.get(key);
    if (lane) lane.push(record);
    else lanes.set(key, [record]);
  }
  const estimate = <W extends QuotaWindowDto>(window: W, key: string): W => {
    const scrapedMs = window.scrapedAt === null ? Number.NaN : Date.parse(window.scrapedAt);
    const resetMs = window.resetAtIso === null ? Number.NaN : Date.parse(window.resetAtIso);
    const fresh =
      !Number.isFinite(scrapedMs) ||
      (nowMs - scrapedMs <= staleAfterMs && !(Number.isFinite(resetMs) && resetMs <= nowMs));
    if (fresh) return window;
    const readings: LaneReading[] = [...(lanes.get(key) ?? [])];
    if (window.usedPercent !== null && !readings.some((r) => r.observedAt === window.scrapedAt)) {
      readings.push({
        observedAt: window.scrapedAt as string,
        percentLeft: 100 - window.usedPercent,
        resetAtIso: window.resetAtIso,
      });
    }
    const reckoned = estimateLane(readings, window.windowMs, nowMs);
    if (!reckoned) return window;
    return {
      ...window,
      usedPercent: 100 - reckoned.percentLeft,
      status: reckoned.percentLeft <= 0 ? "exhausted" : "available",
      resetAtIso: reckoned.resetAtIso,
      scrapedAt: reckoned.lastReadingAt,
      estimated: true,
    };
  };
  const dropped = (key: string): QuotaWindowDto | null => {
    const readings = lanes.get(key) ?? [];
    const last = readings.reduce<QuotaHistorySource | undefined>(
      (newest, r) => (!newest || Date.parse(r.observedAt) > Date.parse(newest.observedAt) ? r : newest),
      undefined
    );
    if (!last) return null;
    const window: QuotaWindowDto = {
      id: last.kind,
      label: last.label,
      usedPercent: 100 - last.percentLeft,
      status: last.percentLeft <= 0 ? "exhausted" : "available",
      resetAtIso: last.resetAtIso,
      headline: last.kind === "weekly",
      windowMs: windowMsFor(last.kind),
      scrapedAt: last.observedAt,
      estimated: false,
    };
    const reckoned = estimate(window, key);
    return reckoned.estimated ? reckoned : null;
  };

  const windows = dto.windows.map((w) => estimate(w, quotaLaneKey("provider", [], w.id)));
  const modelWindows = dto.modelWindows.map((w) =>
    estimate(w, quotaLaneKey("model", w.modelIds, w.id))
  );
  const shown = new Set([
    ...windows.map((w) => quotaLaneKey("provider", [], w.id)),
    ...modelWindows.map((w) => quotaLaneKey("model", w.modelIds, w.id)),
  ]);
  for (const [key, readings] of lanes) {
    if (shown.has(key)) continue;
    const window = dropped(key);
    if (!window) continue;
    const models = readings.at(-1)?.models ?? [];
    if (readings[0].scope === "provider") windows.push(window);
    else modelWindows.push({ ...window, modelIds: [...models] });
  }
  const headlineWindow = windows.find((w) => w.headline);
  return {
    ...dto,
    usedPercent: headlineWindow ? headlineWindow.usedPercent : null,
    windows,
    modelWindows,
  };
}

/** Build the current quota snapshot from the shared cache for configured providers. */
export async function buildQuotaSnapshot(deps: QuotaApiDeps): Promise<QuotaSnapshotDto> {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const generatedAt = toIso(nowMs);
  const providers = deps.providers ?? SUPPORTED_PROVIDERS;
  const states = await Promise.all(providers.map((provider) => deps.getQuota(provider)));
  const providerDtos = providers.map((provider, i) => {
    let state = states[i];
    const history = deps.listHistory?.(provider, toIso(nowMs - HISTORY_WINDOW_MS)) ?? [];
    if (state.status === "unknown" || !state.limits || state.limits.length === 0) {
      state = latestStateFromHistory(provider, history, nowMs) ?? state;
    }
    const dto = toProviderDto(provider, state, deps.getThrottle?.(provider) ?? null);
    const staleAfterMs = state.freshness?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    return withEstimates(dto, history, staleAfterMs, nowMs);
  });
  return {
    generatedAt,
    providers: providerDtos,
  };
}

/** Build the durable quota history series for configured providers. */
export function buildQuotaHistorySnapshot(deps: QuotaApiDeps): QuotaHistoryDto {
  const now = deps.now ?? Date.now;
  const nowMs = now();
  const generatedAt = toIso(nowMs);
  const historySince = toIso(nowMs - HISTORY_WINDOW_MS);
  const providers = deps.providers ?? SUPPORTED_PROVIDERS;
  return {
    generatedAt,
    historySince,
    history: deps.listHistory
      ? providers.flatMap((provider) => {
          const rows = deps.listHistory?.(provider, historySince) ?? [];
          return buildQuotaHistory(provider, rows, historySince, generatedAt);
        })
      : [],
  };
}

const SNAPSHOT_PATH = "/api/quota";
const HISTORY_PATH = "/api/quota/history";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

/**
 * Dispatch `GET /api/quota` (current snapshot) and `GET /api/quota/history` (durable history).
 * Returns true if it owned the request, false to fall through.
 * `deps` absent (e.g. no live QuotaService bound) → 503, static UI unaffected.
 */
export async function handleQuotaApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: QuotaApiDeps | null
): Promise<boolean> {
  if (url.pathname !== SNAPSHOT_PATH && url.pathname !== HISTORY_PATH) return false;
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
    if (url.pathname === HISTORY_PATH) {
      if (deps.readThroughHistory) {
        const readThrough = deps.readThroughHistory;
        // The production client resolves a failed provider to its last-good
        // history (or no history). Keep that provider isolation at the route
        // boundary too, so an unexpected rejection cannot suppress the other
        // providers' cached series.
        await Promise.allSettled(
          (deps.providers ?? SUPPORTED_PROVIDERS).map((p) => readThrough(p))
        );
      }
      const historySnapshot = buildQuotaHistorySnapshot(deps);
      sendJson(res, 200, historySnapshot);
    } else {
      const snapshot = await buildQuotaSnapshot(deps);
      sendJson(res, 200, snapshot);
    }
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}
