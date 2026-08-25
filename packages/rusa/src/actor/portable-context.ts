import { createHash } from "node:crypto";
import type { Obligation } from "../obligations/obligation.js";
import {
  isRetiredMemoryKind,
  type PortableContextState,
  type PortableMemoryItem,
  type PortableMemoryPriority,
} from "./portable-context-state.js";

/**
 * Provider-agnostic context (design ISSUE_NUM). When an actor selects portable
 * context, the mesh — not the provider's opaque session —
 * owns its working memory: the actor is called STATELESS (no session resume) and
 * its recent run outputs are re-injected FRESH into the prompt each run. This
 * replaces the provider's full re-sent trajectory (150–200K tokens on a long-lived
 * agy actor with no compaction knob) with a bounded, deterministic seed.
 *
 * This module is the pure assembly step. It has no db dependency — the wiring
 * (start.ts) fetches the actor's `run_end` events and hands them here — mirroring
 * the actor layer's other pure seams (mesh-events, failure-sink).
 */

/** A prior run's output: the raw material for portable-context assembly. */
export interface PriorRun {
  /** The source mesh_event id — recorded in the inject record for provenance. */
  id: string;
  /** ISO stamp of the run, used only for the per-run header in the section. */
  ts: string;
  /** The run's captured output (a `run_end` body); may be null/empty. */
  body: string | null;
}

/**
 * The per-run inject record (design ISSUE_NUM, root's one attached requirement).
 * Emitted at inject time so "what was injected into run X" is answerable even
 * after the source `run_end` rows age out. `bytes` is the A/B PRIMARY metric
 * (injected prefix size); `hash` makes the byte-cap's drop-oldest prefix shift
 * explicit; `sourceEventIds` are the exact runs the prefix was built from.
 */
export interface InjectRecord {
  /** Byte length (utf8) of the rendered section — the A/B primary metric. */
  bytes: number;
  /** sha256 of the rendered section; pins exactly what was injected. */
  hash: string;
  /** Source `run_end` event ids, oldest→newest, that the prefix was built from. */
  sourceEventIds: string[];
  /** How many prior runs survived the byte cap. */
  runCount: number;
  /** v2 ledger generation; absent for the legacy raw-tail mode. */
  stateGeneration?: number;
  /** Hash of the complete v2 materialized state. */
  stateHash?: string;
  /** Inbound messages rendered verbatim in the recent-message journal. */
  sourceMessageEventIds?: string[];
  /** Byte breakdown for diagnosing what consumed the bounded prompt budget. */
  sections?: { ledger: number; messages: number; runs: number };
}

export interface PortableContext {
  /** The rendered `## Recent activity` prompt section, ready to prepend. */
  section: string;
  record: InjectRecord;
}

/** Default max prior runs to consider (query limit before byte-capping). */
export const PORTABLE_CONTEXT_MAX_RUNS = 10;
/** Default number of recent inbound messages replayed verbatim. */
export const PORTABLE_CONTEXT_MAX_MESSAGES = 10;

/**
 * The runtime window size — {@link PORTABLE_CONTEXT_MAX_RUNS} unless the
 * `PORTABLE_CONTEXT_MAX_RUNS` env var overrides it with a positive integer.
 *
 * The G2-v2 short-run rig  shrinks the window (e.g. to 2) so an early
 * decision ages out after a couple of filler runs instead of eleven — exercising
 * the SAME aging boundary ~5× cheaper. Read at CALL TIME by both the injector
 * (start.ts) and the aging reconstruction (relevance-aging.ts) so they agree on the
 * SELECT set. The default is unchanged, so native (non-rig) actors are unaffected.
 */
export function portableContextMaxRuns(): number {
  const raw = process.env.PORTABLE_CONTEXT_MAX_RUNS;
  if (raw === undefined || raw === "") return PORTABLE_CONTEXT_MAX_RUNS;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : PORTABLE_CONTEXT_MAX_RUNS;
}

/**
 * Runtime size of the verbatim inbound-message journal. The override is mainly
 * useful to exercise the ledger boundary cheaply in the E2E rig.
 */
export function portableContextMaxMessages(): number {
  const raw = process.env.PORTABLE_CONTEXT_MAX_MESSAGES;
  if (raw === undefined || raw === "") return PORTABLE_CONTEXT_MAX_MESSAGES;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : PORTABLE_CONTEXT_MAX_MESSAGES;
}
/**
 * Hard byte cap on the injected recent-activity block. The whole point of the
 * experiment is to replace an unbounded re-sent trajectory with a bounded seed,
 * and to keep the injected prefix well under provider prompt limits alongside the
 * scaffold + charter + latest messages.
 */
