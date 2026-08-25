import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import {
  type CommitmentClaimInput,
  type CommitmentClaimSource,
  type CommitmentPolarityEvaluator,
  type CommitmentPolarityVerdict,
  evaluateClaims,
} from "./commitment-polarity.js";
import type { iuReportPaths } from "./persistence-utils.js";

/**
 * The IU distiller's **nightly-report producer**  — the write half of the
 * run-journal → rendered-markdown → `index.json` arc whose read half is the
 * dashboard "IU Reports" tab + `dashboard/iu-reports-api.ts`. The distilling actor
 * runs sandboxed (`~/.rusa` read-only, MCPs host-routed), so emission is
 * host-side through the distiller MCP (`distill_journal_append` +
 * `distill_report_render`); this module holds the deterministic logic those tools
 * call. The path/format contract is fixed in
 * `devlog/2026-06-27-integrated-understanding/reports-contract.md` and the shapes
 * the consumer reads live in {@link iuReportPaths}. Journals + rendered reports are
 * IU *content* (they quote cross-repo/chat/mesh material) and therefore live
 * instance-side beside the IU store — NEVER committed to the rusa repo.
 */

const sourceSchema = z.object({
  kind: z.enum([
    "git_commit",
    "github_pr",
    "github_issue",
    "github_issue_comment",
    "github_pr_review_comment",
    "github_pr_review",
    "mesh_event",
    // A Google Chat message from a space in the configured read set .
    // `ref` is the message resource name (`spaces/AAA/messages/XYZ`) so the
    // citation stays resolvable back to the space it came from — which is what
    // makes a wrongly-listed space removable later .
    "chat_message",
  ]),
  ref: z.string(),
  sha: z.string().nullable().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  excerpt: z.string().optional(),
  note: z.string().optional(),
});

const nodeOpSchema = z.object({
  op: z.enum([
    "create",
    "update_contents",
    "update_title",
    "add_relationship",
    "remove_relationship",
    "archive",
    "splice",
  ]),
  node_id: z.string(),
  node_title: z.string(),
  mode: z.string().optional(),
  summary: z.string(),
  supersedes: z.string().optional(),
});

const countsSchema = z.object({
  decisions: z.number(),
  distilled: z.number(),
  adjudicated_away: z.number(),
  skipped: z.number(),
  deferred: z.number(),
  nodes_touched: z.number(),
  iu_hints: z.number(),
});

/** `run_meta` — exactly one per run, the model appends it first (lands at seq 0). */
const runMetaBodySchema = z.object({
  type: z.literal("run_meta"),
  window: z.object({ from: z.string(), to: z.string(), includesMesh: z.boolean() }),
  gate: z.object({ active: z.boolean(), eventCount: z.number() }),
  cursor_before: z.string(),
  mode: z.string().optional(),
  distiller_actor: z.string(),
  runbook_ref: z.string().optional(),
});

