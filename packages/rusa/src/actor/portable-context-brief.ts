import type { PortableLedgerSource } from "../db/repositories/actor-run-repository.js";
import { parseReference } from "../references/reference.js";
import {
  extractGeminiText,
  getGeminiClient,
  withGeminiRetry,
} from "../understanding/gemini-utils.js";
import type { BriefCursor, PortableBrief, PortableContextState } from "./portable-context-state.js";

/**
 * The portable-context `brief` mode (#954 iteration 1). Where the `ledger`
 * mode appends per-message durable items until the render degrades, the brief
 * mode maintains ONE re-synthesized document per actor — three fixed sections
 * (WHAT purpose, HOW method, DOMAIN understanding), one cited statement per
 * line — that replaces the durable-intent prompt section wholesale. Per-resource
 * state (heads, gates, run ids) is excluded by validation and stays in the
 * obligation store where it belongs.
 *
 * This module is the pure seam: one rewrite cycle takes a bounded slice of the
 * actor's durable sources (mesh chat + own yield notes), asks one bare Gemini
 * call to rewrite the brief, validates the output deterministically, and on
 * acceptance advances the brief's own position cursor. The wiring (start.ts)
 * injects the store, the source paging, citation resolution, the rewriter,
 * telemetry and the needs-attention sink — mirroring the ledger compactor's
 * separation between `portable-context-compactor.ts` (pure) and start.ts (db).
 */

/** The operator-ratified summarizer tier for the brief rewrite (amendment: 14:31Z ruling). */
export const PORTABLE_CONTEXT_BRIEF_MODEL = "gemini-3.8-flash";
/** Hard cap on the rendered brief, in UTF-8 bytes; enforced after the rewrite, never truncated. */
export const PORTABLE_CONTEXT_BRIEF_MAX_BYTES = 16 * 1024;
/**
 * The bounded oldest-first delta slice: at most this many sources, and at most
 * this many UTF-8 bytes of source body, go to one rewrite call. A single source
 * larger than the byte bound is processed alone rather than silently lost; the
 * backlog drains across accepted cycles because the cursor advances only past
 * the processed slice (#954 amendment 1b).
 */
export const PORTABLE_CONTEXT_BRIEF_MAX_SLICE_SOURCES = 50;
export const PORTABLE_CONTEXT_BRIEF_MAX_SLICE_BYTES = 96 * 1024;
/** Failed cycles after which rewrites freeze and the actor's parent is alerted. */
export const PORTABLE_CONTEXT_BRIEF_MAX_CONSECUTIVE_FAILURES = 3;
/** Validator-error feedback on the repair retry is itself bounded. */
export const PORTABLE_CONTEXT_BRIEF_MAX_VALIDATION_ERROR_BYTES = 4 * 1024;

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

/** Who authored a delta message, weighted per the spec's authority rule. */
export type BriefSourceClass = "human" | "ancestor" | "descendant" | "peer";

export interface BriefClassificationDeps {
  /** Parent thread id, null for root, undefined when the actor is unknown. */
  parentOf: (actorId: string) => string | null | undefined;
  /** Whether an id is a durable human principal (operator or user). */
  isHumanPrincipal: (id: string) => boolean;
}

/**
 * Classify a delta message's sender for the authority rule. Peer and the
 * actor's own messages carry descendant weight; human outranks ancestor
 * outranks descendant. The parent chains are walked with a visited set: a
 * corrupt cycle in the tree must not hang the rewrite cycle.
 */
export function classifyBriefSender(
  senderId: string,
  actorId: string,
  deps: BriefClassificationDeps
): BriefSourceClass {
  if (senderId === actorId) return "descendant";
  if (deps.isHumanPrincipal(senderId)) return "human";

  const reaches = (start: string, target: string): boolean => {
    const seen = new Set<string>();
    let current: string | null | undefined = start;
    while (current !== null && current !== undefined && !seen.has(current)) {
      if (current === target) return true;
      seen.add(current);
      current = deps.parentOf(current);
    }
    return false;
  };

  if (reaches(senderId, actorId)) return "descendant";
  if (reaches(actorId, senderId)) return "ancestor";
  return "peer";
}

