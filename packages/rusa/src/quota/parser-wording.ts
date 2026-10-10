import { createHash } from "node:crypto";
import type { QuotaLlmProvider } from "../mcp/quota-mcp.js";

/**
 * The provider-specific wording the quota parser sends, as built into this
 * release (#536). It is the only part of the parser prompt that is versioned
 * as a revision: the output-scope, percentage, reset, configured-model and
 * current-time contracts stay in the consuming code that enforces them. Each
 * entry is sent verbatim, so editing one changes the parser request bytes.
 */
export const BUILT_IN_QUOTA_PARSER_WORDING: Readonly<Record<QuotaLlmProvider, string>> = {
  claude:
    "For Claude: it will show session/week usage windows with percentage used and reset times (e.g. 'resets in 4 hours 12 minutes' or 'resets Jul 13, 2:59am (UTC)'). " +
    "Provider-wide session/week rows carry no `models` and alone determine status. " +
    "Named-model rows such as 'Current Week (Fable)' are model-specific: emit them with `models` set to the configured IDs for that model from the configured model list, and never use them to determine status. " +
    "If any provider-wide window is 100% used or the output says 'rate limit exceeded' or 'limit exceeded', " +
    "status is 'exhausted'.\n",
  codex:
    // A real reading has limit rows or an exhaustion banner. codex's /status
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
    "The pending-state rule applies only when no rendered provider-wide limit row or provider-wide exhaustion message appears anywhere in the capture.\n",
  agy:
    "For agy: locate the 'GEMINI MODELS' section, which has a Weekly Limit and a " +
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
    "If weekly limit is at 100% used (0% remaining), status is 'exhausted'.\n",
  kimi:
    "For Kimi: the interactive /usage panel shows Kimi Code platform quota, commonly including 5h/five-hour and weekly windows. " +
    "Kimi can print either 'N% used' or 'N% left/remaining'. Copy N into usedPercent for 'used' or into remainingPercent for 'left/remaining', never both " +
    "(e.g. '63% used' → usedPercent '63'; '0% left' → remainingPercent '0'; '88% left' → remainingPercent '88'). " +
    "Always use the numeric percentage text; never estimate from a progress bar. Provider-wide windows carry no `models` and alone determine status. " +
    "Every named-model or model-group limit is model-specific: emit it with `models` set to the matching IDs from the configured model list (rows matching nothing configured are omitted entirely), and never use it to determine status. " +
    "Extract every visible provider-wide quota window and set kind " +
    "to 'five_hour', 'weekly', 'session', or 'other'. If any provider window is 100% used (0% left), status is 'exhausted'. " +
    "If the screen is a login/auth/error state rather than a quota display, return status 'unknown' and no fabricated windows.\n",
};

/**
 * A wording revision is immutable and identified by its content: the same
 * provider and wording always hash to the same id, so registering the built-in
 * wording again on every open or parse is a no-op.
 */
export function quotaParserWordingRevisionId(provider: QuotaLlmProvider, wording: string): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify([provider, wording]))
    .digest("hex")}`;
}

/** The immutable revision to attribute to an attempted built-in parse. */
export interface QuotaParserWording {
  /** Null when the built-in revision record could not be read or written. */
  revisionId: string | null;
}

/** The in-code wording has no revision record when its control records fail. */
export function unattributedBuiltInParserWording(): QuotaParserWording {
  return { revisionId: null };
}