/** `decision` — the core auditable unit; N per run. */
const decisionBodySchema = z.object({
  type: z.literal("decision"),
  theme: z.string(),
  disposition: z.enum(["distilled", "adjudicated_away", "skipped", "deferred"]),
  sources: z.array(sourceSchema).default([]),
  node_ops: z.array(nodeOpSchema).default([]),
  conclusion: z.string(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
  confidence_reason: z.string().optional(),
  skip_reason: z.string().optional(),
});

/**
 * One space's chat walk . `exhausted` is the honest completion signal:
 * the walk stops when a bounded page comes back with no `nextPageToken`, which
 * is a measured property of the API rather than an inference from a short page.
 * A walk that stopped for any other reason (page ceiling, a repeated token, an
 * empty page still carrying one) is `exhausted: false` and says why in `note`.
 */
const chatSpaceCoverageSchema = z.object({
  space: z.string(),
  pagesWalked: z.number(),
  messagesRead: z.number(),
  exhausted: z.boolean(),
  note: z.string().optional(),
});

/**
 * The GitHub index read's coverage . The failure mode here is not chat's —
 * an unread space — but a read that *ran* and came back short. `gh search --updated
 * <from>..<to>` filters on the item's **current** `updatedAt`, not on whether the
 * item was touched during the window, so anything touched again after the window
 * ends leaves the range and vanishes from the window in which the work happened.
 * That loses precisely the busiest items, and the output is indistinguishable from
 * a genuinely short window: no error, no count, just fewer rows.
 *
 * So the thing a report can actually check is **which qualifiers ran**. `created`
 * is the one that makes it a window query at all — an item's creation time cannot
 * be invalidated by a later edit — and `closed` catches decisions, since a close is
 * a ruling the distiller must not miss.
 */
const githubCoverageSchema = z
  .object({
    /** The `gh search` time qualifiers this run used, e.g. `["created", "updated", "closed"]`. */
    qualifiers: z.array(z.string()),
    repos: z.array(z.string()),
    note: z.string(),
  })
  .partial();

/** `run_summary` — exactly one per run, appended last. */
const runSummaryBodySchema = z.object({
  type: z.literal("run_summary"),
  cursor_after: z.string(),
  advanced: z.boolean(),
  gap: z.object({ from: z.string(), to: z.string() }).nullable().default(null),
  counts: countsSchema.partial().optional(),
  sync: z
    .object({ unsyncedCount: z.number(), consecutiveFailures: z.number() })
    .partial()
    .optional(),
  iu_hint_coverage: z
    .object({ complete: z.boolean(), eventsScanned: z.number(), note: z.string() })
    .partial()
    .optional(),
  chat_coverage: z
    .object({
      // Kept as `configured_spaces` for wire and index-key stability, but since
      // ISSUE_NUM it carries the *enumerated membership* size, not an allowlist
      // length: the size of `distill_status.chatSpaces.spaces` when its status
      // was `enumerated`. Omit it when the status was anything else — a run that
      // could not enumerate must not report a number here.
      configured_spaces: z.number(),
      spaces: z.array(chatSpaceCoverageSchema),
      note: z.string(),
    })
    .partial()
    .optional(),
  github_coverage: githubCoverageSchema.optional(),
  report_path: z.string().optional(),
});

/**
 * The model-supplied journal entry body (WITHOUT the host-stamped envelope fields
 * `v` / `run_id` / `seq` / `ts`, which the host owns so they are never model-authored).
 */
export const journalEntryBodySchema = z.discriminatedUnion("type", [
  runMetaBodySchema,
  decisionBodySchema,
  runSummaryBodySchema,
]);
export type JournalEntryBody = z.infer<typeof journalEntryBodySchema>;

export type IuReportPaths = ReturnType<typeof iuReportPaths>;

/** A parsed journal line as read back from disk — defensively optional for render. */
type JournalLine = {
  v?: number;
  type?: string;
  run_id?: string;
  seq?: number;
  ts?: string;
} & Record<string, unknown>;

export interface AppendResult {
  seq: number;
  date: string;
  journalPath: string;
  relJournalPath: string;
}

export interface RenderResult {
  date: string;
  runId: string;
  reportPath: string;
  relReportPath: string;
  relJournalPath: string;
  status: "complete" | "partial";
  counts: Record<string, number>;
  indexPath: string;
  runsInIndex: number;
}

export interface IndexRun {
  date: string;
  run_id: string;
  windowFrom: string;
  windowTo: string;
  journalPath: string;
  reportPath: string;
  status: "complete" | "partial";
  counts: Record<string, number>;
  generatedAt: string;
}

export interface ReportIndex {
  v: 1;
  runs: IndexRun[];
}

/**
 * Derive the file key (UTC calendar date of the window end) from a
 * `"<from>__<to>"` run id. Falls back to the raw second half if it does not parse
 * as a date, so a malformed id still yields a stable, unique key.
 */
export function dateKeyFromRunId(runId: string): string {
  const to = runId.includes("__") ? runId.slice(runId.indexOf("__") + 2) : runId;
  const d = new Date(to);
  if (Number.isNaN(d.getTime())) return to.replace(/[^0-9A-Za-z_-]/g, "-");
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve the journal file for a run, keyed by its window-end date. A same-date
 * re-run (rare backfill / off-cycle) whose `run_id` differs from the one already
 * occupying `<date>.jsonl` suffixes the key (`-2`, `-3`, …). Resolution is
 * stateless: it scans candidate files for the one whose first line's `run_id`
 * matches; with `create`, an unmatched run takes the first free slot.
 */
export function resolveRunFile(
  paths: IuReportPaths,
  runId: string,
  opts: { create: boolean }
): { date: string; journalPath: string } {
  const base = dateKeyFromRunId(runId);
  for (let i = 1; i <= 50; i++) {
    const date = i === 1 ? base : `${base}-${i}`;
    const journalPath = paths.journalPath(date);
    if (!existsSync(journalPath)) {
      if (opts.create) return { date, journalPath };
      continue;
    }
    const firstRunId = firstRunIdOf(journalPath);
    if (firstRunId === runId || firstRunId === null) return { date, journalPath };
  }
  throw new Error(
    `could not resolve a journal file for run ${runId} (too many same-date collisions)`
  );
}

function firstRunIdOf(journalPath: string): string | null {
  try {
    const first = readFileSync(journalPath, "utf-8")
      .split("\n")
      .find((l) => l.trim().length > 0);
    if (!first) return null;
    const parsed = JSON.parse(first) as JournalLine;
    return typeof parsed.run_id === "string" ? parsed.run_id : null;
  } catch {
    return null;
  }
}

function readLines(journalPath: string): JournalLine[] {
  if (!existsSync(journalPath)) return [];
  return readFileSync(journalPath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as JournalLine);
}

/**
 * Append one journal entry at decision time. The host owns the envelope: `v` is
 * pinned to 1, `seq` is the next monotonic index (line count in the run's file),
 * and `ts` is the host append time — the model never authors any of them.
 */
export function appendJournalEntry(
  paths: IuReportPaths,
  runId: string,
  body: JournalEntryBody,
  opts: { now: string }
): AppendResult {
  const { date, journalPath } = resolveRunFile(paths, runId, { create: true });
  mkdirSync(paths.journalDir, { recursive: true });
  const seq = readLines(journalPath).length;
  const { type, ...rest } = body;
  const line = { v: 1, type, run_id: runId, seq, ts: opts.now, ...rest };
  appendFileSync(journalPath, `${JSON.stringify(line)}\n`);
  return { seq, date, journalPath, relJournalPath: `journal/${date}.jsonl` };
}

// ---- Rendering (pure projection over a run's journal lines) ----

/**
 * The run's summary line. The journal is append-only, so a run that corrects
 * itself does so by appending a second `run_summary` — the LAST one is the
 * current one . Reading the first would render a correction as if it had
 * never been made.
 */
function lastRunSummary(entries: JournalLine[]): JournalLine | undefined {
  return entries.filter((e) => e.type === "run_summary").at(-1);
}

function headerLine(entries: JournalLine[]): string {
  const meta = entries.find((e) => e.type === "run_meta");
  const summary = lastRunSummary(entries);
  const window = (meta?.window ?? {}) as { from?: string; to?: string; includesMesh?: boolean };
  const gate = (meta?.gate ?? {}) as { active?: boolean; eventCount?: number };
  const parts: string[] = [];
  if (window.from && window.to) parts.push(`window ${window.from} → ${window.to}`);
  if (typeof gate.active === "boolean") {
    parts.push(
      `gate ${gate.active ? "active" : "idle"}${gate.eventCount != null ? ` (${gate.eventCount} events)` : ""}`
    );
  }
  const cursorBefore = meta?.cursor_before as string | undefined;
  const cursorAfter = summary?.cursor_after as string | undefined;
  if (cursorBefore || cursorAfter)
    parts.push(`cursor ${cursorBefore ?? "?"} → ${cursorAfter ?? "?"}`);
  const sync = (summary?.sync ?? {}) as { unsyncedCount?: number };
  if (meta?.mode) {
    parts.push(`mode ${String(meta.mode)}`);
  } else if (summary && sync.unsyncedCount !== undefined) {
    parts.push("mode live");
  }
  if (window.includesMesh != null)
    parts.push(`mesh ${window.includesMesh ? "included" : "excluded"}`);
  return parts.join(" · ");
}

function renderSource(s: Record<string, unknown>): string {
  const ref = typeof s.ref === "string" ? s.ref : "(no ref)";
  const kind = typeof s.kind === "string" ? s.kind : "source";
  let line = `  - \`${ref}\` (${kind})`;
  if (typeof s.title === "string" && s.title) line += ` — ${s.title}`;
  if (typeof s.author === "string" && s.author) {
    const excerpt = typeof s.excerpt === "string" && s.excerpt ? `: "${s.excerpt}"` : "";
    line += ` — @${s.author}${excerpt}`;
  } else if (typeof s.note === "string" && s.note) {
    line += ` — ${s.note}`;
  }
  return line;
}

function renderNodeOp(op: Record<string, unknown>): string {
  const title =
    typeof op.node_title === "string" ? op.node_title : ((op.node_id as string) ?? "(node)");
  const kind = typeof op.op === "string" ? op.op : "op";
  const mode = typeof op.mode === "string" && op.mode ? `, ${op.mode}` : "";
  const summary = typeof op.summary === "string" ? op.summary : "";
  const supersedes =
    typeof op.supersedes === "string" && op.supersedes ? ` _(supersedes: ${op.supersedes})_` : "";
  return `  - **${title}** (${kind}${mode})${summary ? ` — ${summary}` : ""}${supersedes}`;
}

// ---- Commitment-claim polarity check  ----

/**
 * One high-confidence commitment claim, after the semantic evaluator has read it
 * against its own cited sources.
 *
 * `verdict` is three-state and the third state is the point : `unknown`
 * means the check ran and could not decide, which is neither a flag nor a pass.
 * Folding it into either direction is the defect this whole section exists to
 * catch, one level up.
 */
export interface CommitmentClaimCheck {
  theme: string;
  verdict: "flagged" | "clear" | "unknown";
  reason?:
    | "no_quoted_source"
    | "source_contradicts_claim"
    | "commitment_undetermined"
    | "polarity_undetermined";
  detail?: string;
}

/**
 * The section-level result. `status: "unavailable"` is not an empty result set —
 * it means the evaluator was not configured on this host, so nothing was checked
 * and `candidates` decisions went unread. Rendering that as "no flags" would be
 * concluding clean from a check that never ran.
 */
export interface CommitmentCheckReport {
  status: "evaluated" | "unavailable";
  reason?: string;
  candidates: number;
  checks: CommitmentClaimCheck[];
}

function commitmentCandidates(
  entries: JournalLine[]
): { theme: string; input: CommitmentClaimInput }[] {
  const out: { theme: string; input: CommitmentClaimInput }[] = [];
  for (const e of entries) {
    if (e.type !== "decision" || e.confidence !== "high") continue;
    const theme = typeof e.theme === "string" && e.theme ? e.theme : "(untitled)";
    const conclusion = typeof e.conclusion === "string" ? e.conclusion : "";
    const rawSources = Array.isArray(e.sources) ? (e.sources as Record<string, unknown>[]) : [];
    const sources: CommitmentClaimSource[] = [];
    for (const s of rawSources) {
      const excerpt = typeof s.excerpt === "string" ? s.excerpt.trim() : "";
      if (!excerpt) continue;
      sources.push({ ref: typeof s.ref === "string" && s.ref ? s.ref : "(no ref)", excerpt });
    }
    out.push({ theme, input: { theme, conclusion, sources } });
  }
  return out;
}

function checkFromVerdict(
  theme: string,
  input: CommitmentClaimInput,
  verdict: CommitmentPolarityVerdict
): CommitmentClaimCheck | null {
  // Not a commitment claim at all — the ISSUE_NUM failure mode cannot apply, so it is
  // not a candidate rather than a passing one.
  if (verdict.assertsCommitment === "no") return null;

  if (verdict.assertsCommitment === "unknown") {
    return {
      theme,
      verdict: "unknown",
      reason: "commitment_undetermined",
      detail:
        verdict.detail ??
        "the evaluator could not tell whether this states a settled outcome or a proposal",
    };
  }

  // Asserts a commitment at high confidence and quotes nothing: the check could
  // not run against a source, and an unverifiable claim is a first-class flag
  // rather than a silent skip.
  if (input.sources.length === 0) {
    return {
      theme,
      verdict: "flagged",
      reason: "no_quoted_source",
      detail:
        "asserts a commitment at high confidence with no quoted excerpt to check it against — the polarity check could not run",
    };
  }

  if (verdict.sourcePolarity === "contradicts") {
    const where = verdict.ref ? `cited source \`${verdict.ref}\`` : "a cited source";
    const why = verdict.detail ? ` ${verdict.detail}` : "";
    return {
      theme,
      verdict: "flagged",
      reason: "source_contradicts_claim",
      detail: `${where} may say the opposite:${why} — "${verdict.quote ?? ""}"`,
    };
  }

  if (verdict.sourcePolarity === "unknown") {
    return {
      theme,
      verdict: "unknown",
      reason: "polarity_undetermined",
      detail:
        verdict.detail ?? "the evaluator could not decide what the cited sources say about it",
    };
  }

  return { theme, verdict: "clear" };
}

/**
 * The ISSUE_NUM control, run over a rendered run: for every high-confidence decision
 * that asserts something was *settled*, read its own cited excerpts and say
 * whether they support it, contradict it, or cannot settle the question.
 *
 * This is a semantic read by a cheap model , not a lexical one. The lexical
 * version it replaced could not distinguish "the proposal was adopted" from
 * "adopting the proposal was declined" except by a token-proximity window, and a
 * refusal phrased without any of its listed tokens was invisible to it.
 *
 * It stays inside the "no new judgment" contract: it points a human at a sentence
 * and never re-decides a disposition, edits a conclusion, or changes a confidence.
 * A flag is a pointer, not a verdict.
 */
export async function checkCommitmentClaims(
  entries: JournalLine[],
  evaluate: CommitmentPolarityEvaluator | undefined
): Promise<CommitmentCheckReport> {
  const candidates = commitmentCandidates(entries);
  if (!evaluate) {
    return {
      status: "unavailable",
      reason:
        "no semantic evaluator is configured on this host (geminiApiKey unset), so no claim was checked",
      candidates: candidates.length,
      checks: [],
    };
  }
  const verdicts = await evaluateClaims(
    candidates.map((c) => c.input),
    evaluate
  );
  const checks: CommitmentClaimCheck[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const check = checkFromVerdict(candidates[i].theme, candidates[i].input, verdicts[i]);
    if (check) checks.push(check);
  }
  return { status: "evaluated", candidates: candidates.length, checks };
}

function renderCommitmentCheck(report: CommitmentCheckReport): string[] {
  const out = ["## Commitment claims (polarity check)", ""];
  if (report.status === "unavailable") {
    out.push(
      `**Not run** — ${report.reason ?? "the semantic evaluator was unavailable"}. ${report.candidates} high-confidence decision(s) went unchecked; that is unknown, not clean.`,
      ""
    );
    return out;
  }
  const flagged = report.checks.filter((c) => c.verdict === "flagged");
  const unknown = report.checks.filter((c) => c.verdict === "unknown");
  if (report.checks.length === 0) {
    out.push(
      `_No high-confidence commitment claims this run (${report.candidates} high-confidence decision(s) read)._`,
      ""
    );
    return out;
  }
  if (flagged.length === 0 && unknown.length === 0) {
    out.push(
      `_${report.checks.length} high-confidence commitment claim(s) read against their own quoted sources; none contradicted._`,
      ""
    );
    return out;
  }
  if (flagged.length > 0) {
    out.push(
      `**${flagged.length} of ${report.checks.length} high-confidence commitment claim(s) need a human re-read.** A pointer at a sentence, not a verdict — it does not re-decide anything.`,
      ""
    );
    for (const c of flagged) out.push(`- **${c.theme}** — ${c.detail}`);
    out.push("");
  }
  if (unknown.length > 0) {
    out.push(
      `**${unknown.length} claim(s) could not be judged** — neither flagged nor cleared. Read these yourself; the check declining to answer is not a pass.`,
      ""
    );
    for (const c of unknown) out.push(`- **${c.theme}** — ${c.detail}`);
    out.push("");
  }
  return out;
}

/**
 * Render a run's journal into the human-readable nightly markdown report. A
 * deterministic projection — no new judgment, pure formatting — with the four
 * contract sections: what was learned, what was deliberately left out (never
 * omitted, even when empty — the ISSUE_NUM blind-spot surface), the commitment-claim
 * polarity check (ISSUE_NUM, likewise never omitted — a check that is silent when it
 * passes is indistinguishable from a check that did not run), and the run footer.
 *
 * The polarity check is the one non-deterministic input, so it is performed by
 * {@link checkCommitmentClaims} and passed IN rather than run here: the render
 * stays a pure function of (journal, check report), and the same report feeds the
 * markdown and `index.json` instead of being evaluated twice with two answers.
 */
export function renderReportMarkdown(
  entries: JournalLine[],
  commitment: CommitmentCheckReport
): string {
  const meta = entries.find((e) => e.type === "run_meta");
  const summary = lastRunSummary(entries);
  const decisions = entries.filter((e) => e.type === "decision");
  const distilled = decisions.filter((d) => d.disposition === "distilled");
  const leftOut = decisions.filter((d) => d.disposition !== "distilled");

  const windowTo = (meta?.window as { to?: string } | undefined)?.to;
  const heading = windowTo ? dateKeyFromRunId(`__${windowTo}`) : "unknown window";
  const out: string[] = [`# IU Distill — ${heading}`, ""];
  const header = headerLine(entries);
  if (header) out.push(`_${header}_`, "");

  out.push("## What the IU learned", "");
  if (distilled.length === 0) {
    out.push("_Nothing distilled this run._", "");
  } else {
    for (const d of distilled) {
      out.push(`### ${d.theme ?? "(untitled)"}`, "");
      if (d.conclusion) out.push(String(d.conclusion), "");
      if (d.confidence) {
        const reason = d.confidence_reason ? ` — ${String(d.confidence_reason)}` : "";
        out.push(`- Confidence: **${String(d.confidence)}**${reason}`);
      }
      const nodeOps = Array.isArray(d.node_ops) ? (d.node_ops as Record<string, unknown>[]) : [];
      if (nodeOps.length > 0) {
        out.push("- Nodes touched:");
        for (const op of nodeOps) out.push(renderNodeOp(op));
      }
      const sources = Array.isArray(d.sources) ? (d.sources as Record<string, unknown>[]) : [];
      if (sources.length > 0) {
        out.push("- Sources:");
        for (const s of sources) out.push(renderSource(s));
      }
      out.push("");
    }
  }

  out.push("## Deliberately left out", "");
  if (leftOut.length === 0) {
    out.push("_Nothing skipped this run._", "");
  } else {
    for (const d of leftOut) {
      const why = d.skip_reason ?? d.conclusion ?? "";
      out.push(`- **${d.theme ?? "(untitled)"}** (${String(d.disposition)}): ${String(why)}`);
    }
    out.push("");
  }

  out.push(...renderCommitmentCheck(commitment));

  out.push("## Run summary", "");
  const counts = countsOf(entries, commitment);
  out.push(
    `- Decisions: ${counts.decisions} (distilled ${counts.distilled} · adjudicated_away ${counts.adjudicated_away} · skipped ${counts.skipped} · deferred ${counts.deferred})`
  );
  out.push(
    `- Nodes touched: ${counts.nodes_touched} · node ops: ${counts.node_ops} · IU-hints: ${counts.iu_hints}`
  );
  const sync = summary?.sync as
    | { unsyncedCount?: number; consecutiveFailures?: number }
    | undefined;
  if (sync) {
    // Both fields are `.partial()`, so absent is not zero — rendering `?? 0`
    // turned "never measured" into a clean bill of health .
    const unsynced = typeof sync.unsyncedCount === "number" ? sync.unsyncedCount : "unknown";
    const failures =
      typeof sync.consecutiveFailures === "number" ? sync.consecutiveFailures : "unknown";
    out.push(`- Sync: unsynced ${unsynced} · consecutive failures ${failures}`);
  }
  const cov = summary?.iu_hint_coverage as
    | { complete?: boolean; eventsScanned?: number; note?: string }
    | undefined;
  if (cov) {
    const note = cov.note ? ` — ${cov.note}` : "";
    out.push(
      `- IU-hint coverage: ${cov.complete ? "complete" : "partial"} (scanned ${cov.eventsScanned ?? "?"})${note}`
    );
  }
  out.push(...renderGithubCoverage(summary));
  out.push(...renderChatCoverage(summary));
  if (summary) {
    const gap = summary.gap as { from?: string; to?: string } | null | undefined;
    const gapStr = gap ? ` · gap ${gap.from} → ${gap.to}` : "";
    out.push(
      `- Cursor advanced: ${summary.advanced ? "yes" : "no"} → ${String(summary.cursor_after ?? "?")}${gapStr}`
    );
  }
  out.push("");
  return out.join("\n");
}

/** `created` is what makes the read a window query; `closed` is what catches rulings. */
const GITHUB_WINDOW_QUALIFIER = "created";
const GITHUB_DECISION_QUALIFIER = "closed";

/**
 * Accept both `created` and `--created` — a run writing its own summary has no
 * reason to guess which form the report wants, and a mismatch here would silently
 * report a complete read as narrow. Done with string ops rather than a pattern:
 * new regexes need Operator's express approval.
 */
function normalizeGithubQualifiers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is string => typeof q === "string")
    .map((q) => {
      let s = q.trim().toLowerCase();
      while (s.startsWith("-")) s = s.slice(1);
      return s;
    })
    .filter((q) => q.length > 0);
}