/** The ready-made citation for one durable source; the model copies these, never invents them. */
export function citationForLedgerSource(source: PortableLedgerSource): string {
  return source.kind === "run_yielded"
    ? `mesh:actors/${source.actorId}/runs/${source.id}`
    : `mesh:messages/${source.id}`;
}

// ── State exclusion (DOMAIN is understanding, never per-resource state) ──

/** 7+ hex with at least one digit: matches short SHAs like 96800f2 but not the word "defaced". */
const HEAD_SHA_PATTERN = /\b(?=[0-9a-fA-F]*\d)[0-9a-fA-F]{7,40}\b/;
const RUN_OR_MESSAGE_ID_PATTERN =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;
const REVIEW_ID_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bpullrequestreview-\d+\b/i, "pullrequestreview-<id>"],
  [/\breviews\/\d+\b/i, "reviews/<id>"],
  [/discussion_r\d+\b/i, "discussion_r<id>"],
  [/\breview\s+(?:#?\d{6,})\b/i, "review <id>"],
];
const GATE_TALLY_PATTERN = /\b\d{1,2}\s*\/\s*\d{1,2}\b/;
/** A #NNN with no owner/repo in front of it. */
const BARE_ISSUE_REF_PATTERN = /(^|[^\w/#])#(\d+)\b/;

/**
 * Why `statement` names per-resource state, or null when it is clean. Checks
 * run on the statement part only — the citation tail carries UUIDs, numeric
 * comment ids and SHAs by design, so splitting at the first citation is what
 * keeps valid citations from tripping the exclusions (#954 amendment 4).
 */
export function findBriefStateExclusions(statement: string): string[] {
  const result: string[] = [];
  const runId = statement.match(RUN_OR_MESSAGE_ID_PATTERN);
  if (runId) result.push(`names a run/message id (${runId[0]})`);

  // Strip matched UUIDs before checking for commit SHAs so the first 8-hex chunk of a UUID doesn't false-positive as a SHA
  const withoutUuids = statement.replace(new RegExp(RUN_OR_MESSAGE_ID_PATTERN, "g"), "");
  const sha = withoutUuids.match(HEAD_SHA_PATTERN);
  if (sha) result.push(`names a commit SHA (${sha[0]})`);

  for (const [pattern, label] of REVIEW_ID_PATTERNS) {
    const review = statement.match(pattern);
    if (review) result.push(`names a review id (${label})`);
  }
  const tally = statement.match(GATE_TALLY_PATTERN);
  if (tally) result.push(`names a gate tally (${tally[0]})`);
  const issue = statement.match(BARE_ISSUE_REF_PATTERN);
  if (issue) result.push(`names a bare issue number (${issue[0].trim()}) without its repository`);
  return result;
}

export function findBriefStateExclusion(statement: string): string | null {
  const all = findBriefStateExclusions(statement);
  return all.length > 0 ? all.join("; ") : null;
}

// ── Document shape: three fixed sections, one cited statement per line ──

export const BRIEF_SECTIONS = ["WHAT", "HOW", "DOMAIN"] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export interface ParsedBriefLine {
  section: BriefSection;
  /** The statement, with the citation tail stripped. */
  statement: string;
  /** Canonical citation strings (brackets removed). */
  refs: string[];
  /** The exact raw line, for byte-identical carried-line comparison. */
  raw: string;
}

export interface ParsedBrief {
  lines: ParsedBriefLine[];
  /** Raw lines per section, in document order (including blanks). */
  sections: Record<BriefSection, string[]>;
}

/**
 * Parse the three-section document. Returns the structured lines plus every
 * shape problem found; a line with no parseable trailing `[ref]` citation is
 * itself one of the problems.
 */
export function parseBriefDocument(text: string): { parsed?: ParsedBrief; errors: string[] } {
  const errors: string[] = [];
  const lines = text.split("\n");
  const sections: Record<BriefSection, string[]> = { WHAT: [], HOW: [], DOMAIN: [] };
  const parsedLines: ParsedBriefLine[] = [];
  let current: BriefSection | null = null;
  const seen = new Set<BriefSection>();

  for (const raw of lines) {
    const heading = raw.match(/^##\s+(\S+)\s*$/);
    if (heading) {
      const name = heading[1].toUpperCase();
      if (!BRIEF_SECTIONS.includes(name as BriefSection)) {
        errors.push(`unknown section heading ${JSON.stringify(raw)}`);
        continue;
      }
      const section = name as BriefSection;
      if (seen.has(section)) errors.push(`duplicate section ${section}`);
      if (current !== null && BRIEF_SECTIONS.indexOf(section) <= BRIEF_SECTIONS.indexOf(current)) {
        errors.push(`section ${section} is out of order`);
      }
      seen.add(section);
      current = section;
      sections[section].push(raw);
      continue;
    }
    if (raw.startsWith("#")) {
      errors.push(`unexpected heading line ${JSON.stringify(raw)}`);
      continue;
    }
    if (current === null) {
      if (raw.trim() !== "")
        errors.push(`content before the first section: ${JSON.stringify(raw)}`);
      continue;
    }
    sections[current].push(raw);
    if (raw.trim() === "") continue;

    // Citations are bracketed `[ref]` groups; each inner text must parse as a
    // reference. The statement is the line with the bracketed citations removed.
    const refs: string[] = [];
    const validMatches: Array<{ full: string; ref: string }> = [];
    const matches = Array.from(raw.matchAll(/\[([^\]]+)\]/g));
    for (const match of matches) {
      const candidate = match[1].trim();
      try {
        parseReference(candidate);
        validMatches.push({ full: match[0], ref: candidate });
      } catch {
        // Not a structured reference; leave in statement
      }
    }
    let statement = raw;
    for (const valid of validMatches) {
      refs.push(valid.ref);
      statement = statement.replace(valid.full, "");
    }
    statement = statement.trim();
    if (refs.length === 0) {
      errors.push(`${current} line has no structured citation: ${JSON.stringify(raw)}`);
      continue;
    }
    if (statement === "") {
      errors.push(`${current} line is only a citation: ${JSON.stringify(raw)}`);
      continue;
    }
    parsedLines.push({ section: current, statement, refs, raw });
  }

  for (const section of BRIEF_SECTIONS) {
    if (!seen.has(section)) errors.push(`missing section ${section}`);
  }
  return errors.length > 0 ? { errors } : { parsed: { lines: parsedLines, sections }, errors };
}

// ── Validation ──

export interface BriefValidationInput {
  text: string;
  /** The previously accepted brief text; null when there is no previous brief. */
  previousText: string | null;
  /**
   * Citations of this cycle's delta sources classed human or ancestor. A WHAT/HOW
   * line that is not byte-identical to a previous WHAT/HOW line must cite at
   * least one of these — root's guard that what/how changes only follow cited
   * human/ancestor supersession.
   */
  authorityCitations: ReadonlySet<string>;
}

/**
 * Deterministically validate a candidate brief's SHAPE: sections, the 16 KB
 * cap, the state exclusions on the statement part only, citation syntax, and
 * root's byte-identical WHAT/HOW guard. Citation RESOLUTION is the caller's
 * job (the cycle resolves only refs it has not seen before, against the
 * per-actor cache); a shape-valid line can still be rejected by the cycle for
 * an unresolvable citation. Returns the error list; empty means acceptable.
 */
export function validateBriefText(input: BriefValidationInput): {
  errors: string[];
  refs: string[];
} {
  const errors: string[] = [];
  const refs: string[] = [];

  if (byteLen(input.text) > PORTABLE_CONTEXT_BRIEF_MAX_BYTES) {
    errors.push(
      `brief is ${byteLen(input.text)} bytes, over the ${PORTABLE_CONTEXT_BRIEF_MAX_BYTES}-byte cap`
    );
  }

  const { parsed, errors: parseErrors } = parseBriefDocument(input.text);
  errors.push(...parseErrors);
  if (!parsed) return { errors, refs };

  const previous =
    input.previousText === null ? null : parseBriefDocument(input.previousText).parsed;
  const previousWhatHow = new Set(
    previous ? previous.lines.filter((l) => l.section !== "DOMAIN").map((l) => l.raw) : []
  );
  const newWhatHow = parsed.lines.filter((l) => l.section !== "DOMAIN");
  const authority = input.authorityCitations;

  for (const line of parsed.lines) {
    for (const ref of line.refs) refs.push(ref);

    const exclusion = findBriefStateExclusion(line.statement);
    if (exclusion) {
      errors.push(`${line.section} line ${exclusion}: ${JSON.stringify(line.statement)}`);
    }

    if (line.section === "DOMAIN") continue;

    if (previousWhatHow.has(line.raw)) continue; // byte-identical carry; refs already resolved

    const citedAuthority = line.refs.some((ref) => authority.has(ref));
    if (!citedAuthority) {
      errors.push(
        `${line.section} line changed without a cited human/ancestor supersession: ${JSON.stringify(line.raw)}`
      );
    }
  }

  if (previous) {
    const newWhatHowRaw = new Set(newWhatHow.map((l) => l.raw));
    const dropped = previous.lines.filter(
      (l) => l.section !== "DOMAIN" && !newWhatHowRaw.has(l.raw)
    );
    if (dropped.length > 0 && authority.size === 0) {
      errors.push(
        `${dropped.length} previous WHAT/HOW line(s) dropped without any human/ancestor message in the delta`
      );
    }
  }

  return { errors, refs };
}

// ── The rewrite prompt (normative text ratified in the #954 spec) ──

export const BRIEF_REWRITE_SYSTEM_INSTRUCTION =
  "Maintain a brief with three sections in order: WHAT (purpose and standing commitments), " +
  "HOW (operating rules and method constraints), DOMAIN (understanding of concepts, mechanisms, " +
  "ownership and recurring failure shapes). One statement per line. Every line ends with one or " +
  "more structured citations, each in square brackets.\n" +
  "\n" +
  "Input is the current brief and a bounded delta. Each new message has a verified class and a " +
  "ready-made citation. Human outranks ancestor, which outranks descendant; peer and the actor's " +
  "own messages have descendant weight. Copy only refs supplied with messages, the charter, or " +
  "already-resolved carried lines. The call also supplies the complete accepted citation-form " +
  "list, including mesh:actors/<id>/charter.\n" +
  "\n" +
  "WHAT/HOW additions and changes only restate a cited human or ancestor message. Keep existing " +
  "WHAT/HOW lines byte-identical unless a newer cited human/ancestor message supersedes them. " +
  "DOMAIN may draw on all classes; where sources conflict, prefer higher authority. Drop " +
  "superseded lines.\n" +
  "\n" +
  "DOMAIN is understanding, never per-resource state. Do not include commit SHAs, run ids, review " +
  "ids, gate tallies or bare issue numbers without owner/repo in statement text. A PR milestone " +
  "contributes no new lines and at most refines an existing DOMAIN line. These exclusions do not " +
  "apply to citation identifiers.\n" +
  "\n" +
  "Output the complete three-section brief within 16 KB UTF-8. Keep lines whole and cited. Output " +
  "nothing else. If supplied validator errors for a repair retry, correct them using the same sources.";

export const BRIEF_ACCEPTED_CITATION_FORMS = [
  "mesh:messages/<id>",
  "mesh:actors/<id>/charter",
  "mesh:actors/<id>/runs/<run id>",
  "gchat:spaces/<space>/messages/<message>",
  "slack:channels/<channel>/messages/<timestamp>",
  "github:OWNER/REPO/issues/<n>",
  "github:OWNER/REPO/issues/<n>/comments/<id>",
  "github:OWNER/REPO/pulls/<n>",
  "github:OWNER/REPO/pulls/<n>/reviews/<id>",
] as const;

export interface BriefDeltaMessage {
  citation: string;
  sourceClass: BriefSourceClass;
  ts: string;
  sender: string;
  body: string;
}

/**
 * Assemble one rewrite call's user content: current brief, the bounded delta
 * oldest-first with ready-made citations and class labels, the accepted
 * citation-form list, and — on the repair retry — the bounded validator
 * errors. Input bytes stay O(brief + bounded delta + errors) regardless of how
 * much durable history lies behind the cursor.
 */
export function buildBriefRewritePrompt(input: {
  currentText: string;
  delta: BriefDeltaMessage[];
  validatorErrors?: string[];
}): string {
  const rendered = input.delta
    .map(
      (message) =>
        `[class: ${message.sourceClass}] [${message.citation}] ${message.ts} from ${message.sender}:\n` +
        message.body
    )
    .join("\n\n");
  let prompt =
    `Current brief:\n${input.currentText}\n\n` +
    `New messages (oldest first; each carries its ready-made citation and source class):\n` +
    `${rendered}\n\n` +
    `Accepted citation forms — copy refs exactly as supplied above or as they already appear on ` +
    `carried lines; never invent identifiers:\n` +
    BRIEF_ACCEPTED_CITATION_FORMS.map((form) => `- ${form}`).join("\n");
  if (input.validatorErrors && input.validatorErrors.length > 0) {
    const bounded = input.validatorErrors.join("\n");
    const errors =
      byteLen(bounded) > PORTABLE_CONTEXT_BRIEF_MAX_VALIDATION_ERROR_BYTES
        ? `${bounded.slice(0, PORTABLE_CONTEXT_BRIEF_MAX_VALIDATION_ERROR_BYTES)}…`
        : bounded;
    prompt += `\n\nValidator errors to correct (repair retry; use the same sources):\n${errors}`;
  }
  return prompt;
}

// ── Seeding ──

/** The post-switch seed: one cited WHAT line, no charter copy, empty DOMAIN. */
export function seedBriefText(actorId: string): string {
  return (
    `## WHAT\n` +
    `The charter is in force; it is rendered in the prompt. [mesh:actors/${actorId}/charter]\n` +
    `\n` +
    `## HOW\n` +
    `\n` +
    `## DOMAIN\n`
  );
}

// ── The rewrite cycle ──

export interface BriefAttemptTelemetry {
  attempt: "initial" | "repair";
  outcome: "accepted" | "rejected";
  /** The generation this attempt would produce (current + 1). */
  generation: number;
  inputBytes: number;
  outputBytes: number;
  latencyMs: number;
  model: string;
  /** Validator/rejection reason; null on acceptance. */
  reason: string | null;
}

export interface BriefCycleDeps {
  actorId: string;
  store: {
    load(actorId: string): PortableContextState;
    save(state: PortableContextState): void;
  };
  /** One bare-LLM rewrite call (Gemini in production; a stub in tests). */
  rewriter: { model: string; rewrite(contents: string): Promise<string> };
  /** Resolve a citation ref against the actor's own stores/tracker; true when it resolves. */
  resolveRef: (ref: string) => Promise<boolean>;
  /** Classify a delta sender (compose with the actor's parent chain). */
  classify: (senderId: string) => BriefSourceClass;
  /** Page the durable stream strictly after a position; null position = from the start. */
  listSources: (
    position: BriefCursor | null,
    limit: number
  ) => { sources: PortableLedgerSource[]; hasMore: boolean };
  latestPosition: () => BriefCursor | null;
  now?: () => string;
  /** One telemetry row per rewrite attempt, including repair retries. */
  recordAttempt: (attempt: BriefAttemptTelemetry) => void;
  /**
   * Raise the durable needs-attention item for the actor's parent through the
   * existing inbox path, exactly once at freeze time. Handling releases the
   * freeze: the parent's handling reply reaches the actor as a durable chat
   * message, and the cycle that sees a human/ancestor-class message after the
   * frozen cursor unfreezes before rewriting.
   */
  raiseAttention: (input: { actorId: string; reason: string }) => void;
  log?: (message: string) => void;
}

export type BriefCycleOutcome =
  | { outcome: "seeded" }
  | { outcome: "skipped" }
  | { outcome: "frozen" }
  | { outcome: "accepted"; released: boolean; attempts: number }
  | { outcome: "rejected"; attempts: number; reason: string };

interface BriefSourceSlice {
  sources: PortableLedgerSource[];
  hasMore: boolean;
}

/**
 * Select the bounded oldest-first delta slice: walk sources after the cursor
 * until the count or byte bound is reached. A single source larger than the
 * byte bound is taken alone — it is processed, never silently dropped.
 */
export function selectBriefSlice(
  page: BriefSourceSlice,
  maxSources: number,
  maxBytes: number
): PortableLedgerSource[] {
  const selected: PortableLedgerSource[] = [];
  let used = 0;
  for (const source of page.sources) {
    const cost = byteLen(source.body ?? "");
    if (selected.length > 0 && (selected.length >= maxSources || used + cost > maxBytes)) break;
    selected.push(source);
    used += cost;
    if (selected.length >= maxSources) break;
  }
  return selected;
}

function positionOf(source: PortableLedgerSource): BriefCursor {
  return {
    ts: source.ts,
    sourceOrder: source.kind === "run_yielded" ? 1 : 0,
    id: source.id,
  };
}

/**
 * Run one post-run brief cycle for an actor in `brief` mode.
 *
 * Seed on first sight (cursor captured at the switch-time newest source, so
 * the delta is post-switch only). Skip when nothing new arrived. Freeze after
 * {@link PORTABLE_CONTEXT_BRIEF_MAX_CONSECUTIVE_FAILURES} consecutive failed
 * cycles, alerting the actor's parent through the existing inbox path; any
 * inbound human/ancestor message after the frozen cursor is the parent's
 * handling reply reaching the actor and releases the freeze. On acceptance
 * the cursor advances only past the processed slice, so the backlog drains
 * across runs and a failed cycle never enlarges the next one's input.
 *
 * The ledger fields (`items`, ledger `generation`, `lastFoldedSourceId`) are
 * never touched here — that is what keeps switch-back to `ledger` mode free.
 */
export async function runPortableContextBriefCycle(
  deps: BriefCycleDeps
): Promise<BriefCycleOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const log = deps.log ?? (() => {});
  const state = deps.store.load(deps.actorId);

  if (state.brief === null) {
    const charterRef = `mesh:actors/${deps.actorId}/charter`;
    deps.store.save({
      ...state,
      brief: {
        text: seedBriefText(deps.actorId),
        cursor: deps.latestPosition(),
        generation: 0,
        model: null,
        updatedAt: now(),
        consecutiveFailures: 0,
        frozen: false,
        resolvedRefs: [charterRef],
      },
    });
    log(`[portable-context] brief seeded for ${deps.actorId}`);
    return { outcome: "seeded" };
  }

  const page = deps.listSources(state.brief.cursor, PORTABLE_CONTEXT_BRIEF_MAX_SLICE_SOURCES);
  const slice = selectBriefSlice(
    page,
    PORTABLE_CONTEXT_BRIEF_MAX_SLICE_SOURCES,
    PORTABLE_CONTEXT_BRIEF_MAX_SLICE_BYTES
  );
  if (slice.length === 0) {
    return { outcome: state.brief.frozen ? "frozen" : "skipped" };
  }

  const delta: BriefDeltaMessage[] = slice.map((source) => {
    const sender =
      source.kind === "run_yielded"
        ? source.actorId
        : (() => {
            try {
              const parsed = JSON.parse(source.payload ?? "{}") as { from?: unknown };
              return typeof parsed.from === "string" && parsed.from ? parsed.from : "unknown";
            } catch {
              return "unknown";
            }
          })();
    return {
      citation: citationForLedgerSource(source),
      sourceClass: source.kind === "run_yielded" ? "descendant" : deps.classify(sender),
      ts: source.ts,
      sender,
      body: source.body ?? "",
    };
  });
  const authorityCitations = new Set(
    delta
      .filter((m) => m.sourceClass === "human" || m.sourceClass === "ancestor")
      .map((m) => m.citation)
  );

  let released = false;
  let brief: PortableBrief = state.brief;
  if (brief.frozen) {
    if (authorityCitations.size === 0) {
      return { outcome: "frozen" };
    }
    // The parent's handling reply (or a human message) reached the actor:
    // release the freeze and spend this cycle's delta on the rewrite.
    brief = { ...brief, frozen: false, consecutiveFailures: 0 };
    released = true;
    log(`[portable-context] brief freeze released for ${deps.actorId} by human/ancestor message`);
  }

  const resolvedRefs = new Set(brief.resolvedRefs);
  const failedRefsThisCycle = new Set<string>();
  let failures = brief.consecutiveFailures;
  let lastErrors: string[] = [];
  let attempts = 0;

  const tryAttempt = async (
    attempt: "initial" | "repair",
    validatorErrors?: string[]
  ): Promise<{ text: string; errors: string[]; inputBytes: number; latencyMs: number } | null> => {
    attempts += 1;
    const contents = buildBriefRewritePrompt({
      currentText: brief.text,
      delta,
      validatorErrors,
    });
    const inputBytes = byteLen(contents);
    const started = Date.now();
    let text: string;
    try {
      text = await deps.rewriter.rewrite(contents);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      deps.recordAttempt({
        attempt,
        outcome: "rejected",
        generation: brief.generation + 1,
        inputBytes,
        outputBytes: 0,
        latencyMs: Date.now() - started,
        model: deps.rewriter.model,
        reason: `rewrite call failed: ${reason}`,
      });
      lastErrors = [`rewrite call failed: ${reason}`];
      return null;
    }
    const latencyMs = Date.now() - started;

    const candidateRefs = new Set<string>();
    const structural = validateBriefText({
      text,
      previousText: brief.text,
      authorityCitations,
    });
    // Resolve only refs not already cached; carried lines were never re-parsed
    // for this (their refs sit in the cache from when they first appeared).
    const carried = new Set(parseBriefDocument(brief.text).parsed?.lines.map((l) => l.raw) ?? []);
    const { parsed } = parseBriefDocument(text);
    const toResolve = new Set<string>();
    for (const line of parsed?.lines ?? []) {
      if (carried.has(line.raw)) continue;
      for (const ref of line.refs) {
        if (!resolvedRefs.has(ref) && !candidateRefs.has(ref)) toResolve.add(ref);
      }
    }
    for (const ref of toResolve) {
      if (failedRefsThisCycle.has(ref)) {
        structural.errors.push(`citation does not resolve: ${ref}`);
        continue;
      }
      let ok = false;
      try {
        ok = await deps.resolveRef(ref);
      } catch {
        ok = false;
      }
      if (ok) {
        candidateRefs.add(ref);
      } else {
        failedRefsThisCycle.add(ref);
        structural.errors.push(`citation does not resolve: ${ref}`);
      }
    }

    deps.recordAttempt({
      attempt,
      outcome: structural.errors.length === 0 ? "accepted" : "rejected",
      generation: brief.generation + 1,
      inputBytes,
      outputBytes: byteLen(text),
      latencyMs,
      model: deps.rewriter.model,
      reason: structural.errors.length === 0 ? null : structural.errors.join("; ").slice(0, 500),
    });

    if (structural.errors.length > 0) {
      lastErrors = structural.errors;
      return null;
    }
    for (const ref of candidateRefs) resolvedRefs.add(ref);
    return { text, errors: [], inputBytes, latencyMs };
  };

  const initial = await tryAttempt("initial");
  const accepted = initial ?? (await tryAttempt("repair", lastErrors));

  if (accepted === null) {
    failures += 1;
    const frozen = failures >= PORTABLE_CONTEXT_BRIEF_MAX_CONSECUTIVE_FAILURES;
    deps.store.save({
      ...state,
      brief: { ...brief, consecutiveFailures: failures, frozen, updatedAt: now() },
    });
    if (frozen && !brief.frozen) {
      const reason = `portable-context brief rewrite failed ${failures} consecutive cycles for ${deps.actorId}: ${lastErrors.join("; ")}`;
      deps.raiseAttention({ actorId: deps.actorId, reason });
      log(`[portable-context] ${reason}`);
    } else {
      log(
        `[portable-context] brief rewrite rejected for ${deps.actorId} (failure ${failures}): ${lastErrors.join("; ")}`
      );
    }
    return { outcome: "rejected", attempts, reason: lastErrors.join("; ") };
  }

  deps.store.save({
    ...state,
    brief: {
      text: accepted.text,
      cursor: positionOf(slice[slice.length - 1]),
      generation: brief.generation + 1,
      model: deps.rewriter.model,
      updatedAt: now(),
      consecutiveFailures: 0,
      frozen: false,
      resolvedRefs: [...resolvedRefs],
    },
  });
  return { outcome: "accepted", released, attempts };
}

// ── The Gemini rewriter ──

/**
 * One bare `gemini-3.8-flash` text call — no tools, no JSON schema, no actor
 * session. The rewrite prompt carries everything the model may cite; the
 * output is validated deterministically afterwards, so the call itself stays
 * deliberately thin.
 */
export class GeminiBriefRewriter {
  readonly model: string;
  constructor(
    private readonly apiKey: string,
    model: string = PORTABLE_CONTEXT_BRIEF_MODEL
  ) {
    this.model = model;
  }

  async rewrite(contents: string): Promise<string> {
    const client = getGeminiClient(this.apiKey);
    const response = await withGeminiRetry(() =>
      client.models.generateContent({
        model: this.model,
        contents,
        config: { temperature: 0, httpOptions: { timeout: 60_000 } },
      })
    );
    return extractGeminiText(response);
  }
}