export const PORTABLE_CONTEXT_MAX_BYTES = 32_000;
/**
 * Hard byte ceiling on the rendered durable intent ledger section.
 *
 * Fixing over-resolution (Scope A / ISSUE_NUM) makes active-item bytes grow monotonically
 * where they previously self-pruned via spurious resolves. To prevent unbounded
 * growth from breaking prompt assembly, the ledger gracefully degrades (eliding
 * lowest-priority items to fit) rather than throwing when active items exceed
 * this ceiling.
 */
export const PORTABLE_CONTEXT_LEDGER_MAX_BYTES = 16_000;
/** Recent inbound messages get a separate verbatim budget before run output. */
export const PORTABLE_CONTEXT_MESSAGES_MAX_BYTES = 8_000;
/**
 * Byte ceiling on the rendered obligation projection.
 *
 * Obligations are the system of record for work state , so this section
 * is a read-through of that store, not a second lifecycle: nothing rendered here
 * can be marked done from the prompt. It gets its own budget rather than sharing
 * the ledger's so that a large ledger cannot silently starve the actor's work
 * queue, or the reverse.
 */
export const PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES = 6_000;

/**
 * Per-run ceiling on the fold loop, in source pages and in source-body bytes.
 *
 * The fold pages forward from the ledger watermark until the journal is drained,
 * so switching a long-lived actor into ledger mode backfills its entire history
 * past that watermark in one run — through a cheap-tier model on a 60s timeout.
 * Today's worst case is ~2MB of yield notes, comfortably survivable, but an
 * unbounded loop is a latent bug at whatever size the log reaches next. Hitting
 * a cap is not data loss: the watermark advanced, so the next run resumes
 * exactly where this one stopped, and {@link PortableContextCompactionSummary.foldStop}
 * says it happened.
 */
export const PORTABLE_CONTEXT_FOLD_MAX_PAGES = 20;
export const PORTABLE_CONTEXT_FOLD_MAX_BYTES = 256_000;

