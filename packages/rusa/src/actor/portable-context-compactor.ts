import { createHash } from "node:crypto";
import { Type } from "@google/genai";
import { z } from "zod";
import type { PortableLedgerSource } from "../db/repositories/actor-run-repository.js";
import {
  extractGeminiText,
  getGeminiClient,
  withGeminiRetry,
} from "../understanding/gemini-utils.js";
import {
  isRetiredMemoryKind,
  type PortableContextState,
  type PortableMemoryEvidence,
  type PortableMemoryItem,
  portableMemoryKindSchema,
  portableMemoryPrioritySchema,
} from "./portable-context-state.js";

export const DEFAULT_PORTABLE_CONTEXT_COMPACTOR_MODEL = "gemini-3.1-flash-lite";

export function resolvePortableContextCompactorModel(model?: string): string {
  return model?.trim() || DEFAULT_PORTABLE_CONTEXT_COMPACTOR_MODEL;
}

const compactionOperationSchema = z.object({
  action: z.enum(["add", "update", "supersede", "resolve"]),
  itemId: z.string(),
  kind: portableMemoryKindSchema,
  priority: portableMemoryPrioritySchema,
  statement: z.string(),
  sourceEventId: z.string().min(1),
  quote: z.string().min(1),
});
export type CompactionOperation = z.infer<typeof compactionOperationSchema>;

const compactionResponseSchema = z.object({ operations: z.array(compactionOperationSchema) });

/**
 * Why an operation was rejected, as a closed set a metric can group by.
 *
 * `reason` carries the specifics (which id, which event) and is the right thing
 * to read in a log. It is the wrong thing to aggregate on: grouping by it means
 * matching prose that varies per operation, and the only stable axis left is
 * then the generation number. That is how ISSUE_NUM's gen-1 rate was assembled, and
 * it mixed two unrelated defects into one figure — 8 of the 25 quarantined
 * operations on the live record are ISSUE_NUM's unreferenceable-id class and the
 * other 17 are ISSUE_NUM's verbatim-quote class. The class is stamped at the point
 * of rejection, where the cause is already known, so no consumer has to infer
 * it back out of a sentence.
 */
export type QuarantineClass =
  /** The operation cited a source event that was not in the batch it was given. */
  | "source-outside-batch"
  /** The operation's quote does not appear in the source event body . */
  | "quote-not-verbatim"
  /** An `add`/`update` arrived with a blank statement. */
  | "missing-statement"
  /** A non-`add` operation named an item id the ledger does not hold . */
  | "unknown-item"
  /** An `update` tried to change the kind of a kind-locked item . */
  | "kind-immutable"
  /** A `resolve` targeted a kind that is not resolvable at all (ISSUE_NUM, ISSUE_NUM). */
  | "kind-not-resolvable"
  /** The operation named, or targeted an item of, a kind the store no longer authors . */
  | "kind-retired"
  /** An `update` of a protected constraint rested on the actor's own evidence . */
  | "self-authored-update"
  /** A `supersede` of a protected constraint rested on the actor's own evidence (ISSUE_NUM, ISSUE_NUM). */
  | "self-authored-supersede"
  /** An `add` of a protected constraint rested on the actor's own evidence . */
  | "self-authored-add";

export const QUARANTINE_CLASSES: readonly QuarantineClass[] = [
  "source-outside-batch",
  "quote-not-verbatim",
  "missing-statement",
  "unknown-item",
  "kind-immutable",
  "kind-not-resolvable",
  "kind-retired",
  "self-authored-update",
  "self-authored-supersede",
  "self-authored-add",
];

/**
 * How much of a rejected quote is persisted on a `quote-not-verbatim` record.
 *
 * The quote is model-authored text that mirrors source content, so it is
 * head-bounded rather than stored whole: a fold record is written on every run,
 * and one runaway quote would otherwise size the event.
 */
export const QUARANTINE_QUOTE_MAX_BYTES = 500;

