import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FinishReason, Type } from "@google/genai";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RusaConfig } from "../config/types.js";
import {
  type ScrapeAgyUsageOptions,
  scrapeAgyUsage as scrapeAgyUsageImpl,
} from "../providers/agy-usage-scrape.js";
import {
  type ScrapeCodexStatusOptions,
  scrapeCodexStatus as scrapeCodexStatusImpl,
} from "../providers/codex-status-scrape.js";
import {
  KimiAuthRequiredError,
  type ScrapeKimiUsageOptions,
  scrapeKimiUsage as scrapeKimiUsageImpl,
} from "../providers/kimi-usage-scrape.js";
import {
  getAllProviderModelCatalogs,
  getProviderModelCatalog,
  type ModelEntry,
} from "../providers/model-catalog.js";
import { resolveProvider } from "../providers/registry.js";
import type { CodingProvider, RunResult, SandboxOptions } from "../providers/types.js";
import type { QuotaCoordinatorClient } from "../quota/coordinator-client.js";
import { QUOTA_PROBE_TTL_MS, type QuotaFreshness } from "../quota/coordinator-protocol.js";
import { configuredModelRefs, resolveWindowModels } from "../quota/model-window-scope.js";
import {
  hasSameQuotaWindowScope,
  isModelScopedWindow,
  isProviderScopedWindow,
} from "../quota/window-scope.js";
import { extractGeminiText, getGeminiClient } from "../understanding/gemini-utils.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const QUOTA_MCP_NAME = "quota";

/**
 * Normalized window classification, shared by claude/codex/agy/kimi windows
 *  — the historical agy path's `AgyLimitKind`. On the LLM-parse path
 * (the only path, ratified ISSUE_NUM/ISSUE_NUM) the LLM classifies each window directly
 * in the response schema; free-text `label` stays display-only and is never
 * used to derive the kind.
 */
export type QuotaWindowKind = "session" | "five_hour" | "weekly" | "other";

/**
 * Object window scope. Provider-wide windows carry `{ provider }`;
 * model-specific windows carry `{ provider, models }` where `models` is the
 * canonical set of configured model IDs the observed window applies to —
 * already validated against the provider's runtime model catalog at the trust
 * boundary (`quota/model-window-scope.ts`), never the parser's raw labels.
 */
export interface QuotaWindowScope {
  provider: string;
  /** Canonical configured model IDs; absent (or empty) = provider-wide. */
  models?: string[];
}

/**
 * Read-only compatibility for snapshots written before the object scope
 * contract. New parser output and all versioned persisted snapshots use
 * {@link QuotaWindowScope}; keeping these spellings in the input type lets an
 * upgraded process safely discard an old model row rather than accidentally
 * treating it as provider evidence.
 */
export type LegacyQuotaWindowScope = "provider" | "model";

export type QuotaInferenceRule =
  | "sibling_window_copy"
  | "assumed_window_starts_now"
  | "carried_forward_bad_read";

export interface QuotaInferenceExplanation {
  window: string;
  field: string;
  rule: QuotaInferenceRule;
  detail: string;
}

/** One parsed usage-limit row from the healthy `/status` panel. */
export interface QuotaLimit {
  /** The row label, e.g. "5h" or "Weekly". */
  label: string;
  /**
   * Normalized window classification  — the DTO layer keys off this,
   * never off `label`, so a free-text label variance can't break the id a
   * consumer (e.g. the dashboard's session/5h ring) looks up by.
   */
  kind?: QuotaWindowKind;
  /** Percentage of the limit still available (0–100). */
  percentLeft: number;
  /**
   * Normalized absolute ISO-8601 instant for reset, when the LLM parse
   *  could resolve one — either a wall-clock/calendar reading it read
   * directly, or a pure relative offset ("70h 13m") resolved deterministically
   * downstream. Absent when the reset text is ambiguous or for not-yet-started windows.
   */
  resetAtIso?: string;
  /**
   * Scope of the limit. `{ provider }` for provider-wide limits; `{ provider,
   * models }` for model-specific limits, where `models` is the canonical set
   * of configured models the window applies to. Absent reads as provider-wide.
   */
  scope?: QuotaWindowScope | LegacyQuotaWindowScope;
  /**
   * ISO-8601 instant when this specific reading was originally scraped.
   * Preserved when an individual window is carried forward from a previous
   * scrape (e.g. across a bad read or extraction failure), so downstream consumers
   * can observe the true age of carried model or provider readings (#763).
   */
  scrapedAt?: string;
  /**
   * Raw commanded start-pacer throttle period in seconds from the latest reasoned
   * observation for this specific window (0 when unthrottled, null when no observation
   * has been reasoned) (#336).
   *
   * Note: This is the raw per-window commanded period, NOT the effective lane admission
   * interval enforced by the start pacer (which is the governing maximum across all of
   * the lane's windows and may be widened to maxIntervalSeconds upon hard staleness via
   * /v1/throttle).
   */
  throttleSeconds?: number | null;
  /**
   * Start-pacer controller pace error (positive = consuming faster than linear pace,
   * negative = plenty of quota headroom), null when no observation has been reasoned (#336).
   */
  paceError?: number | null;
}

/**
 * Why one LLM quota extraction attempt failed (#774). Enough to tell a
 * runaway digit loop from a schema miss or a transport error, without keeping
 * the full response body.
 */
export interface QuotaExtractionFailure {
  /** 1 for the first model, 2 for the stronger-model retry. */
  attempt: number;
  /** The extraction model the attempt ran on. */
  model: string;
  /** Wall-clock time from request to failure. */
  elapsedMs: number;
  /** The failure message, capped at QUOTA_FAILURE_ERROR_CHARS. */
  error: string;
  /** The API's finish reason, when a response arrived and carried one. */
  finishReason?: string;
  /** The first QUOTA_FAILURE_RESPONSE_HEAD_CHARS of the response text. */
  responseHead?: string;
  /** Total length of the response text, in UTF-16 code units. */
  responseLength?: number;
}

export interface ProviderQuotaSnapshot {
  provider: string;
  status: "available" | "exhausted" | "unknown" | "unsupported";
  raw?: string;
  message?: string;
  /**
   * Per-window quota readings (5h + Weekly for codex, session + weekly for
   * claude, GEMINI windows for agy), parsed structurally by the LLM. This is
   * the ONLY carrier of quota numbers — there are no top-level headline
   * fields — so multi-window consumers (the dashboard quota endpoint, ISSUE_NUM)
   * render every window instead of just a binding one.
   */
  limits?: QuotaLimit[];
  /**
   * Optional balance from a Codex `/status` `Credits:` row. Its absence means
   * the rendered panel did not report a balance; it never means zero. This is
   * observation-only until #924's pacing design is approved.
   */
  remainingCredits?: number;
  /**
   * ISO-8601 instant the underlying provider was actually scraped (ISSUE_NUM, ask
   * 5) — stamped once, at probe time, by whichever `probe*Quota` produced this
   * state. Rides unchanged through the TTL cache (a cache hit returns the
   * same `scrapedAt` the original probe stamped) and the dashboard's SWR
   * layer, so the "refreshed at" UI stamp is always ground truth for when the
   * provider was last actually queried — never a cache-hit or client-fetch
   * time. Absent for kimi (probe left untouched) and any error/early-return
   * path that never reached a probe.
   */
  scrapedAt?: string;
  /**
   * Explanations of any derived/inferred fields . Empty when the effective
   * snapshot is identical to the raw parser output.
   */
  explanations?: QuotaInferenceExplanation[];
  /**
   * The LLM extraction attempts that failed in this cycle, one entry per
   * attempt (at most two). Absent when the first attempt succeeded (#774).
   */
  extractionFailures?: QuotaExtractionFailure[];
  /**
   * Coordinator freshness block (§5.5, criterion 15) when served via the coordinator service.
   * Cold coordinator answers status: "unknown" with freshness.
   */
  freshness?: QuotaFreshness;
}

export interface QuotaMcpDeps {
  config: RusaConfig;
  workersDir: string;
  resolveProvider?: (config: RusaConfig, provider: string, model?: string) => CodingProvider;
  ttlMs?: number;
  /**
   * Injectable codex interactive `/status` scrape (test seam). Defaults to the
   * real tmux-in-bwrap PTY harness. Returns the raw captured TUI text.
   */
  scrapeCodexStatus?: (opts: ScrapeCodexStatusOptions) => Promise<string>;
  /**
   * Injectable agy interactive `/usage` scrape (test seam). Defaults to the real
   * host-side tmux PTY harness. Returns the raw captured "Models & Quota" text.
   */
  scrapeAgyUsage?: (opts: ScrapeAgyUsageOptions) => Promise<string>;
  /**
   * Injectable kimi interactive `/usage` scrape (test seam). Defaults to the real
   * host-side tmux PTY harness. Returns the raw captured Kimi usage text.
   */
  scrapeKimiUsage?: (opts: ScrapeKimiUsageOptions) => Promise<string>;
  /** Wall-clock timestamp source, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Canonical configured model IDs for a provider, supplied to the quota
   * parser so model-specific windows classify against the pool's real model
   * catalog (an input to classification, not a hand-maintained whitelist).
   * Defaults to the runtime model catalog (`getProviderModelCatalog`); when it
   * yields no entries, the parser emits no model-specific windows.
   */
  modelCatalogFor?: (provider: QuotaLlmProvider) => readonly ModelEntry[];
  /** Durable sink for real PTY probes. Cache hits never call it. */
  scrapeStore?: {
    recordRaw(opts: { provider: string; scrapedAt: string; rawOutput: string }): string;
    recordParsed(
      id: string,
      rawParsed: ProviderQuotaSnapshot,
      inferredParsed: ProviderQuotaSnapshot
    ): void;
    recordParseError(id: string, error: unknown): void;
  };
  /**
   * Quota coordinator client for reading quota status via GET /v1/quota without local probes
   * (§12 item 4, #356). When configured, get_quota routes through the coordinator client.
   */
  coordinatorClient?: QuotaCoordinatorClient | null;
}