/**
 * GitHub source coverage , and like chat it is **never omitted** — for the
 * same reason: silence about a source the distiller always reads is ambiguous in
 * the dangerous direction.
 *
 * What this line exists to catch is narrower and nastier than an unread source. A
 * `--updated`-only sweep succeeds, returns rows, and is short by exactly the items
 * that were touched again after the window closed. Nothing downstream can detect
 * that from the results, because the missing rows never existed to be counted. The
 * qualifier set is the one part of the read that *is* checkable after the fact, so
 * a run that ran `--updated` alone is reported as having read a **narrower scope
 * than it claims**, not as having read GitHub.
 */
function renderGithubCoverage(summary: JournalLine | undefined): string[] {
  const cov = summary?.github_coverage as
    | { qualifiers?: string[]; repos?: string[]; note?: string }
    | undefined;
  if (!cov) {
    return [
      "- GitHub coverage: **not reported** — this run did not say which `gh search` time qualifiers it ran. Treat as unknown: a `--updated`-only read is short by whatever was touched after the window closed, and says so nowhere .",
    ];
  }
  const note = cov.note ? ` — ${cov.note}` : "";
  const qualifiers = normalizeGithubQualifiers(cov.qualifiers);
  if (qualifiers.length === 0) {
    return [
      `- GitHub coverage: **no qualifiers reported** — the run supplied a coverage block but named no time qualifier, so what the index read could have found is unknown.${note}`,
    ];
  }
  const repos = Array.isArray(cov.repos) && cov.repos.length > 0 ? cov.repos.join(", ") : undefined;
  const scope = repos ? ` over ${repos}` : "";
  const list = qualifiers.map((q) => `\`--${q}\``).join(" + ");
  const missing: string[] = [];
  if (!qualifiers.includes(GITHUB_WINDOW_QUALIFIER)) {
    missing.push(
      "without `--created` an item touched again after the window end is invisible, so this is **not a window query**"
    );
  }
  if (!qualifiers.includes(GITHUB_DECISION_QUALIFIER)) {
    missing.push("without `--closed` a decision made by closing an item can be missed");
  }
  const verdict =
    missing.length === 0
      ? "window-complete for the index read"
      : `**narrower than the window**: ${missing.join("; ")}`;
  return [`- GitHub coverage: ${list}${scope} — ${verdict} .${note}`];
}

