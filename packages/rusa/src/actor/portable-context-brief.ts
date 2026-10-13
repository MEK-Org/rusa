import { parseReference } from "../references/reference.js";
import type { PortableContextState } from "./portable-context-state.js";

/**
 * The portable-context `brief` mode (#954). Where the `ledger` mode appends
 * per-message durable items until the render degrades, the brief mode keeps
 * ONE document per actor — three fixed sections (WHAT purpose, HOW method,
 * DOMAIN understanding), one cited statement per line — that replaces the
 * durable-intent prompt section wholesale.
 *
 * The actor owns its brief: it reads and replaces it through the brief MCP
 * server (`mcp/brief-mcp.ts`), and nothing rewrites it after a run. This module
 * is the pure seam that server uses — the document grammar, the deterministic
 * validation an actor-authored write must pass, and the post-switch seed.
 * Per-resource state (heads, gates, run ids) is refused by validation and stays
 * in the obligation store where it belongs.
 */

/** Hard cap on the brief, in UTF-8 bytes; a larger write is refused, never truncated. */
export const PORTABLE_CONTEXT_BRIEF_MAX_BYTES = 16 * 1024;
/** Cap on a write's optional explanation, in UTF-8 bytes. */
export const PORTABLE_CONTEXT_BRIEF_MAX_EXPLANATION_BYTES = 2 * 1024;

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

// ── State exclusion (the brief is understanding, never per-resource state) ──

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

function isStructuredRef(candidate: string): boolean {
  try {
    parseReference(candidate);
    return true;
  } catch {
    return false;
  }
}

export const BRIEF_SECTIONS = ["WHAT", "HOW", "DOMAIN"] as const;
export type BriefSection = (typeof BRIEF_SECTIONS)[number];

export interface ParsedBriefLine {
  section: BriefSection;
  /** The statement, with the citation tail stripped. */
  statement: string;
  /** Canonical citation strings (brackets removed). */
  refs: string[];
  /** The exact raw line. */
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

    // Citations are bracketed `[ref]` groups whose inner text parses as a
    // reference. The line splits at its first citation: the statement is
    // everything before it (a non-reference bracket such as `[sic]` stays
    // statement text), and everything from it on must be citations only.
    const groups = Array.from(raw.matchAll(/\[([^\]]+)\]/g));
    const first = groups.find((group) => isStructuredRef(group[1].trim()));
    if (first?.index === undefined) {
      errors.push(`${current} line has no structured citation: ${JSON.stringify(raw)}`);
      continue;
    }
    const statement = raw.slice(0, first.index).trim();
    const tail = raw.slice(first.index);
    const tailGroups = groups.filter((group) => (group.index ?? -1) >= first.index);
    const refs = tailGroups.map((group) => group[1].trim());
    if (
      tail.replace(/\[[^\]]+\]/g, "").trim() !== "" ||
      !refs.every((ref) => isStructuredRef(ref))
    ) {
      errors.push(
        `${current} line must end with its citations, with nothing after the first one but citations: ${JSON.stringify(raw)}`
      );
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

export interface ActorBriefValidationInput {
  text: string;
  /** The stored brief text the write would replace. */
  previousText: string;
  explanation?: string;
}

export type ActorBriefValidationResult =
  | { outcome: "noop" }
  | { outcome: "invalid"; errors: string[] }
  | {
      outcome: "accepted";
      text: string;
      explanation?: string;
      /**
       * Canonical citations this write introduces: cited here but not by the
       * brief it replaces. Each must resolve before the write is stored.
       */
      newCitations: string[];
    };

/** Canonical keys of every structured citation in `text`, in first-seen order. */
export function briefCitations(text: string): string[] {
  const keys = new Set<string>();
  for (const group of text.matchAll(/\[([^\]]+)\]/g)) {
    try {
      keys.add(parseReference(group[1].trim()).key);
    } catch {
      // Not a reference: statement text such as `[sic]`.
    }
  }
  return [...keys];
}

/**
 * Validate an actor-authored brief write before anything is stored.
 *
 * - A write whose text matches the stored brief (ignoring trailing whitespace)
 *   is a no-op: it is reported as unchanged and records no revision, whatever
 *   its explanation says, so restating the same guidance costs nothing.
 * - Otherwise the text must fit the 16 KiB cap, parse as the three sections in
 *   order, carry a structured citation on every statement line, and name no
 *   per-resource state in any statement. The explanation is optional and capped.
 *
 * The check is the whole grammar, not a diff against the previous brief: the
 * actor may consolidate, reword, drop lines, and rotate which representative
 * source it cites, with no per-line supersession bookkeeping. The charter
 * still governs; the brief carries evolving guidance under it.
 *
 * This check is syntactic. An accepted result names the citations the write
 * introduces, and the caller must resolve each one before storing the write
 * (#954 disposition 6155205270): a citation the replaced brief already carried
 * was resolved when that brief was accepted, or is the seed's own charter line.
 */
export function validateActorBriefUpdate(
  input: ActorBriefValidationInput
): ActorBriefValidationResult {
  const text = `${input.text.trimEnd()}\n`;
  if (text === `${input.previousText.trimEnd()}\n`) return { outcome: "noop" };

  const errors: string[] = [];
  if (byteLen(text) > PORTABLE_CONTEXT_BRIEF_MAX_BYTES) {
    errors.push(
      `brief is ${byteLen(text)} bytes, over the ${PORTABLE_CONTEXT_BRIEF_MAX_BYTES}-byte cap`
    );
  }
  const explanation = input.explanation?.trim() || undefined;
  if (
    explanation !== undefined &&
    byteLen(explanation) > PORTABLE_CONTEXT_BRIEF_MAX_EXPLANATION_BYTES
  ) {
    errors.push(
      `explanation is ${byteLen(explanation)} bytes, over the ${PORTABLE_CONTEXT_BRIEF_MAX_EXPLANATION_BYTES}-byte cap`
    );
  }

  const { parsed, errors: parseErrors } = parseBriefDocument(text);
  errors.push(...parseErrors);
  for (const line of parsed?.lines ?? []) {
    const exclusion = findBriefStateExclusion(line.statement);
    if (exclusion)
      errors.push(`${line.section} line ${exclusion}: ${JSON.stringify(line.statement)}`);
  }

  if (errors.length > 0) return { outcome: "invalid", errors };
  const previous = new Set(briefCitations(input.previousText));
  return {
    outcome: "accepted",
    text,
    ...(explanation === undefined ? {} : { explanation }),
    newCitations: briefCitations(text).filter((ref) => !previous.has(ref)),
  };
}

// ── Seeding ──

/** The post-switch seed: one cited WHAT line, no charter copy, empty HOW and DOMAIN. */
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

/** Seed the brief at generation 0 on the first brief-mode prompt, leaving ledger fields untouched. */
export function seedPortableBriefState(
  state: PortableContextState,
  actorId: string,
  now: string
): PortableContextState {
  return { ...state, brief: { text: seedBriefText(actorId), generation: 0, updatedAt: now } };
}