/**
 * One structured usage-window reading from an LLM quota parse — session/weekly/5h
 * (claude, codex), or one window within an agy per-group breakdown. `placeholder:
 * true` marks a window the source TUI hasn't produced a number for yet (e.g.
 * codex's `/status` "refresh requested; run /status again shortly", or agy's
 * "Disabled: ..." note) — the LLM parse represents that state directly instead
 * of degrading to a generic "not recognized" unknown .
 */
interface LlmQuotaWindow {
  label: string;
  /**
   * LLM-classified window kind  — the DTO/UI lookup keys off this, not
   * `label`, so a free-text label variance (e.g. "Session" vs "Current
   * session") can't break the id a consumer looks up by. Untyped at the JSON
   * boundary; `normalizeQuotaWindowKind` validates it.
   */
  kind?: QuotaWindowKind;
  /**
   * Exactly one of these carries the printed percentage as text, according to
   * whether the source labels it used or left. Code parses it and does the
   * `100 - N` conversion: asked to compute a number, the model could emit
   * `43.000…` until the output-token cap (#775).
   */
  usedPercent?: string;
  remainingPercent?: string;
  resetAtIso?: string;
  resetInIso?: string;
  placeholder?: boolean;
  scope?: "provider";
  /**
   * For a model-specific window, the configured model IDs it applies to, chosen
   * only from the configured model list supplied in the instructions. Code at
   * the trust boundary intersects these with the canonical configured IDs and
   * drops the window when nothing configured matches. Absent = provider-wide.
   */
  models?: string[];
}

export type QuotaLlmProvider = "claude" | "codex" | "agy" | "kimi";

/**
 * Collection-only probe outcome. `didProbe` is true only for the caller that
 * started a real expired-cache probe, never for a cache hit or a caller that
 * merely joined somebody else's in-flight work.
 */
export interface QuotaProbeOutcome {
  state?: ProviderQuotaSnapshot;
  didProbe: boolean;
  error?: unknown;
  /**
   * The probe's own read produced no reading, even when `state` carries an
   * earlier reading forward (#775).
   */
  readFailed?: boolean;
}

/** The valid `QuotaWindowKind` values, for validating the LLM's `kind` output. */
const QUOTA_WINDOW_KINDS: readonly QuotaWindowKind[] = ["session", "five_hour", "weekly", "other"];

/**
 * Validate the LLM's free-form `kind` output against the enum  — never
 * trust raw JSON as already-narrowed. Returns undefined for anything
 * missing/unrecognized rather than guessing, matching this file's existing
 * "leave empty rather than guess" discipline (e.g. `resolveResetAtIso`).
 */
function normalizeQuotaWindowKind(raw: string | undefined): QuotaWindowKind | undefined {
  return QUOTA_WINDOW_KINDS.find((k) => k === raw);
}

const LLM_WINDOW_ITEM_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    label: {
      type: Type.STRING,
      description: "Window label as the source prints it, e.g. 'Session', 'Weekly', '5h'.",
    },
    kind: {
      type: Type.STRING,
      enum: ["session", "five_hour", "weekly", "other"],
      description:
        "Classify this window by MEANING, not its exact wording — the label text varies run to " +
        "run (e.g. 'Session' vs 'Current session') but the kind must not. 'session' for a short " +
        "current-session window; 'five_hour' for a 5-hour rolling window (e.g. codex '5h'); " +
        "'weekly' for a 7-day/weekly window; 'other' for anything that doesn't fit those.",
    },
    usedPercent: {
      type: Type.STRING,
      description:
        "Percentage of this window's quota USED, 0-100, copied as text from the printed number " +
        "without the % sign (e.g. '43' or '57.5') when the source reports it as used. Leave this empty (or omit it) when the source reports left/remaining; " +
        "that goes in remainingPercent. A window must carry exactly one of usedPercent or " +
        "remainingPercent. Use numeric text, never the apparent length of a progress bar. " +
        "Omit when placeholder is true.",
    },
    remainingPercent: {
      type: Type.STRING,
      description:
        "Percentage of this window's quota LEFT or REMAINING, 0-100, copied as text from the " +
        "printed number without the % sign when the source reports it as left/remaining. Do not convert it to used. Leave " +
        "this empty (or omit it) when the source reports used; that goes in usedPercent. " +
        "Omit when placeholder is true.",
    },
    resetAtIso: {
      type: Type.STRING,
      description:
        "ISO-8601 instant (with UTC offset) this window resets at, assembled from an absolute " +
        "wall-clock/calendar reading (e.g. '23:32', '12:34 on 14 Jul', 'Jul 7th, 2026 12:25 PM') " +
        "using the current local date, time, and UTC offset given below. A reading that omits the " +
        "year or the timezone is NOT ambiguous: take the year from the current local date and the " +
        "offset from the current local time below. Leave this empty for a pure relative duration " +
        "(e.g. '70h 13m', '3h 10m', '2 days, 22 hours') — that is resolved deterministically " +
        "downstream, do not compute it yourself — and when the row prints no reset at all. " +
        "A window below 100% left must carry exactly one of resetAtIso or resetInIso.",
    },
    resetInIso: {
      type: Type.STRING,
      description:
        "ISO-8601 duration until this window resets, ONLY when the source gives a pure relative " +
        "duration (e.g. '70h 13m' -> 'PT70H13M', '3h 10m' -> 'PT3H10M', " +
        "'2 days, 22 hours' -> 'P2DT22H'). Leave this empty for absolute/wall-clock/calendar " +
        "readings (those go in resetAtIso) or when no reset duration is present. Must be a valid " +
        "ISO-8601 duration, never the source text verbatim.",
    },
    placeholder: {
      type: Type.BOOLEAN,
      description:
        "True when the source has NOT produced a usable number for this window yet (e.g. " +
        "codex's 'refresh requested; run /status again shortly'), as opposed to a real reading.",
    },
    scope: {
      type: Type.STRING,
      enum: ["provider"],
      description:
        "The only accepted scope value is 'provider'. A window that applies to the whole provider/account carries no `models`. A model-specific window also carries `models` (see below).",
    },
    models: {
      type: Type.ARRAY,
      description:
        "Model-specific windows ONLY: the configured model IDs (verbatim from the configured model list in the instructions) this window applies to — e.g. a Claude 'Current Week (Fable)' row lists the configured Fable model IDs. Omit for provider-wide windows. Windows whose models match nothing configured are dropped downstream, so list only models that are actually configured.",
      items: {
        type: Type.STRING,
      },
    },
  },
  required: ["label", "kind", "placeholder", "scope"],
  // Gemini writes optional keys alphabetically unless told otherwise, which
  // puts usedPercent after both reset fields. A model that skipped the resets
  // then wrote them into the percentage ("36-10-05T02:59:00+00:00", "10idk")
  // and dropped the reset. Percentages first, then resets (#775).
  propertyOrdering: [
    "label",
    "kind",
    "placeholder",
    "scope",
    "models",
    "usedPercent",
    "remainingPercent",
    "resetAtIso",
    "resetInIso",
  ],
};

/**
 * Local wall-clock time WITH its UTC offset (e.g. "2026-07-12T08:15:30-07:00"),
 * as opposed to `Date#toISOString()` which always renders UTC. Anchors the LLM
 * quota parse's "now" reference so it can resolve a TUI's host-local wall-clock
 * reset text (codex prints no timezone) without guessing one .
 */