export interface ChatSpaceCoverage {
  space: string;
  pagesWalked?: number;
  messagesRead?: number;
  exhausted?: boolean;
  note?: string;
}

/**
 * Chat source coverage , and it is **never omitted** — that is the whole
 * point of the section.
 *
 * `iu_hint_coverage` above renders only when supplied, which is safe for a source
 * the distiller always reads. Chat is different: silence about it is ambiguous in
 * the dangerous direction — a missing line would be read as "nothing to report"
 * when it equally means "read no chat" or "never looked". So a run that says
 * nothing is reported as **unknown**, a run whose read set was empty states that
 * chat was outside it, and a run that did read states the scope it read — never a
 * bare "chat: covered".
 *
 * The read set is now every space the Chat identity is a member of, enumerated per
 * run rather than configured , so `configured_spaces` is a measurement of
 * membership. That closes the "a space nobody listed is invisible" hole, but not
 * this one: a run still has to say how much of that membership it actually walked.
 */
function renderChatCoverage(summary: JournalLine | undefined): string[] {
  const cov = summary?.chat_coverage as
    | { configured_spaces?: number; spaces?: ChatSpaceCoverage[]; note?: string }
    | undefined;
  if (!cov) {
    return [
      "- Chat coverage: **not reported** — this run did not say whether chat was read. Treat as unknown, not as an absence of chat activity.",
    ];
  }
  const note = cov.note ? ` — ${cov.note}` : "";
  const configured = cov.configured_spaces;
  const spaces = Array.isArray(cov.spaces) ? cov.spaces : [];
  if (configured === 0 || (configured === undefined && spaces.length === 0)) {
    return [
      `- Chat coverage: **chat was not in this run's read set** (${configured ?? 0} spaces in membership). Anything decided only in chat is invisible to this run — see ISSUE_NUM.${note}`,
    ];
  }
  const scope =
    typeof configured === "number" ? `${configured}` : `${spaces.length} (count unconfirmed)`;
  const messages = spaces.reduce((n, s) => n + (s.messagesRead ?? 0), 0);
  const pages = spaces.reduce((n, s) => n + (s.pagesWalked ?? 0), 0);
  const unfinished = spaces.filter((s) => s.exhausted !== true);
  // A space in membership that the run never opened is unreported, not covered —
  // so "all walked spaces finished" is only a clean bill when the walk set is the
  // whole membership.
  const unvisited = typeof configured === "number" ? configured - spaces.length : 0;
  const verdict =
    spaces.length === 0
      ? "**no space was walked**"
      : unfinished.length > 0
        ? `**${unfinished.length} of ${spaces.length} walked spaces did not finish**`
        : unvisited > 0
          ? `every walked space was exhausted, but **${unvisited} space(s) in membership were never opened**`
          : "every space in membership was walked to exhaustion";
  const out = [
    `- Chat coverage: ${scope} space(s) this identity is a member of — ${messages} messages over ${pages} pages; ${verdict}. Membership is enumerated per run, so an unwalked space is unknown, not absent .${note}`,
  ];
  for (const s of spaces) {
    const finished = s.exhausted === true ? "exhausted" : "INCOMPLETE";
    const why = s.note ? ` — ${s.note}` : "";
    out.push(
      `  - \`${s.space}\`: ${s.messagesRead ?? "?"} messages over ${s.pagesWalked ?? "?"} pages (${finished})${why}`
    );
  }
  return out;
}

