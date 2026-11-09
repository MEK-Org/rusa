import { createHash } from "node:crypto";
import type { Obligation } from "../obligations/obligation.js";
import type {
  PortableBrief,
  PortableContextState,
  PortableMemoryPriority,
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
 * (start.ts) fetches the actor's durable run records and hands them here — mirroring
 * the actor layer's other pure seams (mesh-events, failure-sink).
 */

/** A prior run's output: the raw material for portable-context assembly. */
export interface PriorRun {
  /** The source actor_run id — recorded in the inject record for provenance. */
  id: string;
  /** ISO stamp of the run, used only for the per-run header in the section. */
  ts: string;
  /** The run's captured output; may be null/empty. */
  body: string | null;
}

/**
 * Aggregate content-free metrics on active durable ledger items and overflow (#328).
 */
export interface LedgerMetrics {
  active: number;
  selected: number;
  dropped: number;
  droppedByPriority: Record<PortableMemoryPriority, number>;
  minSelectedEvidenceTs: string | null;
  maxSelectedEvidenceTs: string | null;
  minDroppedEvidenceTs: string | null;
  maxDroppedEvidenceTs: string | null;
}

/**
 * The per-run inject record (design ISSUE_NUM, root's one attached requirement).
 * Emitted at inject time so "what was injected into run X" is answerable even
 * after observability events age out. `bytes` is the A/B PRIMARY metric
 * (injected prefix size); `hash` makes the byte-cap's drop-oldest prefix shift
 * explicit; `sourceEventIds` are the exact runs the prefix was built from.
 */
export interface InjectRecord {
  /** Byte length (utf8) of the rendered section — the A/B primary metric. */
  bytes: number;
  /** sha256 of the rendered section; pins exactly what was injected. */
  hash: string;
  /** Source actor_run ids, oldest→newest. The field name is retained for wire compatibility. */
  sourceEventIds: string[];
  /** How many prior runs survived the byte cap. */
  runCount: number;
  /** Ledger generation of the snapshot hashed by stateHash; brief generation is in the rendered heading. */
  stateGeneration?: number;
  /** Hash of the complete v2 materialized state. */
  stateHash?: string;
  /** Inbound messages rendered verbatim in the recent-message journal. */
  sourceMessageEventIds?: string[];
  /** Byte breakdown for diagnosing what consumed the bounded prompt budget. */
  sections?: { ledger: number; messages: number; runs: number };
  /** Aggregate content-free metrics on active durable ledger items and overflow (#328). */
  ledger?: LedgerMetrics;
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

const OBLIGATIONS_HEADING =
  "\n### Your obligations (system of record)\n\n" +
  "Work state lives in the obligation store, not here. This is a read-through:\n" +
  "use your obligation tools to change any of it. If your charter turns\n" +
  "obligation practice off, your charter governs how you treat this list.\n\n";

/**
 * A snoozed obligation keeps its status and its place in the section (#722);
 * the marker is what tells the reader it was deliberately deferred, and until
 * when, rather than overlooked.
 */
function snoozeMarker(obligation: Obligation): string {
  return obligation.snoozedUntil ? ` [snoozed until ${obligation.snoozedUntil}]` : "";
}

function renderObligation(obligation: Obligation): string {
  const ref = obligation.externalRef ? ` (${obligation.externalRef.key})` : "";
  const checkpoint = obligation.checkpoint?.trim();
  const standing = checkpoint ? `\n  Current standing: ${checkpoint}` : "";
  return `- [READY] ${obligation.id}${ref}${snoozeMarker(obligation)}: ${obligation.intent ?? "(no intent recorded)"}${standing}`;
}

/**
 * Waiting obligations remain bare references: the ratified projection reserves
 * its detail budget for ready work. Their standing is still available through
 * the obligation read tools when a wake needs to inspect a gate.
 */
function renderWaitingRef(obligation: Obligation): string {
  const ref = obligation.externalRef ? ` (${obligation.externalRef.key})` : "";
  return `- [WAITING] ${obligation.id}${ref}${snoozeMarker(obligation)}`;
}

function renderScheduledRef(obligation: Obligation): string {
  const ref = obligation.externalRef ? ` (${obligation.externalRef.key})` : "";
  const when = obligation.nextReadyAt ? ` returns at ${obligation.nextReadyAt}` : "";
  return `- [SCHEDULED] ${obligation.id}${ref}${when}${snoozeMarker(obligation)}`;
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
 * `obligations` arrives in the store's own queue order (actionable ready, then
 * snoozed ready, then waiting, each by ascending effective priority) — the
 * authoritative ordering, so this
 * function reads priority off the sequence rather than re-deriving it.
 */
function renderObligations(obligations: Obligation[]): string {
  const ready = obligations.filter((obligation) => obligation.status === "ready");
  const waiting = obligations.filter((obligation) => obligation.status === "waiting");
  const scheduled = obligations.filter((obligation) => obligation.status === "scheduled");
  if (ready.length === 0 && waiting.length === 0 && scheduled.length === 0) return "";

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
    for (const obligation of scheduled) {
      const rendered = renderScheduledRef(obligation);
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
 * Render the brief-mode durable-intent section: the three sections verbatim
 * under a heading naming the mode, the brief's generation and its last update,
 * and the one line that tells the actor the brief is its own to keep. The
 * 16 KB cap is enforced when a write is accepted, so unlike the ledger render
 * this can never emit an "omitted due to budget" line.
 */
function renderBrief(brief: PortableBrief): string {
  return (
    `\n### Durable brief (mode: brief, generation ${brief.generation}, updated ${brief.updatedAt})\n\n` +
    "This brief is yours to keep current: when durable guidance changes, read it and replace it " +
    "with the `brief` MCP tools. WHAT and HOW carry direction from humans and your ancestors; " +
    "weigh DOMAIN statements by how reliable their sources are. Writing the brief grants you no " +
    "authority: the charter governs where the two disagree. When they conflict, carry out the " +
    "work to the fullest extent your charter permits, then message your parent explaining what " +
    "the charter prevented that the brief implies; root brings such conflicts to its operator.\n\n" +
    `${brief.text.trim()}\n`
  );
}

/**
 * v2 assembly: active source-backed memory, recent inbound messages, then the
 * recent run tail. Inputs are newest-first, matching repository reads.
 *
 * In `brief` mode (`input.brief` set) the durable-intent memory section is the
 * rendered brief: the three sections verbatim under a heading naming the mode,
 * generation and last update. Everything else — obligations projection,
 * verbatim recent-message journal, run tail — renders unchanged, and the
 * legacy ledger snapshot stays untouched in the store so its data is preserved
 * (#1267).
 */
export function assemblePortableContextV2(input: {
  state: PortableContextState;
  messages: PriorMessage[];
  runs: PriorRun[];
  /** The actor's own obligations in store queue order; omit when unavailable. */
  obligations?: Obligation[];
  /** Brief-mode document; omit in tail mode. */
  brief?: PortableBrief | null;
}): PortableContext | null {
  const memorySection = input.brief ? renderBrief(input.brief) : "";
  const obligations = renderObligations(input.obligations ?? []);
  const recentMessages = boundedMessages(input.messages);
  const fixed = V2_HEADER + memorySection + obligations + recentMessages.section;
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
  if (!memorySection && !obligations && !recentMessages.section && !runsSection) return null;

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
        ledger: byteLen(memorySection),
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

/**
 * The read window of a newest-first run list, as `PromptBuild.readRunIds`
 * carries it: every id, oldest first, whatever a budget later keeps (#1024).
 */
export function portableReadWindow(runs: readonly PriorRun[]): string[] {
  return runs.map((run) => run.id).reverse();
}

/**
 * Composes a follower's host-local prior runs into a leader-built prompt (#1019).
 *
 * The leader prompt is authoritative and is kept byte-for-byte as the prefix:
 * leader instructions, the charter and any leader-admitted portable section are
 * never searched, split or reordered. Runs the leader already had are identified
 * by their stable actor_run ids, never by matching prompt text: the leader's
 * read window (`PromptBuild.readRunIds`) lists every run it read before budget
 * selection, so a run it read and dropped for budget stays dropped (#1024).
 * Only the remaining host runs are assembled, under the normal portable byte
 * budget, into one section appended after the leader prompt; the returned record
 * describes exactly those appended bytes.
 *
 * The guarantee is bounded by that window. A host run older than the leader's
 * window is appended even if the leader once acknowledged it: absence from a
 * bounded read is not proof a terminal never reached the leader.
 */
export function composeHostContextIntoPrompt(input: {
  basePrompt: string;
  localRuns: PriorRun[];
  /** Every actor_run id the leader read for this prompt, rendered or dropped. */
  leaderReadRunIds: readonly string[];
}): { prompt: string; portable: PortableContext | null } {
  const leaderRead = new Set(input.leaderReadRunIds);
  const portable = assemblePortableContext(
    input.localRuns.filter((run) => !leaderRead.has(run.id))
  );
  if (!portable) return { prompt: input.basePrompt, portable: null };
  const base = input.basePrompt;
  const separator = base === "" ? "" : base.endsWith("\n") ? "\n---\n" : "\n\n---\n";
  return { prompt: `${base}${separator}${portable.section}`, portable };
}