function formatLocalIsoWithOffset(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`
  );
}

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * The scrape instant as the prompt's "now", spelled out component by component
 * — calendar date, year, clock time and UTC offset — in the host's local zone,
 * the zone a TUI prints its clock in. A panel that prints `08:49 on 19 Sep`
 * omits exactly the year and the zone; handing both to the model as plain
 * numbers lets it assemble the instant instead of declining the arithmetic
 * (#517). Parsing the printed text stays the model's job: the TUI's wording
 * drifts, and code that pattern-matches it is the brittleness the LLM parse
 * replaced.
 */
function describeLocalNow(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = formatLocalIsoWithOffset(ms);
  const offset = iso.slice(-6);
  return (
    "The current local time — in the SAME timezone the TUI's clock is printed in — " +
    `is ${iso}. Its components: today is ${WEEKDAY_NAMES[d.getDay()]} ${d.getDate()} ` +
    `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}; the current year is ${d.getFullYear()}; ` +
    `the current local clock time is ${pad(d.getHours())}:${pad(d.getMinutes())}; ` +
    `the UTC offset is ${offset}. `
  );
}

function parseIsoDuration(duration: string | undefined): number | undefined {
  if (!duration) return undefined;
  const trimmed = duration.trim();
  const match =
    /^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      trimmed
    );
  if (!match) return undefined;

  const [, weeksRaw, daysRaw, hoursRaw, minutesRaw, secondsRaw] = match;
  if (!weeksRaw && !daysRaw && !hoursRaw && !minutesRaw && !secondsRaw) {
    return undefined;
  }

  const weeks = weeksRaw ? Number(weeksRaw) : 0;
  const days = daysRaw ? Number(daysRaw) : 0;
  const hours = hoursRaw ? Number(hoursRaw) : 0;
  const minutes = minutesRaw ? Number(minutesRaw) : 0;
  const seconds = secondsRaw ? Number(secondsRaw) : 0;
  if (![weeks, days, hours, minutes, seconds].every(Number.isFinite)) {
    return undefined;
  }

  return (
    weeks * 7 * 24 * 3_600_000 +
    days * 24 * 3_600_000 +
    hours * 3_600_000 +
    minutes * 60_000 +
    seconds * 1_000
  );
}

function resolveResetAtIso(
  resetAtIso: string | undefined,
  resetInIso: string | undefined,
  generatedAtMs: number
): string | undefined {
  if (resetAtIso?.trim()) return resetAtIso;

  const durationMs = parseIsoDuration(resetInIso);
  if (durationMs !== undefined) {
    return new Date(generatedAtMs + durationMs).toISOString();
  }

  return undefined;
}

/**
 * Output-token ceiling for one quota extraction attempt (#775).
 * A typical valid extraction reply is ~300 tokens; 8192 is an uncalibrated,
 * generous power-of-two ceiling leaving ample headroom for multi-group
 * agy panels while bounding an LLM token runaway to a few seconds
 * (roughly 8x below the 65,536 limit observed on staging).
 */
const QUOTA_PARSE_MAX_OUTPUT_TOKENS = 8192;

/** Response text kept from a failed extraction attempt (#774). */
const QUOTA_FAILURE_RESPONSE_HEAD_CHARS = 400;
/** Failure message kept from a failed extraction attempt (#774). */
const QUOTA_FAILURE_ERROR_CHARS = 300;

/** What one extraction attempt saw before it succeeded or failed. */
interface ExtractionAttemptObservation {
  finishReason?: string;
  text?: string;
}

function describeFailedAttempt(
  attempt: number,
  model: string,
  elapsedMs: number,
  error: unknown,
  seen: ExtractionAttemptObservation
): QuotaExtractionFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    attempt,
    model,
    elapsedMs,
    error: message.slice(0, QUOTA_FAILURE_ERROR_CHARS),
    ...(seen.finishReason ? { finishReason: seen.finishReason } : {}),
    ...(seen.text !== undefined
      ? {
          responseHead: seen.text.slice(0, QUOTA_FAILURE_RESPONSE_HEAD_CHARS),
          responseLength: seen.text.length,
        }
      : {}),
  };
}

/**
 * Read the model's copied percentage text ("43", "57.5", "43%") as a number
 * in 0-100 with at most 4 decimal places. Anything else, including a JSON
 * number, an unprinted decimal tail, or a runaway zero sequence, is undefined.
 */
function parsePrintedPercent(text: unknown): number | undefined {
  if (typeof text !== "string") return undefined;
  const match = /^(\d{1,3}(?:\.\d{1,4})?)\s*%?$/.exec(text.trim());
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return value <= 100 ? value : undefined;
}

function isPercentFieldPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

/**
 * Resolve a window's percentLeft from whichever of usedPercent or
 * remainingPercent the model copied. Returns an error message when the window
 * carries both, neither, or text that is not a printed 0-100 percentage.
 */
function resolvePercentLeft(w: LlmQuotaWindow): number | string {
  const hasUsed = isPercentFieldPresent(w.usedPercent);
  const hasRemaining = isPercentFieldPresent(w.remainingPercent);
  if (hasUsed === hasRemaining) {
    return `must carry exactly one of usedPercent or remainingPercent, got ${hasUsed ? "both" : "neither"}`;
  }
  const field = hasUsed ? "usedPercent" : "remainingPercent";
  const text = hasUsed ? w.usedPercent : w.remainingPercent;
  const value = parsePrintedPercent(text);
  if (value === undefined) return `has invalid ${field} ${JSON.stringify(text)}`;
  return hasUsed ? 100 - value : value;
}

/** A printed whole-credit balance: grouped (`3,336`) or plain (`0`). */
const PRINTED_CREDIT_BALANCE = /^(?:\d{1,3}(?:,\d{3})+|\d+)$/;

/**
 * The printed balances of the `Credits:` rows in a raw Codex `/status` panel.
 * The model's copied value is accepted only when the source actually prints
 * it, so a model that invents a balance for a panel without one cannot turn
 * unknown into a number.
 */
function printedCreditRows(output: string): string[] {
  return [...output.matchAll(/(?:^|[\s│|])Credits:[ \t]*([^\s│|]+)/gm)].map((m) => m[1] ?? "");
}

/**
 * Read an optional Codex `Credits:` balance as the whole number the panel
 * prints. Anything else — absent, unprintable, or not on a `Credits:` row of
 * the raw panel — is unknown, never zero. Credits are observation-only, so an
 * unusable value never fails the parse: the windows the pacer reads survive.
 */
function readCodexRemainingCredits(value: unknown, output: string): number | undefined {
  if (typeof value !== "string") return undefined;
  const printed = value.trim();
  if (!PRINTED_CREDIT_BALANCE.test(printed)) return undefined;
  if (!printedCreditRows(output).includes(printed)) return undefined;
  return Number(printed.replaceAll(",", ""));
}

async function parseQuotaWithLlm(
  output: string,
  apiKey: string,
  provider: QuotaLlmProvider,
  generatedAtMs = Date.now(),
  configuredModels: readonly ModelEntry[] = []
): Promise<Partial<ProviderQuotaSnapshot>> {
  const client = getGeminiClient(apiKey);
  const isAgy = provider === "agy";

  const properties: Record<string, unknown> = {
    status: {
      type: Type.STRING,
      enum: ["available", "exhausted", "unknown"],
      description:
        "The status of the quota. 'available' if quota is active/under limit, 'exhausted' if limit reached/exceeded, 'unknown' if indeterminate (including when every window is a placeholder with no number yet).",
    },
  };

  if (isAgy) {
    properties.windows = {
      type: Type.ARRAY,
      description:
        "Top-level windows. For agy, emit the GEMINI MODELS windows here with scope='provider'.",
      items: LLM_WINDOW_ITEM_SCHEMA,
    };
  } else {
    properties.windows = {
      type: Type.ARRAY,
      description:
        "Per-window breakdown, e.g. session + weekly (claude/kimi) or 5h + Weekly (codex/kimi).",
      items: LLM_WINDOW_ITEM_SCHEMA,
    };
  }

  if (provider === "codex") {
    properties.remainingCredits = {
      type: Type.STRING,
      description:
        "Optional remaining credit balance. Emit only when the rendered `/status` panel has a " +
        "literal `Credits:` row. Copy its printed non-negative number as text, preserving digit " +
        "grouping (for example `3,336` or `0`). Omit this field when that row is absent; absent " +
        "means unknown, never zero. Do not infer credits from URLs, rate-limit prose, plan names, " +
        "or generic mentions of credits.",
    };
  }

  const providerClause =
    provider === "claude"
      ? "For Claude: it will show session/week usage windows with percentage used and reset times (e.g. 'resets in 4 hours 12 minutes' or 'resets Jul 13, 2:59am (UTC)'). " +
        "Provider-wide session/week rows carry no `models` and alone determine status. " +
        "Named-model rows such as 'Current Week (Fable)' are model-specific: emit them with `models` set to the configured IDs for that model from the configured model list, and never use them to determine status. " +
        "If any provider-wide window is 100% used or the output says 'rate limit exceeded' or 'limit exceeded', " +
        "status is 'exhausted'.\n"
      : provider === "codex"
        ? // A real reading has limit rows or an exhaustion banner. codex's /status
          // also frequently renders `Limits: refresh requested; run /status again
          // shortly` — an async-refresh PLACEHOLDER, not a reading (issue #8). The
          // host probe now retries /status in-session on it, so a real table usually
          // reaches the parser; when only the placeholder renders, classify it as a
          // known pending/no-data state — unknown with windows=[] — never a number,
          // never a parse error, and never an invented window (the placeholder names
          // no 5h/weekly window to label, and downstream drops placeholder windows
          // anyway, so emitting one would only force the model to guess label/kind).
          "For Codex: a real reading contains limit rows (e.g. '5h limit:', 'Weekly limit:') " +
          "or an explicit exhaustion message (\"You've hit your usage limit\" / 'hit your usage limit'). " +
          "Generic top-level rows labeled only '5h limit:' or 'Weekly limit:' appearing above any model heading are provider-wide account rows: emit them with no `models`; they alone determine status. " +
          "`GPT-5.3-Codex-Spark limit` is a heading and all rows beneath it are scoped only to the gpt-5.3-codex-spark model class: emit each row beneath this heading (such as '5h limit:' or 'Weekly limit:') with `models: [\"gpt-5.3-codex-spark\"]`, even if that model is not in the configured model list below. Never use model rows to determine provider status. Account rows above the heading remain provider scope. " +
          "Other named-model, model-family, reserve, and special-allocation limits are model-specific: an inline label containing a model or reserve name before 'Weekly limit' (for example 'gpt-reserve Weekly limit'), or any rows beneath a standalone '<model name> limit:' heading. " +
          "Emit each model-specific row with `models` set to the matching IDs from the configured model list, and never use model rows to determine provider status. " +
          "Codex percentages say LEFT: copy the printed N% left as remainingPercent 'N' and leave usedPercent empty. " +
          `If it contains "You've hit your usage limit" or "hit your usage limit", ` +
          "status is 'exhausted' only when that message applies to the provider-wide quota; extract provider-wide percentages and reset times (including from 'try again at <date/time>'). " +
          'KNOWN PENDING STATE: codex\'s /status can render "Limits: refresh requested; run /status again shortly" ' +
          '(or "run /status again") — codex\'s async-refresh placeholder, NOT a reading and NOT a parse error. ' +
          "When that placeholder is all that renders, return status='unknown' and windows=[] — do NOT guess a number, do NOT fail the parse, and do NOT emit an invented window for it. " +
          "Likewise, if the output contains none of the above — no limit rows, no exhaustion message, no refresh placeholder — return status='unknown' and windows=[]. " +
          "A terminal capture can contain repeated panels, an earlier refresh placeholder, or stale warning text. When at least one fully rendered provider-wide limit panel is present, use the latest such panel and ignore placeholder/warning remnants. " +
          "The pending-state rule applies only when no rendered provider-wide limit row or provider-wide exhaustion message appears anywhere in the capture.\n"
        : provider === "agy"
          ? "For agy: locate the 'GEMINI MODELS' section, which has a Weekly Limit and a " +
            "Five Hour Limit window. " +
            "The shared GEMINI MODELS section is provider-wide: emit its rows with no `models`; they alone determine status. " +
            "Every other named model or model-group section is model-specific: emit its rows with `models` set to the matching IDs from the configured model list (sections matching nothing configured are omitted entirely), and never use them to determine status. " +
            "CRITICAL — unlike Claude, agy's TUI reports quota REMAINING, not used. It can print a precise decimal percentage beside the bar and a rounded whole-number summary for the same window. Use the more precise printed percentage and ignore the apparent progress-bar length. " +
            "Copy the printed remaining number N into remainingPercent and leave usedPercent empty " +
            "(e.g. '0.00% remaining' or '[░░░ …] 0.00%' → remainingPercent '0.00'; '3% remaining' → remainingPercent '3'; '48% remaining' → remainingPercent '48'). " +
            "A window showing 'Quota available' with a full (100%) bar is fully available: " +
            "emit remainingPercent '100'. If a window says 'Disabled: You have hit your weekly limit, the 5-hour limit does not currently apply. Your weekly limit will fully refresh in <duration>', " +
            "emit this window with remainingPercent '0' (exhausted) and extract the reset duration, or if indeterminate emit with placeholder: true. " +
            "Emit the GEMINI MODELS Weekly Limit and Five Hour Limit at top level in `windows`, each with no `models`. " +
            "If weekly limit is at 100% used (0% remaining), status is 'exhausted'.\n"
          : "For Kimi: the interactive /usage panel shows Kimi Code platform quota, commonly including 5h/five-hour and weekly windows. " +
            "Kimi can print either 'N% used' or 'N% left/remaining'. Copy N into usedPercent for 'used' or into remainingPercent for 'left/remaining', never both " +
            "(e.g. '63% used' → usedPercent '63'; '0% left' → remainingPercent '0'; '88% left' → remainingPercent '88'). " +
            "Always use the numeric percentage text; never estimate from a progress bar. Provider-wide windows carry no `models` and alone determine status. " +
            "Every named-model or model-group limit is model-specific: emit it with `models` set to the matching IDs from the configured model list (rows matching nothing configured are omitted entirely), and never use it to determine status. " +
            "Extract every visible provider-wide quota window and set kind " +
            "to 'five_hour', 'weekly', 'session', or 'other'. If any provider window is 100% used (0% left), status is 'exhausted'. " +
            "If the screen is a login/auth/error state rather than a quota display, return status 'unknown' and no fabricated windows.\n";
  const configuredModelClause =
    configuredModels.length > 0
      ? `CONFIGURED MODELS for ${provider} (the canonical model IDs this pool runs — a ` +
        "model-specific window MUST list only IDs from this list, copied exactly): " +
        configuredModelRefs(configuredModels)
          .map((ref) =>
            ref.displayLabel && ref.displayLabel !== ref.identifier
              ? `${ref.identifier} (${ref.displayLabel})`
              : ref.identifier
          )
          .join(", ") +
        ".\n"
      : `No configured model list was supplied for ${provider}: emit NO model-specific windows — ` +
        "omit those rows entirely and NEVER re-label one as provider-wide. " +
        "Provider-wide windows remain eligible.\n";
  const systemInstruction =
    "You are a precise quota parser. Analyze the raw CLI or TUI output of a provider's " +
    "usage/status check and extract the quota state.\n" +
    "Return a JSON object matching the schema.\n" +
    "OUTPUT SCOPE CONTRACT: every window carries scope='provider'. A provider-wide window " +
    "(quota shared across the provider/account) carries no `models` and is the ONLY kind of " +
    "window that determines status. A model-specific window ALSO carries `models`: the configured " +
    "model IDs, chosen only from the configured model list below, that the observed window applies " +
    "to. Never invent a model ID, never copy a name that is not in the configured list, and never " +
    "let a model-specific window influence status. Code downstream intersects `models` with the " +
    "configured list and drops the window entirely when nothing configured matches — a reserve or " +
    "family label with no configured model disappears instead of masquerading as provider-wide " +
    "evidence.\n" +
    "GROUNDING REQUIREMENT: You MUST ONLY report windows and statuses that are physically printed in the provided output. " +
    "If the output contains ONLY a welcome banner, splash screen, prompt menu, login error, or does NOT contain rendered quota/status limit rows or an explicit exhaustion message, " +
    "you MUST return status='unknown' with windows=[]. NEVER invent, hallucinate, approximate, or assume 100% remaining / 0% used when quota limit information is absent from the text.\n" +
    "PERCENTAGE REQUIREMENT: Read the explicit numeric percentage text and never infer a value from progress-bar artwork. Copy the printed number N as text and never compute a new number: put N in usedPercent if the source reports USED, or in remainingPercent if it reports LEFT or REMAINING. Fill exactly one of the two for each window. The precision of all numbers should be limited to at most 3 decimal places.\n" +
    providerClause +
    configuredModelClause +
    describeLocalNow(generatedAtMs) +
    "Use those components to assemble resetAtIso from wall-clock/calendar reset text. This is " +
    "copying numbers into an ISO-8601 instant, not date arithmetic: a bare clock time such as " +
    "'23:32' or 'resets 16:20' is that time today if it is still ahead of the current local time, " +
    "otherwise that time tomorrow; a day-and-month such as '12:34 on 14 Jul', 'resets 02:10 on " +
    "27 Aug' or '15:11 on 1 Sep' is that day and month at that time in the CURRENT YEAR given " +
    "above, or in the next year only if that date has already passed this year; a full date such " +
    "as 'Jul 7th, 2026 12:25 PM' carries its own year. Always write the UTC offset given above " +
    "unless the source states another zone. A printed reset that omits the year or the timezone " +
    "is NOT ambiguous — the year and the offset come from the current local date and time above — " +
    "so fill resetAtIso for it rather than leaving it empty. Leave resetAtIso empty only when the " +
    "text cannot be read as a clock time or calendar date at all. " +
    "For pure relative reset durations (e.g. '70h 13m', '3h 10m', '2 days, 22 hours', 'in 4 hours 12 minutes'), do not compute resetAtIso; instead extract the " +
    "duration into resetInIso as a normalized ISO-8601 duration such as PT70H13M, " +
    "PT3H10M, PT4H12M, or P2DT22H.\n" +
    "RESET CONTRACT: every non-placeholder window that is below 100% left MUST carry exactly " +
    "one of resetAtIso (a valid ISO-8601 instant with UTC offset) or resetInIso (a valid " +
    "ISO-8601 duration). Never emit both for one window, and never emit prose, a bare clock " +
    "time, or a partial date in either field. A window below 100% left with neither field, or " +
    "with a value that is not valid ISO-8601, fails validation and the whole parse is retried on " +
    "a stronger model, so always fill the field rather than declining because the year or " +
    "timezone was not printed.";

  const executeOnce = async (
    modelName: string,
    seen: ExtractionAttemptObservation
  ): Promise<Partial<ProviderQuotaSnapshot>> => {
    const response = await client.models.generateContent({
      model: modelName,
      contents: `Parse the following CLI/TUI output of a quota check for the provider '${provider}':\n\n${output}`,
      config: {
        // Quota parsing is extraction, not creative generation. A fixed
        // temperature keeps a repeated scrape from changing its window set.
        temperature: 0,
        // A complete reply is a few hundred tokens. The cap makes a runaway
        // reply fail in seconds, so the stronger-model retry fires at once
        // instead of after minutes of output (#775).
        maxOutputTokens: QUOTA_PARSE_MAX_OUTPUT_TOKENS,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties,
          required: ["status", "windows"],
        },
        systemInstruction,
      },
    });

    // A response cut off at the model's output limit is incomplete; fail the
    // attempt with that cause so the stronger-model retry logs why (#763).
    const finishReason = response.candidates?.[0]?.finishReason;
    if (finishReason) seen.finishReason = String(finishReason);
    const text = await extractGeminiText(response);
    seen.text = text;
    if (finishReason === FinishReason.MAX_TOKENS) {
      throw new Error(
        `Quota parse failed: response truncated by model output token limit (finishReason: ${finishReason})`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (parseErr) {
      throw new Error(
        `Quota parse failed: invalid JSON output: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`
      );
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error("Quota parse failed: response is not an object");
    }
    const parsedObj = parsed as { windows?: unknown; status?: unknown; remainingCredits?: unknown };
    if (!Array.isArray(parsedObj.windows)) {
      throw new Error("Quota parse failed: response omitted the required windows array");
    }
    if (
      !(["available", "exhausted", "unknown"] as const).includes(
        parsedObj.status as "available" | "exhausted" | "unknown"
      )
    ) {
      throw new Error(`Quota parse failed: invalid status '${String(parsedObj.status)}'`);
    }

    const remainingCredits =
      provider === "codex"
        ? readCodexRemainingCredits(parsedObj.remainingCredits, output)
        : undefined;

    const limits: QuotaLimit[] = [];
    for (const rawWindow of parsedObj.windows) {
      if (!rawWindow || typeof rawWindow !== "object") {
        throw new Error("Quota parse failed: window is not an object");
      }
      const w = rawWindow as LlmQuotaWindow;

      if (w.placeholder === true) continue;
      if (w.placeholder !== undefined && w.placeholder !== false) {
        throw new Error(`Quota parse failed: window '${String(w.label)}' has invalid placeholder`);
      }
      if (w.scope !== undefined && w.scope !== "provider") {
        throw new Error(`Quota parse failed: window '${w.label}' has invalid scope`);
      }
      if (typeof w.label !== "string" || !w.label.trim()) {
        throw new Error("Quota parse failed: window label is missing");
      }
      if (
        w.models !== undefined &&
        (!Array.isArray(w.models) || w.models.some((m) => typeof m !== "string"))
      ) {
        throw new Error(`Quota parse failed: window '${w.label}' has invalid models`);
      }
      // Trust boundary for model-specific windows: the parser's raw labels are
      // intersected with the canonical configured model IDs for this provider.
      // Drop an empty/unrecognised allocation before provider-only reset
      // validation: it carries no provider evidence and must not make an
      // otherwise valid provider panel fail solely on its own missing reset.
      const rawModels = w.models ?? [];
      const hasExplicitModelScope = w.models !== undefined;
      const canonicalModels = resolveWindowModels(rawModels, configuredModelRefs(configuredModels));
      if (hasExplicitModelScope && canonicalModels.length === 0) continue;
      const percentLeft = resolvePercentLeft(w);
      if (typeof percentLeft === "string") {
        throw new Error(`Quota parse failed: window '${w.label}' ${percentLeft}`);
      }
      const kind = normalizeQuotaWindowKind(w.kind);
      if (!kind) {
        throw new Error(`Quota parse failed: window '${w.label}' has invalid kind`);
      }
      // A duration the model did emit but that is not ISO-8601 is a bad read,
      // not a missing one: fail here so the stronger-model retry sees it,
      // rather than letting it degrade into "no reset" and, for a 100%-left
      // window, into an assumed reset downstream.
      if (w.resetInIso?.trim() && parseIsoDuration(w.resetInIso) === undefined) {
        throw new Error(
          `Quota parse failed: window '${w.label}' has invalid reset duration '${w.resetInIso}'`
        );
      }
      const resetAtIso = resolveResetAtIso(w.resetAtIso, w.resetInIso, generatedAtMs);

      if (resetAtIso && !Number.isFinite(Date.parse(resetAtIso))) {
        throw new Error(
          `Quota parse failed: window '${w.label}' has invalid reset ISO '${resetAtIso}'`
        );
      }

      // A partially consumed provider window needs a reset so downstream pacing
      // does not act on an unbounded quota reading. A model-scoped row is
      // preserved for inference instead: it can inherit a same-kind provider
      // reset or a compatible prior model reset without altering provider status.
      if (canonicalModels.length === 0 && percentLeft < 100 && !resetAtIso) {
        throw new Error(
          `Quota parse failed: window '${w.label}' has percentLeft < 100 (${percentLeft}%) but no resolvable reset ISO`
        );
      }

      limits.push({
        label: w.label,
        kind,
        percentLeft,
        resetAtIso,
        scope: canonicalModels.length > 0 ? { provider, models: canonicalModels } : { provider },
      });
    }

    // Provider-wide availability/exhaustion semantics are grounded in
    // provider-wide windows only; a surviving model-specific window must not
    // masquerade as provider evidence (and a model-only response must not
    // count as a successful provider read).
    const providerWindows = limits.filter(isProviderScopedWindow);
    // A model reserve block read as provider-wide surfaces as a second
    // provider window of the same kind — the #517 contamination, where a Spark
    // reserve weekly stood beside the account's own weekly and downstream had
    // no way to tell which reset was the provider's. No provider prints two
    // account-wide windows of one kind, so fail the parse: the stronger-model
    // retry gets a chance to scope it correctly, and a second failure carries
    // the last good reading forward rather than publishing an ambiguous panel.
    const providerKindCounts = new Map<QuotaWindowKind, number>();
    for (const window of providerWindows) {
      // Every window pushed above carries a validated kind; the field is
      // optional on the shared DTO, so skip rather than count an absent one.
      if (!window.kind) continue;
      providerKindCounts.set(window.kind, (providerKindCounts.get(window.kind) ?? 0) + 1);
    }
    const duplicatedKind = [...providerKindCounts].find(([, count]) => count > 1);
    if (duplicatedKind) {
      throw new Error(
        `Quota parse failed: ${provider} returned ${duplicatedKind[1]} provider-wide ` +
          `'${duplicatedKind[0]}' windows — a model-specific block was read as provider-wide`
      );
    }
    if (providerWindows.length === 0 && parsedObj.status === "available") {
      throw new Error(
        `Quota parse failed: ${provider} status is available but no provider window was returned`
      );
    }

    const hasExhaustedWindow = providerWindows.some((limit) => limit.percentLeft <= 0);
    // A validated exhausted window is sufficient to fail closed even when the
    // model's summary says available. The inverse could be a partial panel
    // whose exhausted row was omitted, so send that disagreement through the
    // existing stronger-model retry rather than downgrade exhaustion.
    if (parsedObj.status === "exhausted" && providerWindows.length > 0 && !hasExhaustedWindow) {
      throw new Error(
        "Quota parse failed: status 'exhausted' disagrees with available provider windows"
      );
    }

    const status = hasExhaustedWindow
      ? "exhausted"
      : parsedObj.status === "unknown" || providerWindows.length === 0
        ? parsedObj.status === "exhausted"
          ? "exhausted"
          : "unknown"
        : "available";

    return {
      status,
      limits,
      ...(remainingCredits !== undefined ? { remainingCredits } : {}),
    };
  };

  const extractionFailures: QuotaExtractionFailure[] = [];
  const runAttempt = async (attempt: number, modelName: string) => {
    const seen: ExtractionAttemptObservation = {};
    const startedMs = Date.now();
    try {
      return await executeOnce(modelName, seen);
    } catch (err) {
      extractionFailures.push(
        describeFailedAttempt(attempt, modelName, Date.now() - startedMs, err, seen)
      );
      throw err;
    }
  };

  try {
    return await runAttempt(1, "gemini-3.5-flash-lite");
  } catch (firstErr) {
    console.warn(
      `[quota-mcp] [${provider}] LLM quota parse attempt 1 (gemini-3.5-flash-lite) failed: ${firstErr instanceof Error ? firstErr.message : String(firstErr)} — escalating attempt 2 to gemini-3.8-flash`
    );
    try {
      const result = await runAttempt(2, "gemini-3.8-flash");
      console.info(
        `[quota-mcp] [${provider}] LLM quota parse attempt 2 (gemini-3.8-flash) succeeded`
      );
      return { ...result, extractionFailures };
    } catch (secondErr) {
      console.error(
        `[quota-mcp] [${provider}] LLM quota parse attempt 2 (gemini-3.8-flash) failed: ${secondErr instanceof Error ? secondErr.message : String(secondErr)}`
      );
      return {
        status: "unknown",
        message: `LLM quota parsing failed: ${secondErr instanceof Error ? secondErr.message : String(secondErr)}`,
        extractionFailures,
      };
    }
  }
}