const HEADER =
  "## Recent activity (your own prior runs)\n\n" +
  "The mesh owns your context: you were started **fresh** this run, so your earlier\n" +
  "work is replayed below (oldest first) instead of resumed from a provider session.\n" +
  "Treat it as your own memory, but re-derive current state from your tools — the\n" +
  "replay is a bounded seed, not the full history.\n";

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * Assemble an actor's portable context from its recent run outputs, deterministically.
 * `runs` is the actor's recent `run_end` events NEWEST-FIRST (as
 * `listEventsByActors` returns them). We keep the most-recent runs that fit under
 * {@link PORTABLE_CONTEXT_MAX_BYTES} and render them oldest→newest so the leading
 * bytes stay as stable as possible run-to-run (a valid prompt-cache control for the
 * A/B). When the single most-recent run alone exceeds the budget it's included,
 * tail-truncated (the tail is the run's result/summary — the most useful part,
 * matching the repository's own `clampBody`). Returns null when there's nothing to
 * inject (a first run, or only empty outputs).
 */
export function assemblePortableContext(runs: PriorRun[]): PortableContext | null {
  const nonEmpty = runs.filter((r) => (r.body ?? "").trim().length > 0);
  if (nonEmpty.length === 0) return null;

  const budget = PORTABLE_CONTEXT_MAX_BYTES - byteLen(HEADER);
  const chosen: PriorRun[] = [];
  let used = 0;
  // Walk newest→oldest, keeping runs until the next would breach the budget.
  for (const run of nonEmpty) {
    const cost = byteLen(renderRun(run));
    if (chosen.length === 0 && cost > budget) {
      // Even the most-recent run alone is too big — include it, tail-truncated.
      // Reserve for the per-run wrapper (`### Run …`) so the rendered result fits.
      const wrapper = byteLen(renderRun({ ...run, body: "" }));
      chosen.push({ ...run, body: tailToBytes((run.body ?? "").trim(), budget - wrapper) });
      break;
    }
    if (used + cost > budget) break;
    chosen.push(run);
    used += cost;
  }

  // Render oldest→newest for a stable, append-only-ish prefix.
  const ordered = [...chosen].reverse();
  const section = HEADER + ordered.map(renderRun).join("");
  return {
    section,
    record: {
      bytes: byteLen(section),
      hash: createHash("sha256").update(section, "utf8").digest("hex"),
      sourceEventIds: ordered.map((r) => r.id),
      runCount: ordered.length,
    },
  };
}

function renderRun(run: PriorRun): string {
  return `\n### Run ${run.ts}\n\n${(run.body ?? "").trim()}\n`;
}

export interface PriorMessage {
  id: string;
  ts: string;
  sender: string;
  body: string | null;
}

const V2_HEADER =
  "## Portable context (mesh-managed)\n\n" +
  "You were started fresh for this run. The mesh preserved durable intent and a\n" +
  "bounded recent journal below. Active durable items remain in force until a newer\n" +
  "source explicitly supersedes or resolves them. Re-derive external state with tools.\n";

const LEDGER_PRIORITY_ORDER: Record<PortableMemoryPriority, number> = {
  must: 0,
  should: 1,
  background: 2,
};

function renderItem(item: PortableMemoryItem): string {
  const evidence = item.evidence[0];
  const source = evidence
    ? `\n  Source ${evidence.sender} at ${evidence.ts}: ${JSON.stringify(evidence.quote)}`
    : "";
  return `- [${item.priority.toUpperCase()}] [${item.kind}] ${item.statement}${source}`;
}

/**
 * Active, still-authorable ledger items.
 *
 * The kind filter is what actually retires a kind (ISSUE_NUM leg 3). Removing it
 * from the persisted enum instead would make every existing state file fail to
 * load — 17 of 17 files and 100 of 127 items when measured on 2026-08-21 — and
 * the resulting `ZodError` reaches `buildPrompt` uncaught, so the actor cannot
 * start. Filtering here removes the retired kinds' prompt authority, which is
 * the whole of what leg 3 needs, and leaves the items on disk as provenance.
 */
function renderableLedgerItems(state: PortableContextState): PortableMemoryItem[] {
  return state.items.filter((item) => item.status === "active" && !isRetiredMemoryKind(item.kind));
}

function renderLedger(state: PortableContextState): string {
  const active = renderableLedgerItems(state);
  if (active.length === 0) return "";

  const heading = "\n### Durable intent\n\n";
  const trailing = "\n";
  const wrapperCost = byteLen(heading) + byteLen(trailing);
  const budget = PORTABLE_CONTEXT_LEDGER_MAX_BYTES - wrapperCost;

  const renderedItems = active.map((item, originalIndex) => ({
    item,
    originalIndex,
    rendered: renderItem(item),
  }));

  const allLines = renderedItems.map((r) => r.rendered);
  const fullContent = heading + allLines.join("\n") + trailing;
  if (byteLen(fullContent) <= PORTABLE_CONTEXT_LEDGER_MAX_BYTES) {
    return fullContent;
  }

  // Gracefully degrade: prioritize items by priority ("must" > "should" > "background"),
  // preserving original order within the same priority level.
  const prioritized = [...renderedItems].sort((a, b) => {
    const priorityDiff =
      LEDGER_PRIORITY_ORDER[a.item.priority] - LEDGER_PRIORITY_ORDER[b.item.priority];
    if (priorityDiff !== 0) return priorityDiff;
    return a.originalIndex - b.originalIndex;
  });

  const selected: typeof renderedItems = [];
  let usedBytes = 0;

  for (const candidate of prioritized) {
    const candidateCost = byteLen(candidate.rendered) + (selected.length > 0 ? 1 : 0);
    if (usedBytes + candidateCost <= budget) {
      selected.push(candidate);
      usedBytes += candidateCost;
    } else if (selected.length === 0) {
      // Even the single highest-priority item exceeds the budget alone, so it is
      // truncated rather than dropped: the actor's most urgent durable memory
      // should be visible and cut, not silently absent.
      //
      // The *whole rendered line* is what gets bounded. Truncating the statement
      // to `budget - 200` only bounds the items whose surrounding text happens
      // to be shorter than that guess, which is not a ceiling. `renderItem`
      // appends an evidence quote after the statement, and a quote has no length
      // cap anywhere — it only has to be a verbatim substring of a mesh event
      // body, and those run to kilobytes. Reproduced: one item with an oversized
      // quote throws `portable context fixed sections exceed 32000 bytes` from
      // `assemblePortableContextV2`, which is raised inside `buildPrompt` with no
      // try/catch, so the owning actor cannot start until its data changes.
      //
      // Same defect and same failure mode as ISSUE_NUM's, one function over. Live
      // ledger items are nowhere near it — the largest rendered line across all
      // 17 state files is 808 bytes as of 2026-08-21 — so this is latent, and
      // latent is exactly when it is cheap to close.
      const truncatedRendered = headToBytes(candidate.rendered, budget);
      selected.push({
        item: candidate.item,
        originalIndex: candidate.originalIndex,
        rendered: truncatedRendered,
      });
      break;
    }
  }

  if (selected.length === 0) return "";

  // Render selected items in their original array order for a stable prefix
  selected.sort((a, b) => a.originalIndex - b.originalIndex);
  return heading + selected.map((s) => s.rendered).join("\n") + trailing;
}

const OBLIGATIONS_HEADING =
  "\n### Your obligations (system of record)\n\n" +
  "Work state lives in the obligation store, not here. This is a read-through:\n" +
  "use your obligation tools to change any of it.\n\n";

function renderObligation(obligation: Obligation): string {
  const ref = obligation.externalRef ? ` (${obligation.externalRef.key})` : "";
  return `- [READY] ${obligation.id}${ref}: ${obligation.intent ?? "(no intent recorded)"}`;
}

/** Waiting obligations appear as a bare reference — enough to recognise, not to act on. */
function renderWaitingRef(obligation: Obligation): string {
  const ref = obligation.externalRef ? ` (${obligation.externalRef.key})` : "";
  return `- [WAITING] ${obligation.id}${ref}`;
}

/**
 * Project the actor's obligation queue into the prompt, per Operator's ratified rule
 * (ISSUE_NUM comment 5369843998, carried in ISSUE_NUM):
 *
 *   "as space permits include the READY obligations, ordered by priority; if
 *   there is still space, include brief references to WAITING obligations. Ready
 *   obligations too big to fit are cut off by priority; waiting obligations may
 *   be included ONLY so long as all ready obligations fit."
 *
 * Two consequences worth stating, because both are easy to violate while looking
 * correct:
 *
 * 1. Selection **stops** at the first ready obligation that does not fit; it does
 *    not skip ahead to a smaller one. Everything after it is lower priority, so
 *    packing the gap would seat lower-priority work while higher-priority work is
 *    absent — an inversion of the rule, disguised as better budget use.
 * 2. A waiting reference can never displace ready work. If even one ready
 *    obligation was cut, the waiting section is empty regardless of how much room
 *    is left, because the room is only there as a consequence of the cut.
 *
 * `obligations` arrives in the store's own queue order (ready before waiting,
 * then ascending effective priority) — the authoritative ordering, so this
 * function reads priority off the sequence rather than re-deriving it.
 */
function renderObligations(obligations: Obligation[]): string {
  const ready = obligations.filter((obligation) => obligation.status === "ready");
  const waiting = obligations.filter((obligation) => obligation.status === "waiting");
  if (ready.length === 0 && waiting.length === 0) return "";

  const trailing = "\n";
  const budget =
    PORTABLE_CONTEXT_OBLIGATIONS_MAX_BYTES - byteLen(OBLIGATIONS_HEADING) - byteLen(trailing);
  const lines: string[] = [];
  let used = 0;
  let allReadyFit = true;

  for (const obligation of ready) {
    const rendered = renderObligation(obligation);
    const cost = byteLen(rendered) + (lines.length > 0 ? 1 : 0);
    if (used + cost <= budget) {
      lines.push(rendered);
      used += cost;
      continue;
    }
    if (lines.length === 0) {
      // The single highest-priority obligation does not fit alone. Dropping it
      // would leave the actor's most urgent work invisible, so it is truncated
      // instead — the same trade the ledger makes.
      //
      // The *whole rendered line* is what gets bounded, not just the intent
      // inside it. Reserving a fixed allowance for the id and external ref only
      // bounds the ones shorter than the guess, which is not a ceiling at all:
      // ISSUE_NUM's reviewer-tier pass reproduced a real GitHub ref at the owner/repo
      // maxima carrying the section to 6,005 bytes, and a longer ref the
      // validator still accepts throwing the 32KB fixed-section assert — which
      // would have kept the owning actor from starting until its data changed.
      const truncated = headToBytes(renderObligation(obligation), budget);
      lines.push(truncated);
      used += byteLen(truncated);
    }
    allReadyFit = false;
    break;
  }

  if (allReadyFit) {
    for (const obligation of waiting) {
      const rendered = renderWaitingRef(obligation);
      const cost = byteLen(rendered) + (lines.length > 0 ? 1 : 0);
      if (used + cost > budget) break;
      lines.push(rendered);
      used += cost;
    }
  }

  if (lines.length === 0) return "";
  return OBLIGATIONS_HEADING + lines.join("\n") + trailing;
}

function renderMessage(message: PriorMessage): string {
  return `\n#### Message from ${message.sender} at ${message.ts}\n\n${(message.body ?? "").trim()}\n`;
}

function headToBytes(s: string, maxBytes: number): string {
  if (byteLen(s) <= maxBytes) return s;
  const marker = "\n[message truncated after byte budget]";
  const room = Math.max(0, maxBytes - byteLen(marker));
  const head = Buffer.from(s, "utf8")
    .subarray(0, room)
    .toString("utf8")
    .replace(/\uFFFD+$/, "");
  return head + marker;
}

function boundedMessages(messages: PriorMessage[]): { section: string; selected: PriorMessage[] } {
  const nonEmpty = messages.filter((message) => (message.body ?? "").trim().length > 0);
  if (nonEmpty.length === 0) return { section: "", selected: [] };
  const heading = "\n### Recent messages (verbatim)\n";
  const budget = PORTABLE_CONTEXT_MESSAGES_MAX_BYTES - byteLen(heading);
  const selected: PriorMessage[] = [];
  let used = 0;
  for (const message of nonEmpty) {
    const rendered = renderMessage(message);
    if (selected.length === 0 && byteLen(rendered) > budget) {
      selected.push({ ...message, body: headToBytes(message.body ?? "", budget - 100) });
      break;
    }
    if (used + byteLen(rendered) > budget) break;
    selected.push(message);
    used += byteLen(rendered);
  }
  const ordered = [...selected].reverse();
  return { section: heading + ordered.map(renderMessage).join(""), selected: ordered };
}

/**
 * v2 assembly: active source-backed memory, recent inbound messages, then the
 * recent run tail. Inputs are newest-first, matching repository reads.
 */
export function assemblePortableContextV2(input: {
  state: PortableContextState;
  messages: PriorMessage[];
  runs: PriorRun[];
  /** The actor's own obligations in store queue order; omit when unavailable. */
  obligations?: Obligation[];
}): PortableContext | null {
  const ledger = renderLedger(input.state);
  const obligations = renderObligations(input.obligations ?? []);
  const recentMessages = boundedMessages(input.messages);
  const fixed = V2_HEADER + ledger + obligations + recentMessages.section;
  if (byteLen(fixed) > PORTABLE_CONTEXT_MAX_BYTES) {
    throw new Error(`portable context fixed sections exceed ${PORTABLE_CONTEXT_MAX_BYTES} bytes`);
  }

  const runHeading = "\n### Recent run outcomes\n";
  const runBudget = PORTABLE_CONTEXT_MAX_BYTES - byteLen(fixed) - byteLen(runHeading);
  const selectedRuns: PriorRun[] = [];
  let used = 0;
  for (const run of input.runs.filter((candidate) => (candidate.body ?? "").trim().length > 0)) {
    const rendered = renderRun(run);
    if (selectedRuns.length === 0 && byteLen(rendered) > runBudget) {
      const wrapper = byteLen(renderRun({ ...run, body: "" }));
      selectedRuns.push({
        ...run,
        body: tailToBytes((run.body ?? "").trim(), Math.max(0, runBudget - wrapper)),
      });
      break;
    }
    if (used + byteLen(rendered) > runBudget) break;
    selectedRuns.push(run);
    used += byteLen(rendered);
  }
  const orderedRuns = [...selectedRuns].reverse();
  const runsSection =
    orderedRuns.length > 0 ? runHeading + orderedRuns.map(renderRun).join("") : "";
  if (!ledger && !obligations && !recentMessages.section && !runsSection) return null;

  const section = fixed + runsSection;
  return {
    section,
    record: {
      bytes: byteLen(section),
      hash: createHash("sha256").update(section, "utf8").digest("hex"),
      sourceEventIds: orderedRuns.map((run) => run.id),
      runCount: orderedRuns.length,
      stateGeneration: input.state.generation,
      stateHash: createHash("sha256").update(JSON.stringify(input.state)).digest("hex"),
      sourceMessageEventIds: recentMessages.selected.map((message) => message.id),
      sections: {
        ledger: byteLen(ledger),
        messages: byteLen(recentMessages.section),
        runs: byteLen(runsSection),
      },
    },
  };
}

/** Keep the last `maxBytes` bytes of `s` (its tail — the run's result/summary). */
function tailToBytes(s: string, maxBytes: number): string {
  if (byteLen(s) <= maxBytes) return s;
  const marker = "… [earlier output truncated]\n";
  const room = Math.max(0, maxBytes - byteLen(marker));
  const buf = Buffer.from(s, "utf8");
  // Take the last `room` bytes; a cut may split a multibyte char, so drop any
  // leading replacement char that produces.
  const tail = buf
    .subarray(buf.length - room)
    .toString("utf8")
    .replace(/^�+/, "");
  return marker + tail;
}
