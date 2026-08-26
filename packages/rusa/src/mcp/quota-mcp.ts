import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Type } from "@google/genai";
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
   * Scope of the limit. "provider" for provider-wide limits, "model" for model-specific limits.
   */
  scope?: "provider" | "model";
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
  usedPercent?: number;
  resetAtIso?: string;
  resetInIso?: string;
  placeholder?: boolean;
  scope?: "provider" | "model";
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
      type: Type.NUMBER,
      description: "Percentage of this window's quota used, 0-100. Omit when placeholder is true.",
    },
    resetAtIso: {
      type: Type.STRING,
      description:
        "ISO-8601 instant (with UTC offset) this window resets at, ONLY when you can confidently " +
        "resolve one from an absolute wall-clock/calendar reading (e.g. '23:32', '12:34 on 14 Jul', " +
        "'Jul 7th, 2026 12:25 PM') using the current local time given below. Leave this empty for a " +
        "pure relative duration (e.g. '70h 13m', '3h 10m', '2 days, 22 hours') — that is resolved " +
        "deterministically downstream, do not compute it yourself. Also leave it empty whenever the " +
        "date, year, or timezone is genuinely ambiguous — never guess an instant.",
    },
    resetInIso: {
      type: Type.STRING,
      description:
        "ISO-8601 duration until this window resets, ONLY when the source gives a pure relative " +
        "duration (e.g. '70h 13m' -> 'PT70H13M', '3h 10m' -> 'PT3H10M', " +
        "'2 days, 22 hours' -> 'P2DT22H'). Leave this empty for absolute/wall-clock/calendar " +
        "readings, ambiguous text, or when no reset duration is present.",
    },
    placeholder: {
      type: Type.BOOLEAN,
      description:
        "True when the source has NOT produced a usable number for this window yet (e.g. " +
        "codex's 'refresh requested; run /status again shortly'), as opposed to a real reading.",
    },
    scope: {
      type: Type.STRING,
      enum: ["provider", "model"],
      description:
        "Scope of this limit. 'provider' for a whole-account/provider-wide limit; 'model' for a limit tied to a specific model or model-group.",
    },
  },
  required: ["label", "kind", "placeholder", "scope"],
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

function validateParsedWindowsCompleteness(
  output: string,
  provider: "claude" | "codex" | "agy" | "kimi",
  realWindows: LlmQuotaWindow[]
): void {
  if (provider === "codex") {
    // When output contains rendered limit rows (5h limit: or Weekly limit:),
    // ensure realWindows does not drop them.
    const has5hLimit = /(?:^|\n|\r|\s)5h\s+limit\s*:/i.test(output);
    const hasWeeklyLimit = /(?:^|\n|\r|\s)Weekly\s+limit\s*:/i.test(output);

    if (has5hLimit) {
      const found = realWindows.some((w) => {
        const k = normalizeQuotaWindowKind(w.kind);
        return k === "five_hour" || k === "session" || /5h|five/i.test(w.label);
      });
      if (!found) {
        throw new Error(
          "Quota parse incomplete: raw output contains '5h limit:' but parsed windows omitted it"
        );
      }
    }

    if (hasWeeklyLimit) {
      const found = realWindows.some((w) => {
        const k = normalizeQuotaWindowKind(w.kind);
        return k === "weekly" || /weekly/i.test(w.label);
      });
      if (!found) {
        throw new Error(
          "Quota parse incomplete: raw output contains 'Weekly limit:' but parsed windows omitted it"
        );
      }
    }
  } else if (provider === "claude") {
    const hasSession = /(?:^|\n|\r|\s)(?:Current\s+session|Session\s+limit)\s*:/i.test(output);
    const hasWeekly = /(?:^|\n|\r|\s)(?:Current\s+week(?:\s+\([^)]+\))?|Weekly\s+limit)\s*:/i.test(
      output
    );

    if (hasSession) {
      const found = realWindows.some((w) => {
        const k = normalizeQuotaWindowKind(w.kind);
        return k === "session" || k === "five_hour" || /session/i.test(w.label);
      });
      if (!found) {
        throw new Error(
          "Quota parse incomplete: raw output contains session limit but parsed windows omitted it"
        );
      }
    }

    if (hasWeekly) {
      const found = realWindows.some((w) => {
        const k = normalizeQuotaWindowKind(w.kind);
        return k === "weekly" || /week/i.test(w.label);
      });
      if (!found) {
        throw new Error(
          "Quota parse incomplete: raw output contains weekly limit but parsed windows omitted it"
        );
      }
    }
  } else if (provider === "kimi") {
    const has5h = /(?:^|\n|\r|\s)5h\s+limit\b/i.test(output);
    const hasWeekly = /(?:^|\n|\r|\s)Weekly\s+limit\b/i.test(output);

    if (has5h) {
      const found = realWindows.some((w) => {
        const k = normalizeQuotaWindowKind(w.kind);
        return k === "five_hour" || k === "session" || /5h|five/i.test(w.label);
      });
      if (!found) {
        throw new Error(
          "Quota parse incomplete: raw output contains '5h limit' but parsed windows omitted it"
        );
      }
    }

    if (hasWeekly) {
      const found = realWindows.some((w) => {
        const k = normalizeQuotaWindowKind(w.kind);
        return k === "weekly" || /weekly/i.test(w.label);
      });
      if (!found) {
        throw new Error(
          "Quota parse incomplete: raw output contains 'Weekly limit' but parsed windows omitted it"
        );
      }
    }
  }
}