export interface QuarantinedOperation {
  sourceEventId: string;
  action: CompactionOperation["action"];
  quarantineClass: QuarantineClass;
  reason: string;
  /**
   * The quote the compactor claimed, head-bounded to
   * {@link QUARANTINE_QUOTE_MAX_BYTES}. Set only on `quote-not-verbatim`
   * .
   *
   * Without it the record cannot separate a *fabricated* quote — the case the
   * matcher exists to catch — from one the model reproduced with normalized
   * punctuation or whitespace, and those have opposite remedies: the first says
   * the model is untrustworthy on that source, the second says the gate
   * discarded a correct extraction.
   */
  rejectedQuote?: string;
  /**
   * Byte length of the whole claimed quote. Greater than the byte length of
   * {@link rejectedQuote} exactly when the persisted quote was truncated, so a
   * reader never mistakes a head for the whole claim — re-running
   * `body.includes()` against a truncated quote can pass where the real check
   * failed.
   */
  rejectedQuoteBytes?: number;
  /** Byte length of the source body, so a reader can size the miss without re-querying it. */
  sourceBodyBytes?: number;
  /**
   * Whether the body would contain the quote if every run of ASCII whitespace
   * on both sides collapsed to a single space.
   *
   * `true` names the miss: a line wrap or re-indent, not an invention. `false`
   * is deliberately not "fabricated" — a dropped backtick reads `false` too —
   * so it hands the decision to a reader with {@link rejectedQuote} in hand.
   * This is a label on a rejection that already happened; it never changes
   * whether an operation is quarantined.
   */
  whitespaceNormalizedMatch?: boolean;
}

/** A rejection, minus the two fields the caller already holds. */
type QuarantineRejection = Omit<QuarantinedOperation, "sourceEventId" | "action">;

/**
 * Count quarantined operations per class, with every class present.
 *
 * Absent keys are the reason a breakdown is hard to read: a consumer cannot
 * tell "this class did not fire" from "this build did not know about this
 * class". Zeros are the useful answer, so all of {@link QUARANTINE_CLASSES}
 * always appear.
 */
export function quarantineCountsByClass(
  operations: readonly QuarantinedOperation[]
): Record<QuarantineClass, number> {
  const counts = Object.fromEntries(QUARANTINE_CLASSES.map((name) => [name, 0])) as Record<
    QuarantineClass,
    number
  >;
  for (const operation of operations) {
    counts[operation.quarantineClass] += 1;
  }
  return counts;
}
export interface CompactionResult {
  state: PortableContextState;
  quarantined: QuarantinedOperation[];
  /**
   * How many operations the compactor proposed for this batch, quarantined ones
   * included. Without it a quarantine count has no denominator: "2 quarantined"
   * is either 2-of-3 or 2-of-20 and the caller cannot tell which.
   */
  operations: number;
}

/**
 * What one `portable_context_compacted` event reports about a fold.
 *
 * `items` is the ledger's running total, so on its own it cannot separate a
 * degraded fold (some operations quarantined, ledger still grew) from an empty
 * one (every operation quarantined, ledger unchanged) — and the empty case is
 * the failure mode worth being loud about. `itemsAdded` and `operations` make
 * one event answer that on its own, without differencing against its
 * predecessor.
 */
export interface PortableContextCompactionSummary {
  generation: number;
  items: number;
  itemsAdded: number;
  folded: number;
  /** Of {@link folded}, how many were the actor's own yield notes. */
  foldedSelf: number;
  operations: number;
  quarantined: number;
  /**
   * {@link quarantined} split by cause. A bare total says a fold was degraded;
   * it does not say which defect degraded it, and the two live causes have
   * different owners and different fixes.
   */
  quarantinedByClass: Record<QuarantineClass, number>;
  quarantinedOperations: QuarantinedOperation[];
  /**
   * Why the fold loop stopped. `drained` means the journal is caught up; the
   * cap reasons mean sources remain and the next run continues from the
   * watermark — a fact that must be visible, since a silently capped fold looks
   * exactly like a drained one.
   */
  foldStop: "drained" | "page-cap" | "byte-cap";
}