/**
 * Counts for the run footer. The disposition counts are derivable from the
 * decision lines the run actually wrote, so they are always computed — a
 * `run_summary` that disagrees with its own journal is the model's word against
 * the record, and the record wins . `iu_hints` is not derivable here, so
 * it is reported only when the summary supplies it rather than defaulted to a
 * fabricated `0`. `nodes_touched` and `node_ops` are two different measurements and
 * both are reported: one node legitimately carries several ops (two themes touching
 * the same node, or an append plus a later retraction), so comparing a distinct-node
 * count against a sum of ops flagged the ordinary case as a discrepancy . The
 * invariant check is distinct-nodes against distinct-nodes, which the journal can
 * settle because every op names its `node_id`; a real disagreement is still stated
 * rather than silently resolved in either direction. The `commitment_claims*` figures come from
 * the check report the caller already ran  — the `run_summary` has no say in
 * them, so they carry into `index.json` for the dashboard without a contest. When
 * the check did not run they are `"unknown"` strings, which {@link numericCountsOf}
 * then omits: a dashboard that finds no key knows it does not know, whereas a `0`
 * would read as "checked, nothing found".
 */
function countsOf(
  entries: JournalLine[],
  commitment: CommitmentCheckReport
): Record<string, number | string> {
  const summary = lastRunSummary(entries);
  const provided = (summary?.counts ?? {}) as Record<string, number | undefined>;
  const decisions = entries.filter((e) => e.type === "decision");
  const opsOf = (d: JournalLine): Record<string, unknown>[] =>
    Array.isArray(d.node_ops) ? (d.node_ops as Record<string, unknown>[]) : [];
  const nodeOps = decisions.reduce((n, d) => n + opsOf(d).length, 0);
  const distinctNodes = new Set(
    decisions.flatMap((d) =>
      opsOf(d)
        .map((op) => op.node_id)
        .filter((id): id is string => typeof id === "string")
    )
  ).size;
  const providedNodes = provided.nodes_touched;
  return {
    decisions: decisions.length,
    distilled: decisions.filter((d) => d.disposition === "distilled").length,
    adjudicated_away: decisions.filter((d) => d.disposition === "adjudicated_away").length,
    skipped: decisions.filter((d) => d.disposition === "skipped").length,
    deferred: decisions.filter((d) => d.disposition === "deferred").length,
    nodes_touched:
      typeof providedNodes === "number" && providedNodes !== distinctNodes
        ? `unknown (summary says ${providedNodes}, decisions name ${distinctNodes} distinct)`
        : distinctNodes,
    node_ops: nodeOps,
    iu_hints: typeof provided.iu_hints === "number" ? provided.iu_hints : "unknown",
    commitment_claims: commitment.status === "evaluated" ? commitment.checks.length : "unknown",
    commitment_claims_flagged:
      commitment.status === "evaluated"
        ? commitment.checks.filter((c) => c.verdict === "flagged").length
        : "unknown",
    commitment_claims_unknown:
      commitment.status === "evaluated"
        ? commitment.checks.filter((c) => c.verdict === "unknown").length
        : "unknown",
    ...chatCountsOf(summary),
    ...githubCountsOf(summary),
  };
}