async function parseQuotaWithLlm(
  output: string,
  apiKey: string,
  provider: "claude" | "codex" | "agy" | "kimi"
): Promise<Partial<ProviderQuotaSnapshot>> {
  const client = getGeminiClient(apiKey);
  const isAgy = provider === "agy";
  const generatedAtMs = Date.now();

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

  const providerClause =
    provider === "claude"
      ? "For Claude: it will show session/week usage windows with percentage used and reset times (e.g. 'resets in 4 hours 12 minutes' or 'resets Jul 13, 2:59am (UTC)'). " +
        "If any provider-wide window is 100% used or the output says 'rate limit exceeded' or 'limit exceeded', " +
        "status is 'exhausted'. Set scope to 'provider'.\n"
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
          `If it contains "You've hit your usage limit" or "hit your usage limit", ` +
          "status is 'exhausted'; extract per-window (5h, Weekly) percentages and reset times (including from 'try again at <date/time>'). " +
          'KNOWN PENDING STATE: codex\'s /status can render "Limits: refresh requested; run /status again shortly" ' +
          '(or "run /status again") — codex\'s async-refresh placeholder, NOT a reading and NOT a parse error. ' +
          "When that placeholder is all that renders, return status='unknown' and windows=[] — do NOT guess a number, do NOT fail the parse, and do NOT emit an invented window for it. " +
          "Likewise, if the output contains none of the above — no limit rows, no exhaustion message, no refresh placeholder — return status='unknown' and windows=[]. " +
          "For standard 5h and Weekly limits, scope is 'provider'. " +
          "For specific model limits (e.g. GPT-5.3-Codex-Spark limit), scope is 'model'.\n"
        : provider === "agy"
          ? "For agy: locate the 'GEMINI MODELS' section, which has a Weekly Limit and a " +
            "Five Hour Limit window. " +
            "CRITICAL — unlike Claude/Codex, agy's TUI reports quota REMAINING, not used: " +
            "a window reads 'N% remaining' (and its progress bar shows the remaining fraction). " +
            "'usedPercent' must still be the USED percentage, so emit usedPercent = 100 - N " +
            "(e.g. '0.00% remaining' or '[░░░ …] 0.00%' → usedPercent 100; '3% remaining' → usedPercent 97; '48% remaining' → usedPercent 52). " +
            "A window showing 'Quota available' with a full (100%) bar is fully available: " +
            "emit usedPercent 0. If a window says 'Disabled: You have hit your weekly limit, the 5-hour limit does not currently apply. Your weekly limit will fully refresh in <duration>', " +
            "emit this window with usedPercent 100 (exhausted) and extract the reset duration, or if indeterminate emit with placeholder: true. " +
            'Emit the GEMINI MODELS Weekly Limit and Five Hour Limit at top level in `windows`, each with `scope: "provider"`. ' +
            "Omit every other section (e.g. CLAUDE AND GPT MODELS) from `windows` entirely. If weekly limit is at 100% used (0% remaining), status is 'exhausted'.\n"
          : "For Kimi: the interactive /usage panel shows Kimi Code platform quota with " +
            "progress bars and remaining percentages, commonly including 5h/five-hour and " +
            "weekly windows. CRITICAL — Kimi reports quota LEFT/REMAINING, not used: a " +
            "window reads 'N% left' or 'N% remaining'. 'usedPercent' must still be the USED " +
            "percentage, so emit usedPercent = 100 - N (e.g. '0% left' → usedPercent 100; " +
            "'88% left' → usedPercent 12; '50% left' → usedPercent 50). Extract every visible quota window and set kind " +
            "to 'five_hour', 'weekly', 'session', or 'other' with scope 'provider'. If any provider window is 100% used (0% left), status is 'exhausted'. " +
            "If the screen is a login/auth/error state rather than a quota display, return status 'unknown' and no fabricated windows.\n";
  const systemInstruction =
    "You are a precise quota parser. Analyze the raw CLI or TUI output of a provider's " +
    "usage/status check and extract the quota state.\n" +
    "Return a JSON object matching the schema.\n" +
    "GROUNDING REQUIREMENT: You MUST ONLY report windows and statuses that are physically printed in the provided output. " +
    "If the output contains ONLY a welcome banner, splash screen, prompt menu, login error, or does NOT contain rendered quota/status limit rows or an explicit exhaustion message, " +
    "you MUST return status='unknown' with windows=[]. NEVER invent, hallucinate, or assume 100% remaining / 0% used when quota limit information is absent from the text.\n" +
    providerClause +
    "The current local time — in the SAME timezone the TUI's clock is printed in (its " +
    `offset is included below) — is ${formatLocalIsoWithOffset(generatedAtMs)}. ` +
    "Use it to resolve wall-clock/calendar reset text (e.g. '23:32' means the next " +
    "occurrence of that time at or after now; '12:34 on 14 Jul' means that specific date/time at or after now; 'Jul 7th, 2026 12:25 PM'; a date without a year means the next " +
    "such date at or after now) into resetAtIso, assuming the same UTC offset unless " +
    "the source states otherwise. If the timezone, date, or year is genuinely ambiguous, " +
    "leave resetAtIso empty rather than guess — a wrong instant is worse than a missing one. " +
    "For pure relative reset durations (e.g. '70h 13m', '3h 10m', '2 days, 22 hours', 'in 4 hours 12 minutes'), do not compute resetAtIso; instead extract the " +
    "duration into resetInIso as a normalized ISO-8601 duration such as PT70H13M, " +
    "PT3H10M, PT4H12M, or P2DT22H.";

  const executeOnce = async (): Promise<Partial<ProviderQuotaSnapshot>> => {
    const response = await client.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: `Parse the following CLI/TUI output of a quota check for the provider '${provider}':\n\n${output}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties,
          required: ["status"],
        },
        systemInstruction,
      },
    });

    const text = await extractGeminiText(response);
    const parsed = JSON.parse(text);

    const result: Partial<ProviderQuotaSnapshot> = {
      status: parsed.status,
    };

    const realWindows = Array.isArray(parsed.windows)
      ? (parsed.windows as LlmQuotaWindow[]).filter(
          (w) => !w.placeholder && typeof w.usedPercent === "number"
        )
      : [];

    validateParsedWindowsCompleteness(output, provider, realWindows);

    const limits: QuotaLimit[] = [];
    for (const w of realWindows) {
      const percentLeft = 100 - (w.usedPercent as number);
      const resetAtIso = resolveResetAtIso(w.resetAtIso, w.resetInIso, generatedAtMs);

      // Fail-loud gate : Fail loud ONLY on windows with neither field AND percentLeft < 100.
      // Model-scope windows missing a reset are permitted when a provider-scope sibling of the
      // same kind in the same scrape provides a resolvable reset (copied downstream via sibling_window_copy).
      if (percentLeft < 100 && !resetAtIso) {
        const kind = normalizeQuotaWindowKind(w.kind);
        const hasSiblingProviderReset =
          w.scope === "model" &&
          kind !== undefined &&
          realWindows.some(
            (other) =>
              (other.scope === "provider" || other.scope === undefined) &&
              normalizeQuotaWindowKind(other.kind) === kind &&
              Boolean(resolveResetAtIso(other.resetAtIso, other.resetInIso, generatedAtMs))
          );

        if (!hasSiblingProviderReset) {
          throw new Error(
            `Quota parse failed: window '${w.label}' has percentLeft < 100 (${percentLeft}%) but no resolvable reset ISO`
          );
        }
      }

      limits.push({
        label: w.label,
        kind: normalizeQuotaWindowKind(w.kind),
        percentLeft,
        resetAtIso,
        scope: w.scope as "provider" | "model" | undefined,
      });
    }

    if (Array.isArray(parsed.windows)) {
      result.limits = limits;
    }

    return result;
  };

  try {
    return await executeOnce();
  } catch {
    try {
      return await executeOnce();
    } catch (secondErr) {
      console.error(`[quota-mcp] LLM quota parse failed:`, secondErr);
      return {
        status: "unknown",
        message: `LLM quota parsing failed: ${secondErr instanceof Error ? secondErr.message : String(secondErr)}`,
      };
    }
  }
}

export async function parseClaudeQuota(
  output: string,
  apiKey?: string
): Promise<Partial<ProviderQuotaSnapshot>> {
  // Ratified: parse TUI output with an LLM, not regex — TUIs drift. No-key = fail-closed unknown, never a regex guess.
  if (apiKey) {
    return parseQuotaWithLlm(output, apiKey, "claude");
  }
  return {
    status: "unknown",
    message: "no geminiApiKey configured for LLM quota parsing",
  };
}

export async function parseCodexQuota(
  output: string,
  apiKey?: string
): Promise<Partial<ProviderQuotaSnapshot>> {
  // Ratified: parse TUI output with an LLM, not regex — TUIs drift. No-key = fail-closed unknown, never a regex guess.
  if (apiKey) {
    return parseQuotaWithLlm(output, apiKey, "codex");
  }
  return {
    status: "unknown",
    message: "no geminiApiKey configured for LLM quota parsing",
  };
}

export async function parseAgyQuota(
  output: string,
  apiKey?: string
): Promise<Partial<ProviderQuotaSnapshot>> {
  // Ratified: parse TUI output with an LLM, not regex — TUIs drift. No-key = fail-closed unknown, never a regex guess.
  if (apiKey) {
    return parseQuotaWithLlm(output, apiKey, "agy");
  }
  return {
    status: "unknown",
    message: "no geminiApiKey configured for LLM quota parsing",
  };
}

export async function parseKimiQuota(
  output: string,
  apiKey: string
): Promise<Partial<ProviderQuotaSnapshot>> {
  // Ratified: parse new TUI output with an LLM, not regex — TUIs drift.
  return parseQuotaWithLlm(output, apiKey, "kimi");
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
  // carry forward previous assessment's active unexpired limits with non-assumed resetAtIso.
  if ((status === "unknown" || !limits || limits.length === 0) && prevState?.limits) {
    const activeUnexpiredLimits = prevState.limits.filter((limit) => {
      if (!limit.resetAtIso) return false;
      const resetMs = Date.parse(limit.resetAtIso);
      if (!Number.isFinite(resetMs) || resetMs <= scrapedAtMs) return false;
      return !isAssumedReset(prevState, limit.label);
    });

    if (activeUnexpiredLimits.length > 0) {
      status = prevState.status;
      limits = activeUnexpiredLimits.map((l) => ({ ...l }));
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
      if (limit.scope === "model" && !limit.resetAtIso && limit.kind) {
        const providerSibling = limits.find(
          (s) =>
            (s.scope === "provider" || s.scope === undefined) &&
            s.kind === limit.kind &&
            s.resetAtIso
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
  if (limits && limits.length > 0 && prevState?.limits) {
    for (const limit of limits) {
      if (limit.resetAtIso) continue;
      const prevMatch = prevState.limits.find(
        (p) =>
          (p.scope ?? "provider") === (limit.scope ?? "provider") &&
          (p.kind === limit.kind || p.label === limit.label) &&
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

  // Step 3b: Bad read missing-window fallback (Rule: carried_forward_bad_read)
  // The current parse extracted some windows, but completely omitted one or more window kinds
  // present in the previous scrape whose reset has not yet expired.
  if (limits && limits.length > 0 && prevState?.limits) {
    for (const prevLimit of prevState.limits) {
      if (!prevLimit.resetAtIso) continue;
      const resetMs = Date.parse(prevLimit.resetAtIso);
      if (!Number.isFinite(resetMs) || resetMs <= scrapedAtMs) continue;
      if (isAssumedReset(prevState, prevLimit.label)) continue;

      const alreadyPresent = limits.some(
        (cur) =>
          (cur.scope ?? "provider") === (prevLimit.scope ?? "provider") &&
          (cur.kind === prevLimit.kind || cur.label === prevLimit.label)
      );

      if (!alreadyPresent) {
        limits.push({ ...prevLimit });
        explanations.push({
          window: prevLimit.label,
          field: "resetAtIso",
          rule: "carried_forward_bad_read",
          detail: "carried forward previous unexpired window assessment omitted from current parse",
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
  private readonly inFlightProbes = new Map<string, Promise<ProviderQuotaSnapshot>>();

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
      return inferredState;
    } catch (error) {
      if (id) this.deps.scrapeStore?.recordParseError(id, error);
      if (prevState?.limits && prevState.limits.length > 0) {
        const hasUnexpired = prevState.limits.some(
          (l) =>
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
          return inferQuotaState(
            {
              provider,
              status: "unknown",
              scrapedAt,
              raw: rawOutput,
              message: `LLM quota parsing failed, preserving previous window assessment: ${error instanceof Error ? error.message : String(error)}`,
            },
            prevState,
            scrapedAt
          );
        }
      }
      throw error;
    }
  }

  private getTtlMs(provider: "claude" | "codex" | "agy" | "kimi"): number {
    if (this.deps.ttlMs !== undefined) {
      return this.deps.ttlMs;
    }
    switch (provider) {
      case "claude":
      case "agy":
        return 5 * 60 * 1000; // ~5 minutes
      case "codex":
        // Keep 30 minutes for codex due to placeholder responses on fast status requests.
        // Tracked in ISSUE_NUM, must not lower this until codex placeholder-handling lands.
        return 30 * 60 * 1000;
      case "kimi":
        // Was 60s from when the /usage pty scrape ran ~51s (only ~9s of useful
        // freshness → retries kept stalling). The panel-anchored scrape
        // is now ~8s, and kimi's windows are 5h/weekly — no need for sub-minute
        // freshness. Match claude/agy at 5min so the (expensive) pty scrape
        // isn't re-run every minute.
        return 5 * 60 * 1000; // ~5 minutes
    }
  }

  /**
   * Get the current quota state for a provider, served from cache when fresh.
   * Concurrent calls for the same provider share one in-flight probe. This is
   * the ONLY entry point that may trigger a probe — callers (the MCP tool, the
   * dashboard endpoint) never probe directly.
   */
  async getQuota(provider: "claude" | "codex" | "agy" | "kimi"): Promise<ProviderQuotaSnapshot> {
    if (!this.configuredProviders.has(provider)) {
      return {
        provider,
        status: "unsupported",
        message: `${provider} is not configured on this instance`,
      };
    }
    const now = Date.now();
    const cached = this.cache.get(provider);
    const ttl = this.getTtlMs(provider);
    if (cached && now - cached.timestamp < ttl) {
      return cached.state;
    }

    let inFlight = this.inFlightProbes.get(provider);
    if (!inFlight) {
      inFlight = this.executeProbe(provider).finally(() => {
        this.inFlightProbes.delete(provider);
      });
      this.inFlightProbes.set(provider, inFlight);
    }

    const state = await inFlight;
    if (state.status !== "unknown" || !cached || cached.state.status === "unknown") {
      this.cache.set(provider, { state, timestamp: Date.now() });
    }
    return state;
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
    const isFresh = cached && Date.now() - cached.timestamp < this.getTtlMs(provider);
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
      const apiKey = this.deps.config.geminiApiKey?.trim();

      if (!apiKey) {
        return {
          provider: "claude",
          status: "unknown",
          message: "no geminiApiKey configured for LLM quota parsing",
          scrapedAt,
        };
      }
      const parsed = await parseClaudeQuota(output, apiKey);
      return {
        provider: "claude",
        status: parsed.status || "unknown",
        message: parsed.message,
        limits: parsed.limits,
        raw: output,
        scrapedAt,
      };
    });
  }

  /**
   * Codex has no quiet quota API — its remaining-quota numbers live only in the
   * interactive `/status` TUI. Rent a host-side PTY (tmux), scrape the panel, and
   * parse it deterministically . Read-only `/status` never mutates auth
   * (never `/usage`, which consumes a reset), so this is auth-safe by construction.
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
      const parsed = await parseCodexQuota(raw, apiKey);
      return {
        provider: "codex",
        status: parsed.status ?? "unknown",
        message: parsed.message,
        limits: parsed.limits,
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
        const parsed = await parseAgyQuota(raw, apiKey);
        return {
          provider: "agy",
          status: parsed.status ?? "unknown",
          message: parsed.message,
          limits: parsed.limits,
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
      const parsed = await parseKimiQuota(raw, apiKey);
      return {
        provider: "kimi",
        status: parsed.status ?? "unknown",
        message: parsed.message,
        limits: parsed.limits,
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
  service: QuotaService = createQuotaService(deps),
  options?: { isFenced?: () => boolean }
): McpServer {
  const server = createMcpServer(
    { name: QUOTA_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );

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
        return toolOk(await service.getQuota(provider));
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