export function describeCompaction(summary: PortableContextCompactionSummary): string {
  const byClass = QUARANTINE_CLASSES.filter((name) => summary.quarantinedByClass[name] > 0)
    .map((name) => `${name} ${summary.quarantinedByClass[name]}`)
    .join(", ");
  return (
    `generation ${summary.generation}; ${summary.items} items; ` +
    `${summary.folded} sources (${summary.foldedSelf} self); ` +
    `${summary.quarantined} quarantined${byClass ? ` (${byClass})` : ""}; ` +
    `${summary.operations} operations proposed; items +${summary.itemsAdded}; ` +
    `stop ${summary.foldStop}`
  );
}

export interface PortableContextCompactor {
  compact(input: {
    actorId: string;
    state: PortableContextState;
    messages: PortableLedgerSource[];
    now: string;
  }): Promise<CompactionResult>;
}

function stableItemId(actorId: string, op: CompactionOperation): string {
  return `mem-${createHash("sha256")
    .update(`${actorId}\0${op.sourceEventId}\0${op.kind}\0${op.statement}`)
    .digest("hex")
    .slice(0, 16)}`;
}

/**
 * Who authored a durable ledger source, for evidence provenance.
 *
 * An inbound message carries its sender in `payload.from`. A self-authored source (a
 * yield note) has no counterparty, so without this rule it would be stamped
 * `"unknown"` — conflating *the actor said this* with *nobody knows who said
 * this*, and erasing the only visible defense against provenance laundering: a
 * yield note is written by a model that had the ledger in its prompt, so an item
 * can be re-evidenced by the actor's own restatement of itself and refresh
 * indefinitely. v1 watches for that rather than preventing it; watching is only
 * possible if self-authored evidence is labelled as such.
 */
function isSelfAuthoredLedgerSource(kind: string): boolean {
  return kind === "run_yielded";
}

function senderOf(event: PortableLedgerSource, actorId: string): string {
  if (event.payload) {
    try {
      const parsed = JSON.parse(event.payload) as { from?: unknown };
      if (typeof parsed.from === "string" && parsed.from) return parsed.from;
    } catch {}
  }
  return isSelfAuthoredLedgerSource(event.kind) ? actorId : "unknown";
}

/** Head of `value` within `maxBytes`, without persisting a half-decoded character. */
function headBytes(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  let head = buffer.subarray(0, maxBytes).toString("utf8");
  // A cut mid-character decodes to U+FFFD; drop it rather than record a quote
  // ending in a character the model never wrote.
  while (head.endsWith("\uFFFD")) head = head.slice(0, -1);
  return head;
}

const ASCII_WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

/** `value` with every run of ASCII whitespace collapsed to one space, and trimmed. */
function collapseAsciiWhitespace(value: string): string {
  let collapsed = "";
  let pendingSpace = false;
  for (const character of value) {
    if (ASCII_WHITESPACE.has(character)) {
      pendingSpace = collapsed.length > 0;
      continue;
    }
    if (pendingSpace) {
      collapsed += " ";
      pendingSpace = false;
    }
    collapsed += character;
  }
  return collapsed;
}

/**
 * Whether the miss is a whitespace one. Empty after collapsing is `false`, not
 * `true`: `includes("")` is vacuously true and would report a whitespace-only
 * quote as a reproduced passage.
 */
function matchesIgnoringWhitespace(body: string, quote: string): boolean {
  const normalizedQuote = collapseAsciiWhitespace(quote);
  if (normalizedQuote.length === 0) return false;
  return collapseAsciiWhitespace(body).includes(normalizedQuote);
}