/**
 * GitHub figures for `index.json` . `github_qualifiers_run` is the count a
 * dashboard can trend: a run of 1 is a `--updated`-only sweep and is short by an
 * unknowable amount. A run that reported no coverage block is `"unknown"`, which
 * {@link numericCountsOf} omits — a missing key means the run never said, whereas
 * a `0` would claim it measured and found none.
 */
function githubCountsOf(summary: JournalLine | undefined): Record<string, number | string> {
  const cov = summary?.github_coverage as { qualifiers?: string[] } | undefined;
  if (!cov) return { github_qualifiers_run: "unknown" };
  return { github_qualifiers_run: normalizeGithubQualifiers(cov.qualifiers).length };
}

/**
 * Chat figures for `index.json` . Neither is derivable from the decision
 * lines — a decision cites the messages it used, never the ones the walk read and
 * discarded — so these are reported only when the summary supplies them. A run
 * that read no chat still emits `chat_spaces_configured: 0`, because "configured
 * nothing" is a real measurement and materially different from never having said.
 */
function chatCountsOf(summary: JournalLine | undefined): Record<string, number | string> {
  const cov = summary?.chat_coverage as
    | { configured_spaces?: number; spaces?: ChatSpaceCoverage[] }
    | undefined;
  if (!cov) return { chat_spaces_configured: "unknown", chat_messages_read: "unknown" };
  const spaces = Array.isArray(cov.spaces) ? cov.spaces : [];
  const anyMessageCount = spaces.some((s) => typeof s.messagesRead === "number");
  return {
    chat_spaces_configured:
      typeof cov.configured_spaces === "number" ? cov.configured_spaces : "unknown",
    chat_messages_read: anyMessageCount
      ? spaces.reduce((n, s) => n + (s.messagesRead ?? 0), 0)
      : spaces.length === 0
        ? 0
        : "unknown",
  };
}