export async function parseClaudeQuota(
  output: string,
  apiKey?: string,
  generatedAtMs = Date.now(),
  configuredModels: readonly ModelEntry[] = []
): Promise<Partial<ProviderQuotaSnapshot>> {
  // Ratified: parse TUI output with an LLM, not regex — TUIs drift. No-key = fail-closed unknown, never a regex guess.
  if (apiKey) {
    return parseQuotaWithLlm(output, apiKey, "claude", generatedAtMs, configuredModels);
  }
  return {
    status: "unknown",
    message: "no geminiApiKey configured for LLM quota parsing",
  };
}

/** codex renders `/status` inside a box-drawn panel; these are its corners. */
const CODEX_PANEL_TOP = "\u256d";
const CODEX_PANEL_BOTTOM = "\u2570";
/** A rendered limit row (`5h limit:`), as opposed to the `Limits:` summary line. */
const CODEX_LIMIT_ROW = /\blimit:/i;
const CODEX_EXHAUSTION = /hit your usage limit/i;

/**
 * Narrow a codex `/status` capture to the completed panel (#517).
 *
 * The scrape harness re-issues `/status` in-session on codex's "refresh
 * requested; run /status again shortly" answer, so a successful capture holds
 * BOTH the refresh-pending panel and the completed one, plus notes printed
 * between them ("You have 2 usage limit resets available"). Only the completed
 * panel is a reading. Handing the whole capture to the parser asks it to pick,
 * on every scrape, between a pending panel and a real one and to ignore notes
 * that cast doubt on the numbers — a choice with no upside, since the pending
 * panel carries nothing the completed panel lacks.
 *
 * Deterministic and conservative: when no panel carries a rendered limit row
 * (pending-only, or nothing rendered at all) the capture is passed through
 * untouched so the parser still classifies the pending state honestly. An
 * exhaustion banner is also passed through whole — codex prints it outside the
 * panel, and dropping exhaustion evidence would fail open. The durable scrape
 * row always keeps the full capture; this only shapes what the parser reads.
 */