function evidenceFor(
  op: CompactionOperation,
  event: PortableLedgerSource,
  actorId: string
): PortableMemoryEvidence | QuarantineRejection {
  const body = event.body ?? "";
  if (!body.includes(op.quote)) {
    return {
      quarantineClass: "quote-not-verbatim",
      reason: `compactor quote is not verbatim in source event ${event.id}`,
      rejectedQuote: headBytes(op.quote, QUARANTINE_QUOTE_MAX_BYTES),
      rejectedQuoteBytes: Buffer.byteLength(op.quote, "utf8"),
      sourceBodyBytes: Buffer.byteLength(body, "utf8"),
      whitespaceNormalizedMatch: matchesIgnoringWhitespace(body, op.quote),
    };
  }
  return {
    eventId: event.id,
    sender: senderOf(event, actorId),
    ts: event.ts,
    quote: op.quote,
  };
}

export function applyCompactionOperations(input: {
  actorId: string;
  state: PortableContextState;
  messages: PortableLedgerSource[];
  operations: CompactionOperation[];
  now: string;
  model: string;
}): CompactionResult {
  const sourceById = new Map(input.messages.map((event) => [event.id, event]));
  const items = input.state.items.map((item) => structuredClone(item));
  const quarantined: QuarantinedOperation[] = [];

  for (const op of input.operations) {
    const source = sourceById.get(op.sourceEventId);
    if (!source) {
      quarantined.push({
        sourceEventId: op.sourceEventId,
        action: op.action,
        quarantineClass: "source-outside-batch",
        reason: `compactor cited event outside the input batch: ${op.sourceEventId}`,
      });
      continue;
    }
    const evidenceResult = evidenceFor(op, source, input.actorId);
    if ("reason" in evidenceResult) {
      quarantined.push({
        sourceEventId: op.sourceEventId,
        action: op.action,
        ...evidenceResult,
      });
      continue;
    }
    const evidence = evidenceResult;

    // The operation schema still accepts every persisted kind, deliberately: a
    // single stray emission must cost one operation, not the whole batch. The
    // narrowing happens here, per operation, where the metric can see it.
    if (isRetiredMemoryKind(op.kind)) {
      quarantined.push({
        sourceEventId: op.sourceEventId,
        action: op.action,
        quarantineClass: "kind-retired",
        reason: `'${op.kind}' is no longer authorable by the compactor; work state belongs to the obligation store `,
      });
      continue;
    }

    if (op.action === "add") {
      const statement = op.statement.trim();
      if (!statement) {
        quarantined.push({
          sourceEventId: op.sourceEventId,
          action: op.action,
          quarantineClass: "missing-statement",
          reason: "compactor add operation requires a statement",
        });
        continue;
      }
      if (op.kind === "constraint" && evidence.sender === input.actorId) {
        quarantined.push({
          sourceEventId: op.sourceEventId,
          action: op.action,
          quarantineClass: "self-authored-add",
          reason: `cannot add ${op.kind} with self-authored evidence; requires a different sender`,
        });
        continue;
      }
      const item: PortableMemoryItem = {
        id: stableItemId(input.actorId, op),
        kind: op.kind,
        priority: op.priority,
        status: "active",
        statement,
        evidence: [evidence],
        updatedAt: input.now,
      };
      const existing = items.find((candidate) => candidate.id === item.id);
      if (existing) {
        existing.evidence = [...existing.evidence, evidence];
        existing.updatedAt = input.now;
      } else {
        items.push(item);
      }
      continue;
    }

    const item = items.find((candidate) => candidate.id === op.itemId);
    if (!item) {
      quarantined.push({
        sourceEventId: op.sourceEventId,
        action: op.action,
        quarantineClass: "unknown-item",
        reason: `compactor referenced unknown memory item ${op.itemId}`,
      });
      continue;
    }
    // Items of a retired kind that predate the cut are frozen provenance: still
    // readable, still queryable, but not updatable, supersedable or resolvable
    // by the fold. Completing that work is the obligation store's business now,
    // and ISSUE_NUM criterion 3 puts it out of the compactor's reach entirely — not
    // just creation, but completion and cancellation too.
    if (isRetiredMemoryKind(item.kind)) {
      quarantined.push({
        sourceEventId: op.sourceEventId,
        action: op.action,
        quarantineClass: "kind-retired",
        reason: `memory item ${item.id} is a retired '${item.kind}' and is immutable provenance; change the corresponding obligation instead `,
      });
      continue;
    }
    if (op.action === "update") {
      const statement = op.statement.trim();
      if (!statement) {
        quarantined.push({
          sourceEventId: op.sourceEventId,
          action: op.action,
          quarantineClass: "missing-statement",
          reason: "compactor update operation requires a statement",
        });
        continue;
      }
      if (
        (item.kind === "constraint" || item.kind === "decision" || item.kind === "rationale") &&
        op.kind !== item.kind
      ) {
        quarantined.push({
          sourceEventId: op.sourceEventId,
          action: op.action,
          quarantineClass: "kind-immutable",
          reason: `cannot change kind of '${item.kind}' item to '${op.kind}' via update`,
        });
        continue;
      }
      if (item.kind === "constraint" && evidence.sender === input.actorId) {
        quarantined.push({
          sourceEventId: op.sourceEventId,
          action: op.action,
          quarantineClass: "self-authored-update",
          reason: `cannot update ${item.kind} with self-authored evidence; requires a different sender`,
        });
        continue;
      }
      item.kind = op.kind;
      item.priority = op.priority;
      item.statement = statement;
      item.status = "active";
    } else if (op.action === "resolve") {
      // `resolve` was only ever legal on `commitment` and `open_question`, and
      // both are retired above, so nothing reaching here is resolvable. The
      // action is kept in the PARSED schema rather than dropped from it so a
      // model still emitting it costs one quarantined operation with a class
      // the metric can group by — not a `parse()` failure that discards the
      // batch. The generation schema no longer offers it , so this path
      // is now reached only by an operation this compactor did not generate.
      quarantined.push({
        sourceEventId: op.sourceEventId,
        action: op.action,
        quarantineClass: "kind-not-resolvable",
        reason: `cannot resolve memory item of kind '${item.kind}'; resolution now belongs to the obligation store `,
      });
      continue;
    } else if (op.action === "supersede") {
      // Constraint only, matching the `add` and `update` gates above .
      // Guarding `decision` and `rationale` here was backwards for provenance:
      // the same actor may rewrite one of them in place via `update`, which
      // destroys the old statement, but could not supersede it, which is the
      // form that KEEPS the old item and its evidence as history. The strict
      // gate sat on the less destructive operation. `constraint` stays
      // protected because self-authored restatement is not revocation.
      if (item.kind === "constraint" && evidence.sender === input.actorId) {
        quarantined.push({
          sourceEventId: op.sourceEventId,
          action: op.action,
          quarantineClass: "self-authored-supersede",
          reason: `cannot supersede ${item.kind} with self-authored evidence; requires a different sender`,
        });
        continue;
      }
      item.status = "superseded";
    }
    item.evidence = [...item.evidence, evidence];
    item.updatedAt = input.now;
  }

  return {
    state: {
      ...input.state,
      generation: input.state.generation + 1,
      updatedAt: input.now,
      lastFoldedSourceId: input.messages.at(-1)?.id ?? input.state.lastFoldedSourceId,
      compactor: { provider: "gemini", model: input.model },
      items,
    },
    quarantined,
    operations: input.operations.length,
  };
}