/**
 * The machine-readable slice of {@link countsOf} for `index.json`. A count the
 * journal cannot settle is OMITTED rather than coerced to a number — a consumer
 * that finds no key knows it does not know, whereas a `0` reads as a measurement.
 */
function numericCountsOf(
  entries: JournalLine[],
  commitment: CommitmentCheckReport
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(countsOf(entries, commitment)).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number"
    )
  );
}

function statusOf(entries: JournalLine[]): "complete" | "partial" {
  const summary = lastRunSummary(entries);
  if (!summary) return "partial";
  return summary.advanced === false ? "partial" : "complete";
}

/** Build the `index.json` run entry for a rendered run (pure). */
export function buildIndexRun(
  entries: JournalLine[],
  args: {
    date: string;
    relJournalPath: string;
    relReportPath: string;
    generatedAt: string;
    commitment: CommitmentCheckReport;
  }
): IndexRun {
  const meta = entries.find((e) => e.type === "run_meta");
  const window = (meta?.window ?? {}) as { from?: string; to?: string };
  const runId =
    (entries.find((e) => typeof e.run_id === "string")?.run_id as string | undefined) ??
    `${window.from ?? "?"}__${window.to ?? "?"}`;
  return {
    date: args.date,
    run_id: runId,
    windowFrom: window.from ?? (runId.includes("__") ? runId.slice(0, runId.indexOf("__")) : "?"),
    windowTo: window.to ?? (runId.includes("__") ? runId.slice(runId.indexOf("__") + 2) : "?"),
    journalPath: args.relJournalPath,
    reportPath: args.relReportPath,
    status: statusOf(entries),
    counts: numericCountsOf(entries, args.commitment),
    generatedAt: args.generatedAt,
  };
}