function selectRenderedCodexPanel(output: string): string {
  if (CODEX_EXHAUSTION.test(output)) return output;

  const lines = output.split("\n");
  const panels: { start: number; end: number }[] = [];
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(CODEX_PANEL_TOP)) {
      start = index;
    } else if (trimmed.startsWith(CODEX_PANEL_BOTTOM) && start >= 0) {
      panels.push({ start, end: index });
      start = -1;
    }
  }

  for (const panel of panels.reverse()) {
    const block = lines.slice(panel.start, panel.end + 1);
    if (block.some((line) => CODEX_LIMIT_ROW.test(line))) return block.join("\n");
  }
  return output;
}

export async function parseCodexQuota(
  output: string,
  apiKey?: string,
  generatedAtMs = Date.now(),
  configuredModels: readonly ModelEntry[] = []
): Promise<Partial<ProviderQuotaSnapshot>> {
  // Ratified: parse TUI output with an LLM, not regex — TUIs drift. No-key = fail-closed unknown, never a regex guess.
  if (apiKey) {
    return parseQuotaWithLlm(
      selectRenderedCodexPanel(output),
      apiKey,
      "codex",
      generatedAtMs,
      configuredModels
    );
  }
  return {
    status: "unknown",
    message: "no geminiApiKey configured for LLM quota parsing",
  };
}

export async function parseAgyQuota(
  output: string,
  apiKey?: string,
  generatedAtMs = Date.now(),
  configuredModels: readonly ModelEntry[] = []
): Promise<Partial<ProviderQuotaSnapshot>> {
  // Ratified: parse TUI output with an LLM, not regex — TUIs drift. No-key = fail-closed unknown, never a regex guess.
  if (apiKey) {
    return parseQuotaWithLlm(output, apiKey, "agy", generatedAtMs, configuredModels);
  }
  return {
    status: "unknown",
    message: "no geminiApiKey configured for LLM quota parsing",
  };
}