function compactorPrompt(
  state: PortableContextState,
  messages: PortableLedgerSource[],
  actorId: string
): string {
  const active = state.items
    .filter((item) => item.status === "active")
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      priority: item.priority,
      statement: item.statement,
      evidence: item.evidence.map((evidence) => ({
        eventId: evidence.eventId,
        quote: evidence.quote,
      })),
    }));
  // `origin` and `status` are the discriminator the system instruction anchors
  // on: without them the model cannot tell an inbound request from this actor's
  // own recorded outcome, and would discard the latter as a routine status step.
  const sources = messages.map((message) => ({
    eventId: message.id,
    ts: message.ts,
    origin: isSelfAuthoredLedgerSource(message.kind) ? "self (your own yield note)" : "inbound",
    sender: senderOf(message, actorId),
    status: message.detail,
    body: message.body ?? "",
  }));
  return `Current active memory:\n${JSON.stringify(active, null, 2)}\n\nNew sources:\n${JSON.stringify(sources, null, 2)}`;
}

export class GeminiPortableContextCompactor implements PortableContextCompactor {
  constructor(
    private readonly apiKey: string,
    readonly model = DEFAULT_PORTABLE_CONTEXT_COMPACTOR_MODEL
  ) {}

  async compact(input: {
    actorId: string;
    state: PortableContextState;
    messages: PortableLedgerSource[];
    now: string;
  }): Promise<CompactionResult> {
    if (input.messages.length === 0) return { state: input.state, quarantined: [], operations: 0 };
    const client = getGeminiClient(this.apiKey);
    const response = await withGeminiRetry(() =>
      client.models.generateContent({
        model: this.model,
        contents: compactorPrompt(input.state, input.messages, input.actorId),
        config: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              operations: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    // Only what the ledger still honors. `resolve` stays in the
                    // parsed enum below and is deliberately absent here: the
                    // parse enum decides what a stray operation COSTS (one
                    // quarantined op, not a discarded batch), while this enum
                    // decides what the model can emit at all. Since ISSUE_NUM no
                    // authorable kind is resolvable, so every `resolve` this
                    // schema permitted could only ever become a quarantine —
                    // including the invented-item-id class in ISSUE_NUM, which was
                    // a `resolve` naming an item the same batch had just added
                    // and whose server-minted id the model never saw.
                    action: { type: Type.STRING, enum: ["add", "update", "supersede"] },
                    itemId: { type: Type.STRING },
                    kind: {
                      type: Type.STRING,
                      // Only what the compactor may author. The persisted enum
                      // is wider and stays that way — see portable-context-state.ts.
                      enum: ["constraint", "decision", "rationale"],
                    },
                    priority: { type: Type.STRING, enum: ["must", "should", "background"] },
                    statement: { type: Type.STRING },
                    sourceEventId: { type: Type.STRING },
                    quote: { type: Type.STRING },
                  },
                  required: [
                    "action",
                    "itemId",
                    "kind",
                    "priority",
                    "statement",
                    "sourceEventId",
                    "quote",
                  ],
                },
              },
            },
            required: ["operations"],
          },
          systemInstruction:
            "Maintain a general-purpose actor's durable intent ledger. The actor may perform software work, " +
            "research, physical design, analysis, content creation, or coordination. Extract only information " +
            "that must survive after recent conversation is gone: explicit constraints, decisions, and the " +
            "rationale behind them. Ignore transient status requests, greetings, and routine task steps. " +
            "This ledger does NOT hold work state. Commitments, tasks, and unresolved questions live in the " +
            "actor's obligation store, which only the actor may write; never record one here, and never record " +
            "that one was completed, cancelled or reassigned. Record the durable constraint or decision such a " +
            "message establishes, if any, and otherwise emit nothing for it. " +
            "A source with origin `self` is this actor's own recorded outcome of a past run, not a transient " +
            "status request: fold the durable constraint or decision it reveals, not the task it reports on. " +
            "Use add for new durable facts, update for refinements, and supersede when a newer message replaces " +
            "an existing item. For add, itemId must be an " +
            "empty string. For other actions use an existing item id. Every operation must cite one NEW source " +
            "event and quote an exact non-empty substring from its body. A replacement generally needs both a " +
            "supersede operation for the old item and an add operation for the new one. Return no operations " +
            "when the messages contain no durable memory.",
          httpOptions: { timeout: 60_000 },
        },
      })
    );
    const parsed = compactionResponseSchema.parse(JSON.parse(await extractGeminiText(response)));
    return applyCompactionOperations({
      ...input,
      operations: parsed.operations,
      model: this.model,
    });
  }
}
