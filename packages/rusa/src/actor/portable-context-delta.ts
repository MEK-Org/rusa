import type { PortableLedgerSource } from "../db/repositories/actor-run-repository.js";
import type { PriorMessage, PriorRun } from "./portable-context.js";

/**
 * Compacted memory plus delta (#1062) — the pure selection step.
 *
 * In ledger mode the prompt today carries the compacted ledger AND a fixed
 * window of the most recent inbound messages and run outputs, whether or not
 * the fold already absorbed them. Under the `compacted_memory_delta`
 * experiment the verbatim journal is instead the *delta*: the durable sources
 * recorded after the ledger's fold cursor (`lastFoldedSourceId`), which the
 * ledger has not seen yet. Everything before the cursor is represented by the
 * ledger alone.
 *
 * This module has no db dependency, mirroring `portable-context.ts`: the wiring
 * in `commands/start.ts` pages `listLedgerSourcesAfter` from the cursor and
 * hands the unfolded sources here. The one deliberate exception to "delta only"
 * is the most recent completed run, which is always kept: the ledger distils
 * constraints and decisions, not "what I just did", and a successor that cannot
 * see its own last output loses the thread it was in the middle of.
 */

/** How the verbatim journal was selected. Absent on an inject record means `window`. */
export type PortableJournalMode = "window" | "delta";

/** Content-free accounting for the inject record, so the A/B can tell the two apart. */
export interface PortableJournalRecord {
  mode: PortableJournalMode;
  /** The ledger's fold cursor at inject time; null when the actor has never folded. */
  foldCursor: string | null;
  /** Durable sources after the cursor that the wiring read, before any budget. */
  unfoldedSources: number;
  unfoldedMessages: number;
  unfoldedYields: number;
  /** True when the unfolded tail was longer than the wiring's page ceiling. */
  truncated: boolean;
}

export interface DeltaJournal {
  /** Unfolded inbound messages, NEWEST-FIRST — the assembler's input convention. */
  messages: PriorMessage[];
  /** Runs still shown verbatim, NEWEST-FIRST: unfolded yields plus the latest run. */
  runs: PriorRun[];
  unfoldedSources: number;
  unfoldedMessages: number;
  unfoldedYields: number;
}

/**
 * Pick the journal for a delta-mode prompt.
 *
 * - `unfolded` is the page sequence `listLedgerSourcesAfter` returns: oldest
 *   first, interleaving `message_received` and `run_yielded`.
 * - `recentRuns` is the actor's recent completed runs NEWEST-FIRST, exactly the
 *   window the fixed journal would have used.
 * - `maxMessages` keeps the count cap the window journal has, applied to the
 *   newest unfolded messages; the byte budget in `assemblePortableContextV2`
 *   still applies after this.
 */
export function selectDeltaJournal(input: {
  unfolded: PortableLedgerSource[];
  recentRuns: PriorRun[];
  maxMessages: number;
}): DeltaJournal {
  const messages: PriorMessage[] = [];
  const unfoldedYieldIds = new Set<string>();
  for (const source of input.unfolded) {
    if (source.kind === "message_received") {
      messages.push({
        id: source.id,
        ts: source.ts,
        sender: senderOf(source),
        body: source.body,
      });
    } else {
      unfoldedYieldIds.add(source.id);
    }
  }
  const newestFirst = messages.reverse();
  const runs = input.recentRuns.filter((run, index) => index === 0 || unfoldedYieldIds.has(run.id));
  return {
    messages: newestFirst.slice(0, Math.max(0, input.maxMessages)),
    runs,
    unfoldedSources: input.unfolded.length,
    unfoldedMessages: messages.length,
    unfoldedYields: unfoldedYieldIds.size,
  };
}

function senderOf(source: PortableLedgerSource): string {
  if (source.payload) {
    try {
      const parsed = JSON.parse(source.payload) as { from?: unknown };
      if (typeof parsed.from === "string" && parsed.from) return parsed.from;
    } catch {}
  }
  return "unknown";
}