export async function parseKimiQuota(
  output: string,
  apiKey: string,
  generatedAtMs = Date.now(),
  configuredModels: readonly ModelEntry[] = []
): Promise<Partial<ProviderQuotaSnapshot>> {
  // Ratified: parse new TUI output with an LLM, not regex — TUIs drift.
  return parseQuotaWithLlm(output, apiKey, "kimi", generatedAtMs, configuredModels);
}

/**
 * A provider run that was killed before it completed, so its output holds no
 * panel to extract (#847). It fails the scrape the way a parser throw does, so
 * history reports it `failed` and its cause survives in the scrape's
 * `parse_error`. Every killed or signalled subprocess result is `cancelled`;
 * an ordinary non-zero exit is not, and still goes to extraction.
 */
class QuotaCaptureError extends Error {
  constructor(provider: string, command: string, result: RunResult) {
    const flags = (["cancelled", "interrupted"] as const).filter((f) => result[f]);
    const lastLine = result.output.trim().split("\n").pop()?.slice(-200) ?? "";
    super(
      `${provider} ${command} capture failed: exit ${result.exitCode}` +
        (flags.length > 0 ? ` (${flags.join(", ")})` : "") +
        (lastLine ? `; output ends: ${lastLine}` : "; no output")
    );
    this.name = "QuotaCaptureError";
  }
}

/**
 * Whether a bad read may carry this previous window forward. Model-scoped
 * windows carry only for Claude, whose Fable window #763 asked to keep.
 */
function carriesBadReadWindow(provider: string, limit: QuotaLimit): boolean {
  return isProviderScopedWindow(limit) || provider === "claude";
}

/**
 * A window carried across a bad read, stamped with its original read time for
 * Claude only (#763). Other providers keep the staging behaviour: the carried
 * window takes the bad read's time.
 */
function carriedBadReadWindow(
  provider: string,
  limit: QuotaLimit,
  prevScrapedAt: string | undefined
): QuotaLimit {
  if (provider !== "claude") return { ...limit };
  return { ...limit, scrapedAt: limit.scrapedAt ?? prevScrapedAt };
}

/**
 * Derive effective/inferred quota state from raw parser output .
 *
 * Rules:
 * 1. `sibling_window_copy`: When a model-scope window has no reset and the provider-scope window
 *    of the same kind in the same scrape does, copy it (exact join).
 * 2. `carried_forward_bad_read`: Carry forward unexpired window assessment from previous scrape
 *    on a bad read, EXCLUDING any window reset that was previously inferred via `assumed_window_starts_now`
 *    (preventing phantom deadline carry-forward hazard).
 * 3. `assumed_window_starts_now`: For a window at 100% left with no reset, assume window starts
 *    at the scrape instant, using constants 5h for session/five_hour and 168h for weekly across all providers.
 */
export function inferQuotaState(
  rawState: ProviderQuotaSnapshot,
  prevState?: ProviderQuotaSnapshot,
  scrapedAt?: string
): ProviderQuotaSnapshot {
  const effectiveScrapedAt = scrapedAt ?? rawState.scrapedAt ?? new Date().toISOString();
  const scrapedAtMs = Date.parse(effectiveScrapedAt);
  const explanations: QuotaInferenceExplanation[] = [];

  let status = rawState.status;
  let message = rawState.message;
  let limits: QuotaLimit[] | undefined = rawState.limits
    ? rawState.limits.map((l) => ({ ...l }))
    : undefined;

  const isAssumedReset = (prevSnapshot: ProviderQuotaSnapshot, label: string) => {
    return prevSnapshot.explanations?.some(
      (e) =>
        e.window === label && e.field === "resetAtIso" && e.rule === "assumed_window_starts_now"
    );
  };

  // Step 1: Bad read full-fallback (Rule: carried_forward_bad_read)
  // If the whole current parse returned status unknown or empty limits (bad read),
  // carry forward previous assessment's active unexpired limits with non-assumed resetAtIso (#763).
  // Claude also carries model-scoped windows (e.g. Fable), and its carried windows keep their
  // original observed time and provenance; other providers carry provider-scoped windows only,
  // at the bad read's time, as before.
  // Provider availability is derived strictly from provider-scoped windows: model-only readings
  // must never promote provider status to available/exhausted.
  if ((status === "unknown" || !limits || limits.length === 0) && prevState?.limits) {
    const activeUnexpiredLimits = prevState.limits
      .filter((limit) => {
        if (!carriesBadReadWindow(rawState.provider, limit)) return false;
        if (!limit.resetAtIso) return false;
        const resetMs = Date.parse(limit.resetAtIso);
        if (!Number.isFinite(resetMs) || resetMs <= scrapedAtMs) return false;
        return !isAssumedReset(prevState, limit.label);
      })
      .map((limit) => carriedBadReadWindow(rawState.provider, limit, prevState.scrapedAt));

    if (activeUnexpiredLimits.length > 0) {
      const activeProviderLimits = activeUnexpiredLimits.filter(isProviderScopedWindow);
      if (activeProviderLimits.length > 0) {
        status = prevState.status;
      } else {
        // Model-only limits must never promote provider status into available/exhausted (#763).
        status = "unknown";
      }
      limits = activeUnexpiredLimits;
      message = rawState.message ?? prevState.message;
      for (const limit of limits) {
        explanations.push({
          window: limit.label,
          field: "resetAtIso",
          rule: "carried_forward_bad_read",
          detail: "carried forward previous unexpired window assessment after bad read",
        });
      }
    }
  }

  // Step 2: Sibling window copy (Rule: sibling_window_copy)
  // When a model-scope window has no reset and the provider-scope window of the same kind
  // in the same scrape does, copy it (exact join).
  if (limits && limits.length > 0) {
    for (const limit of limits) {
      if (isModelScopedWindow(limit) && !limit.resetAtIso && limit.kind) {
        const providerSibling = limits.find(
          (s) => isProviderScopedWindow(s) && s.kind === limit.kind && s.resetAtIso
        );
        if (providerSibling?.resetAtIso) {
          limit.resetAtIso = providerSibling.resetAtIso;
          explanations.push({
            window: limit.label,
            field: "resetAtIso",
            rule: "sibling_window_copy",
            detail: `copied from the provider-scope ${limit.kind} in the same scrape`,
          });
        }
      }
    }
  }

  // Step 3: Bad read partial-fallback (Rule: carried_forward_bad_read)
  // The current parse extracted windows, but some window missed resetAtIso
  // while the previous scrape had an unexpired valid non-assumed resetAtIso.
  if (
    limits &&
    limits.length > 0 &&
    prevState?.limits &&
    prevState.provider === rawState.provider
  ) {
    for (const limit of limits) {
      if (limit.resetAtIso) continue;
      const prevMatch = prevState.limits.find(
        (p) =>
          hasSameQuotaWindowScope(p, limit) &&
          ((limit.kind !== undefined && p.kind === limit.kind) || p.label === limit.label) &&
          p.resetAtIso &&
          Date.parse(p.resetAtIso) > scrapedAtMs &&
          !isAssumedReset(prevState, p.label)
      );
      if (prevMatch?.resetAtIso) {
        limit.resetAtIso = prevMatch.resetAtIso;
        explanations.push({
          window: limit.label,
          field: "resetAtIso",
          rule: "carried_forward_bad_read",
          detail: "carried forward previous unexpired window reset after missing reading",
        });
      }
    }
  }

  // Step 4: Not-yet-started window (Rule: assumed_window_starts_now)
  // For a window at 100% left with no reset, assume window starts at the scrape instant,
  // using constants 5h for session/five_hour and 168h for weekly across all providers.
  if (limits && limits.length > 0) {
    for (const limit of limits) {
      if (limit.percentLeft === 100 && !limit.resetAtIso && limit.kind) {
        let durationMs: number | undefined;
        if (limit.kind === "session" || limit.kind === "five_hour") {
          durationMs = 5 * 60 * 60 * 1000;
        } else if (limit.kind === "weekly") {
          durationMs = 168 * 60 * 60 * 1000;
        }

        if (durationMs !== undefined && Number.isFinite(scrapedAtMs)) {
          limit.resetAtIso = new Date(scrapedAtMs + durationMs).toISOString();
          explanations.push({
            window: limit.label,
            field: "resetAtIso",
            rule: "assumed_window_starts_now",
            detail: `assumed not-started window starts at scrape instant (${durationMs / 3_600_000}h duration)`,
          });
        }
      }
    }
  }

  // A partially used model window may reach inference without a reset so it
  // can use a sibling or compatible previous model row. If neither repair
  // applies, it cannot safely become durable quota state; discard only that
  // model row and preserve the independently valid provider evidence.
  if (limits && limits.length > 0) {
    limits = limits.filter(
      (limit) => !(isModelScopedWindow(limit) && limit.percentLeft < 100 && !limit.resetAtIso)
    );
  }

  return {
    ...rawState,
    status,
    raw: rawState.raw,
    message,
    limits,
    scrapedAt: effectiveScrapedAt,
    explanations,
  };
}

/**
 * Owns quota probing + the split-TTL cache/dedupe layer. Extracted from
 * `createQuotaMcpServer`  so the dashboard's cached quota endpoint can
 * reuse the exact same probe family + caching behavior via `getQuota` instead
 * of re-implementing it — the endpoint must never probe on every page load.
 */
export class QuotaService {
  private readonly deps: QuotaMcpDeps;
  private readonly configuredProviders: Set<string>;
  private readonly cache = new Map<string, { state: ProviderQuotaSnapshot; timestamp: number }>();
  private readonly inFlightProbes = new Map<
    string,
    { promise: Promise<ProviderQuotaSnapshot>; startedAt: number }
  >();
  /** States a probe returned after its own read failed, carried or not. */
  private readonly failedReads = new WeakSet<ProviderQuotaSnapshot>();