/** Upsert a run into the index by `run_id` (replace in place, else append newest-last). Pure. */
export function upsertIndexRun(index: ReportIndex, run: IndexRun): ReportIndex {
  const runs = index.runs.filter((r) => r.run_id !== run.run_id);
  runs.push(run);
  return { v: 1, runs };
}

function readIndex(indexPath: string): ReportIndex {
  if (!existsSync(indexPath)) return { v: 1, runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf-8")) as ReportIndex;
    if (parsed.v === 1 && Array.isArray(parsed.runs)) return parsed;
  } catch {
    // fall through to empty — a corrupt index is rebuilt from the run just rendered
  }
  return { v: 1, runs: [] };
}

/**
 * Read a run's journal, render the markdown report, write it, and upsert the run
 * into `index.json`. The write-side counterpart to {@link appendJournalEntry};
 * called once after the run's `run_summary` line is appended.
 *
 * Async because the commitment-claim polarity check is a semantic read (ISSUE_NUM /
 * ISSUE_NUM). It runs ONCE here and its report feeds both the markdown and the index
 * counts — evaluating separately per consumer would let the two disagree about
 * the same run. A host with no evaluator renders the section as "did not run"
 * rather than falling back to a lexical approximation.
 */
export async function renderAndIndex(
  paths: IuReportPaths,
  runId: string,
  opts: { now: string; evaluateCommitment?: CommitmentPolarityEvaluator }
): Promise<RenderResult> {
  const { date, journalPath } = resolveRunFile(paths, runId, { create: false });
  const entries = readLines(journalPath);
  if (entries.length === 0)
    throw new Error(`no journal entries for run ${runId} at ${journalPath}`);

  const commitment = await checkCommitmentClaims(entries, opts.evaluateCommitment);
  const markdown = renderReportMarkdown(entries, commitment);
  mkdirSync(paths.renderedDir, { recursive: true });
  const reportPath = paths.renderedPath(date);
  writeFileSync(reportPath, markdown);

  const relJournalPath = `journal/${date}.jsonl`;
  const relReportPath = `rendered/${date}.md`;
  const run = buildIndexRun(entries, {
    date,
    relJournalPath,
    relReportPath,
    generatedAt: opts.now,
    commitment,
  });
  const nextIndex = upsertIndexRun(readIndex(paths.indexPath), run);
  mkdirSync(paths.reportsDir, { recursive: true });
  writeFileSync(paths.indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);

  return {
    date,
    runId: run.run_id,
    reportPath,
    relReportPath,
    relJournalPath,
    status: run.status,
    counts: run.counts,
    indexPath: paths.indexPath,
    runsInIndex: nextIndex.runs.length,
  };
}