  constructor(deps: QuotaMcpDeps) {
    this.deps = deps;
    this.configuredProviders = new Set(
      Object.entries(deps.config.providers).map(([name, provider]) => {
        const command = provider.cliCommand ?? name;
        return command === "antigravity" ? "agy" : command;
      })
    );
  }

  /** ISO-8601 stamp for "right now" — the moment a probe is executing. */
  private scrapedAtNow(): string {
    const now = this.deps.now ?? Date.now;
    return new Date(now()).toISOString();
  }

  /**
   * The canonical configured model catalog supplied to the parser for a
   * provider. The coordinator passes its derivation of the runtime model
   * catalog; other callers default to the registry itself. An empty result
   * means the parser emits no model-specific windows — provider-wide windows
   * remain eligible.
   */
  private configuredModelsFor(provider: QuotaLlmProvider): readonly ModelEntry[] {
    if (this.deps.modelCatalogFor) return this.deps.modelCatalogFor(provider);
    return getProviderModelCatalog(provider) ?? [];
  }

  /**
   * Seed one provider's prevState from a persisted snapshot — the
   * coordinator's boot-hydration path (#354, design §6.3). The cache timestamp
   * is the snapshot's own `scrapedAt`, so the provider TTL stays a floor on
   * the first post-restart probe and a restart continues an in-flight
   * inference chain instead of starting a fresh one.
   */
  hydrate(provider: QuotaLlmProvider, state: ProviderQuotaSnapshot): void {
    if (state.status === "unsupported") return;
    const scrapedAtMs = state.scrapedAt ? Date.parse(state.scrapedAt) : Number.NaN;
    this.cache.set(provider, {
      state,
      timestamp: Number.isFinite(scrapedAtMs) ? scrapedAtMs : (this.deps.now ?? Date.now)(),
    });
  }

  private async parsePersistedScrape(
    provider: "claude" | "codex" | "agy" | "kimi",
    rawOutput: string,
    scrapedAt: string,
    parse: () => Promise<ProviderQuotaSnapshot> | ProviderQuotaSnapshot
  ): Promise<ProviderQuotaSnapshot> {
    const prevState = this.cache.get(provider)?.state;
    const id = this.deps.scrapeStore?.recordRaw({
      provider,
      scrapedAt,
      rawOutput,
    });
    try {
      const rawState = await parse();
      const inferredState = inferQuotaState(rawState, prevState, scrapedAt);
      if (id) this.deps.scrapeStore?.recordParsed(id, rawState, inferredState);
      if (rawState.status === "unknown") this.failedReads.add(inferredState);
      return inferredState;
    } catch (error) {
      if (id) this.deps.scrapeStore?.recordParseError(id, error);
      if (prevState?.limits && prevState.limits.length > 0) {
        const hasUnexpired = prevState.limits.some(
          (l) =>
            carriesBadReadWindow(provider, l) &&
            l.resetAtIso &&
            Date.parse(l.resetAtIso) > Date.parse(scrapedAt) &&
            !prevState.explanations?.some(
              (e) =>
                e.window === l.label &&
                e.field === "resetAtIso" &&
                e.rule === "assumed_window_starts_now"
            )
        );
        if (hasUnexpired) {
          const carried = inferQuotaState(
            {
              provider,
              status: "unknown",
              scrapedAt,
              raw: rawOutput,
              message:
                error instanceof QuotaCaptureError
                  ? `${error.message}; preserving previous window assessment`
                  : `LLM quota parsing failed, preserving previous window assessment: ${error instanceof Error ? error.message : String(error)}`,
            },
            prevState,
            scrapedAt
          );
          this.failedReads.add(carried);
          return carried;
        }
      }
      throw error;
    }
  }

  private getTtlMs(): number {
    if (this.deps.ttlMs !== undefined) {
      return this.deps.ttlMs;
    }
    // #690: routine provider readings target ~30 minutes across all providers,
    // so expensive interactive scrapes are not churned while QuotaCollectionLoop
    // keeps ticking every 5m for manual observation ingestion and metric publication.
    // (Controller evaluation on scrape lanes advances when a fresh 30m probe lands;
    // manual lanes advance as operator observations arrive).
    // Codex must not go lower until its placeholder handling lands.
    return QUOTA_PROBE_TTL_MS;
  }

  /**
   * Get the current quota state for a provider, served from cache when fresh.
   * Concurrent calls for the same provider share one in-flight probe. This is
   * the ONLY entry point that may trigger a probe — callers (the MCP tool, the
   * dashboard endpoint) never probe directly.
   */
  async getQuotaProbeOutcome(
    provider: "claude" | "codex" | "agy" | "kimi"
  ): Promise<QuotaProbeOutcome> {
    if (!this.configuredProviders.has(provider)) {
      return {
        state: {
          provider,
          status: "unsupported",
          message: `${provider} is not configured on this instance`,
        },
        didProbe: false,
      };
    }
    const now = (this.deps.now ?? Date.now)();
    const cached = this.cache.get(provider);
    const ttl = this.getTtlMs();
    if (cached && now - cached.timestamp < ttl) {
      return { state: cached.state, didProbe: false };
    }

    let inFlight = this.inFlightProbes.get(provider);
    let didProbe = false;
    if (!inFlight) {
      didProbe = true;
      inFlight = {
        startedAt: now,
        promise: this.executeProbe(provider).finally(() => {
          this.inFlightProbes.delete(provider);
        }),
      };
      this.inFlightProbes.set(provider, inFlight);
    }

    let state: ProviderQuotaSnapshot;
    try {
      state = await inFlight.promise;
    } catch (error) {
      return { didProbe, error };
    }
    if (state.status !== "unknown" || !cached || cached.state.status === "unknown") {
      // Schedule the next probe from this probe's start, not its completion:
      // a slow CLI must not silently add a collection tick to the 30m cadence.
      this.cache.set(provider, { state, timestamp: inFlight.startedAt });
    }
    return {
      state,
      didProbe,
      ...(state.status === "unknown" || this.failedReads.has(state) ? { readFailed: true } : {}),
    };
  }

  async getQuota(provider: "claude" | "codex" | "agy" | "kimi"): Promise<ProviderQuotaSnapshot> {
    const outcome = await this.getQuotaProbeOutcome(provider);
    if (outcome.error) throw outcome.error;
    // Every non-error outcome carries state; keep this guard for a future
    // implementation change rather than returning an invented snapshot.
    if (!outcome.state) throw new Error(`Quota probe for ${provider} returned no state`);
    return outcome.state;
  }

  /**
   * Non-blocking read for request paths — the dashboard's `GET /api/quota`
   * (issue #10). Returns the latest in-memory reading immediately (fresh OR
   * stale) and, when the entry is stale or absent, kicks a refresh through the
   * same deduped probe path as {@link getQuota} **without awaiting it**, so a
   * dashboard poll never blocks on a live PTY probe (up to ~90s cold) and never
   * pins concurrent requests to that wait. Stale-while-revalidate: the caller
   * shows the last real reading with its honest `scrapedAt` age (issue #9), and
   * picks up the refreshed value on its next poll.
   *
   * A cold cache (e.g. right after a process restart) has no in-memory reading
   * to serve, so this returns an `unknown` placeholder; the dashboard layer
   * fills that from the durable quota DB via its `listHistory` fallback
   * (`buildQuotaSnapshot` → `latestStateFromHistory`), which is the same
   * newest-rows source issue #10 calls for. Callers that genuinely want an
   * on-demand live probe (the throttle-controller tick, the `get_quota` MCP
   * tool) keep using {@link getQuota}.
   */
  getQuotaCached(provider: "claude" | "codex" | "agy" | "kimi"): ProviderQuotaSnapshot {
    if (!this.configuredProviders.has(provider)) {
      return {
        provider,
        status: "unsupported",
        message: `${provider} is not configured on this instance`,
      };
    }
    const cached = this.cache.get(provider);
    const isFresh = cached && Date.now() - cached.timestamp < this.getTtlMs();
    if (!isFresh) {
      // Stale or cold → refresh in the background; do not await the probe.
      // Probe startup is deferred off the synchronous request call stack via
      // queueMicrotask so the request path does zero synchronous I/O or PTY setup.
      // getQuota() dedupes concurrent probes via inFlightProbes and writes any
      // fresh reading back into the same cache this read serves from.
      queueMicrotask(() => {
        void this.getQuota(provider).catch(() => {
          // Background refresh; a failure just leaves the stale reading in place
          // and surfaces on the next probe. Never rejects the request path.
        });
      });
    }
    return (
      cached?.state ?? {
        provider,
        status: "unknown",
        message: "no quota reading yet; refreshing in background",
      }
    );
  }

  private async executeProbe(
    providerName: "claude" | "codex" | "agy" | "kimi"
  ): Promise<ProviderQuotaSnapshot> {
    // Make sure probe-context directory exists
    const actorDir = join(this.deps.workersDir, `quota-probe-${providerName}`);
    mkdirSync(actorDir, { recursive: true });

    if (providerName === "kimi") {
      return this.probeKimiQuota(actorDir);
    }

    if (providerName === "agy") {
      return this.probeAgyQuota(actorDir);
    }

    if (providerName === "codex") {
      return this.probeCodexQuota(actorDir);
    }

    const resolver = this.deps.resolveProvider ?? resolveProvider;
    const providerInstance = resolver(this.deps.config, providerName);

    // Enable sandboxing so it runs in the same bwrap/auth context as real spawns
    const sandbox: SandboxOptions = {
      worktreePath: actorDir,
    };

    let result: RunResult;
    try {
      result = await providerInstance.run({
        prompt: "/usage",
        cwd: actorDir,
        sandbox,
        timeoutMs: 30_000,
      });
    } catch (err) {
      return {
        provider: "claude",
        status: "unknown",
        message: `claude /usage run failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const output = result.output;
    // Stamp scrapedAt as soon as the scrape itself completes (ISSUE_NUM, ask 5) —
    // before the LLM parse, which is post-processing, not part of the scrape.
    const scrapedAt = this.scrapedAtNow();
    return this.parsePersistedScrape("claude", output, scrapedAt, async () => {
      if (result.cancelled) throw new QuotaCaptureError("claude", "/usage", result);
      const apiKey = this.deps.config.geminiApiKey?.trim();

      if (!apiKey) {
        return {
          provider: "claude",
          status: "unknown",
          message: "no geminiApiKey configured for LLM quota parsing",
          scrapedAt,
        };
      }
      const parsed = await parseClaudeQuota(
        output,
        apiKey,
        Date.parse(scrapedAt),
        this.configuredModelsFor("claude")
      );
      return {
        provider: "claude",
        status: parsed.status || "unknown",
        message: parsed.message,
        limits: parsed.limits,
        ...(parsed.extractionFailures ? { extractionFailures: parsed.extractionFailures } : {}),
        raw: output,
        scrapedAt,
      };
    });
  }

  /**
   * Codex has no quiet quota API — its remaining-quota numbers live only in the
   * interactive `/status` TUI. Rent a host-side PTY (tmux), scrape the panel, and
   * parse it deterministically. Read-only `/status` does not consume usage resets
   * (unlike `/usage`). While `/status` is read-only, CLI startup and authenticated
   * requests can trigger standard credential refreshes; the probe links the shared
   * host auth store so refreshes survive probe teardown while config/session state
   * remains isolated.
   * The get_quota TTL cache gates how often this runs (never probe-on-read).
   */
  private async probeCodexQuota(actorDir: string): Promise<ProviderQuotaSnapshot> {
    const scrape = this.deps.scrapeCodexStatus ?? scrapeCodexStatusImpl;
    let raw: string;
    try {
      // A single scrape suffices: the tmux harness now retries `/status`
      // IN-SESSION on codex's "refresh requested" async-refresh placeholder,
      // within its own 90s budget (see providers/codex-status-scrape.ts, issue
      // #8). The prior whole-scrape retry here spun up a FRESH cold codex session
      // each time — which just re-renders the placeholder — so it never actually
      // recovered a reading; re-sending `/status` in the same warm session does.
      raw = await scrape({ actorDir });
    } catch (err) {
      return {
        provider: "codex",
        status: "unknown",
        message: `codex /status scrape failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // Stamp scrapedAt as soon as the scrape itself completes (ISSUE_NUM, ask 5) —
    // before the LLM parse, which is post-processing, not part of the scrape.
    const scrapedAt = this.scrapedAtNow();
    return this.parsePersistedScrape("codex", raw, scrapedAt, async () => {
      const apiKey = this.deps.config.geminiApiKey?.trim();
      if (!apiKey) {
        return {
          provider: "codex",
          status: "unknown",
          message: "no geminiApiKey configured for LLM quota parsing",
          scrapedAt,
        };
      }
      const parsed = await parseCodexQuota(
        raw,
        apiKey,
        Date.parse(scrapedAt),
        this.configuredModelsFor("codex")
      );
      return {
        provider: "codex",
        status: parsed.status ?? "unknown",
        message: parsed.message,
        limits: parsed.limits,
        ...(parsed.remainingCredits !== undefined
          ? { remainingCredits: parsed.remainingCredits }
          : {}),
        ...(parsed.extractionFailures ? { extractionFailures: parsed.extractionFailures } : {}),
        raw,
        scrapedAt,
      };
    });
  }

  /**
   * agy has no quiet quota API either — quota lives only in the interactive
   * `/usage` "Models & Quota" view (ISSUE_NUM, leg 2). agy `/usage` is a READ-ONLY
   * display (confirmed host-side; it consumes nothing, unlike codex `/usage`).
   * Auth-safe: driven against the real (already-signed-in) `~/.gemini`, which is
   * safe because agy's refresh_token is durable/non-rotating; we never force a
   * rotation. GEMINI windows are returned as provider-scoped flat limits.
   */
  private async probeAgyQuota(actorDir: string): Promise<ProviderQuotaSnapshot> {
    const scrape = this.deps.scrapeAgyUsage ?? scrapeAgyUsageImpl;
    let raw: string;
    try {
      raw = await scrape({ actorDir });
    } catch (err) {
      return {
        provider: "agy",
        status: "unknown",
        message: `agy /usage scrape failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // Stamp scrapedAt as soon as the scrape itself completes (ISSUE_NUM, ask 5) —
    // before the LLM parse, which is post-processing, not part of the scrape.
    const scrapedAt = this.scrapedAtNow();
    return this.parsePersistedScrape("agy", raw, scrapedAt, async () => {
      const apiKey = this.deps.config.geminiApiKey?.trim();
      if (apiKey) {
        const parsed = await parseAgyQuota(
          raw,
          apiKey,
          Date.parse(scrapedAt),
          this.configuredModelsFor("agy")
        );
        return {
          provider: "agy",
          status: parsed.status ?? "unknown",
          message: parsed.message,
          limits: parsed.limits,
          ...(parsed.extractionFailures ? { extractionFailures: parsed.extractionFailures } : {}),
          raw,
          scrapedAt,
        };
      }

      // If there is no API key, we just don't attempt to parse. We NEVER attempt to do any regex parsing of agy's TUI output, because it is not stable and will drift.
      // The only way to parse agy quota is via the LLM, which requires a geminiApiKey.
      return {
        status: "unknown",
        provider: "agy",
        message: "no geminiApiKey configured for LLM quota parsing",
        scrapedAt,
      };
    });
  }

  /**
   * Kimi uses rotating single-use refresh tokens, so rusa must never be an
   * OAuth consumer. Drive the real CLI through a host-side PTY and parse the
   * rendered `/usage` screen; the CLI remains the only credential reader/writer.
   */
  private async probeKimiQuota(actorDir: string): Promise<ProviderQuotaSnapshot> {
    const scrape = this.deps.scrapeKimiUsage ?? scrapeKimiUsageImpl;
    const apiKey = this.deps.config.geminiApiKey?.trim();
    if (!apiKey) {
      return {
        provider: "kimi",
        status: "unknown",
        message: "no geminiApiKey configured for LLM quota parsing",
      };
    }
    let raw: string;
    try {
      raw = await scrape({
        actorDir,
        geminiApiKey: apiKey,
        cliCommand: this.deps.config.providers?.kimi?.cliCommand,
      });
    } catch (err) {
      if (err instanceof KimiAuthRequiredError) {
        return {
          provider: "kimi",
          status: "unknown",
          message: "kimi CLI is not authenticated (login screen detected)",
        };
      }
      return {
        provider: "kimi",
        status: "unknown",
        message: `kimi /usage scrape failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const scrapedAt = this.scrapedAtNow();
    return this.parsePersistedScrape("kimi", raw, scrapedAt, async () => {
      const parsed = await parseKimiQuota(
        raw,
        apiKey,
        Date.parse(scrapedAt),
        this.configuredModelsFor("kimi")
      );
      return {
        provider: "kimi",
        status: parsed.status ?? "unknown",
        message: parsed.message,
        limits: parsed.limits,
        ...(parsed.extractionFailures ? { extractionFailures: parsed.extractionFailures } : {}),
        raw,
        scrapedAt,
      };
    });
  }
}

/** Construct a `QuotaService` — the shared probe+cache layer behind `get_quota`. */
export function createQuotaService(deps: QuotaMcpDeps): QuotaService {
  return new QuotaService(deps);
}

/**
 * `service` defaults to a fresh `QuotaService` built from `deps`, but callers
 * that also wire the dashboard's `/api/quota` endpoint  should pass in
 * their own shared instance so both surfaces read the same TTL cache instead
 * of probing independently.
 */
export function createQuotaMcpServer(
  deps: QuotaMcpDeps,
  service: QuotaService = createQuotaService(deps)
): McpServer {
  // §12 item 4 (#356): when a coordinator client is wired, get_quota reads
  // through GET /v1/quota and never reaches the local probe path. Both the
  // client and QuotaService answer an admitted-but-unconfigured provider with
  // `status: "unsupported"` themselves, so there is one dispatch seam here.
  const coordinatorClient = deps.coordinatorClient ?? null;

  const server = createMcpServer({ name: QUOTA_MCP_NAME, version: "0.1.0" });

  server.registerTool(
    "get_quota",
    {
      title: "Get provider quota status",
      description: "Query the current usage/quota status and reset time for a given provider.",
      inputSchema: {
        provider: z.enum(["claude", "codex", "agy", "kimi"]).describe("The provider to probe"),
      },
    },
    async ({ provider }) => {
      try {
        return toolOk(
          await (coordinatorClient
            ? coordinatorClient.getQuotaWithFallback(provider)
            : service.getQuota(provider))
        );
      } catch (err) {
        return toolError(err);
      }
    }
  );

  server.registerTool(
    "list_models",
    {
      title: "List scraped provider models",
      description:
        "List all known provider model catalogs scraped from CLI/TUI outputs, indicating display labels, identifiers, and whether each model is passable as a pin.",
      inputSchema: {
        provider: z.string().optional().describe("Optional provider name to filter by"),
      },
    },
    async ({ provider }) => {
      try {
        const formatEntries = (entries: readonly ModelEntry[]) =>
          entries.map((entry) => ({
            displayLabel: entry.displayLabel,
            identifier: entry.identifier,
            passable: entry.passable !== false,
            ...(entry.efforts ? { efforts: entry.efforts } : {}),
          }));

        if (provider) {
          const entries = getProviderModelCatalog(provider);
          return toolOk({
            [provider]: entries ? formatEntries(entries) : [],
          });
        }

        const all = getAllProviderModelCatalogs();
        const result: Record<
          string,
          Array<{ displayLabel: string; identifier: string; passable: boolean }>
        > = {};
        for (const [p, entries] of all.entries()) {
          result[p] = formatEntries(entries);
        }
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
