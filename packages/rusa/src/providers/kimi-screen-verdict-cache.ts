import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The semantic states that control the Kimi PTY probe. */
export type KimiScreenState =
  | "ready"
  | "trust_prompt"
  | "usage_panel"
  | "auth_required"
  | "unknown";

export const KIMI_SCREEN_STATES: readonly KimiScreenState[] = [
  "ready",
  "trust_prompt",
  "usage_panel",
  "auth_required",
  "unknown",
];

/**
 * The state this value names, or null if the vocabulary does not name it.
 *
 * Null is NOT `"unknown"`. `"unknown"` is a verdict — something looked at a screen and
 * reported it could not tell. Null is the absence of a verdict: nothing usable came back,
 * so the question has not been answered and must be asked again. Collapsing the two is how
 * a schema failure gets recorded as if the model had answered (seal's must-fix on ISSUE_NUM).
 */
export function recognizeKimiScreenState(value: unknown): KimiScreenState | null {
  return typeof value === "string" && KIMI_SCREEN_STATES.includes(value as KimiScreenState)
    ? (value as KimiScreenState)
    : null;
}

/**
 * Whitespace-only normalization of a captured pane.
 *
 * Deliberately the weakest normalization that still makes two captures of an unchanged
 * screen compare equal: `tmux capture-pane` pads or clips the right edge depending on
 * when it samples, so per-line `trimEnd` plus a trim of leading/trailing blank lines is
 * what separates "the same screen, sampled twice" from "a different screen". Nothing
 * here looks at the screen's *content* — no patterns, no field extraction — because the
 * moment normalization starts erasing meaningful text (a countdown, a percentage) the
 * replay stops being a replay of the same screen and becomes a parser, which is exactly
 * what ISSUE_NUM and the no-new-regex rule forbid.
 */
export function normalizeScreen(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

/**
 * A pane with no content on it at all.
 *
 * The first captures of every probe are an empty terminal — the CLI has not painted yet.
 * There is nothing on such a screen for a classifier to be right or wrong about, and the
 * classifier's own instruction says to answer `unknown` when the evidence is incomplete,
 * so spending a model call to be told that is pure waste. This is a check for the ABSENCE
 * of any evidence, not an interpretation of evidence: it can only ever produce `unknown`.
 */
export function screenIsBlank(raw: string): boolean {
  return normalizeScreen(raw).length === 0;
}

/**
 * Identity of the classifier whose verdicts are being replayed.
 *
 * Folded into every cache key so that changing the model, the instruction, or the state
 * vocabulary invalidates every stored verdict automatically. A replay is only sound while
 * "same screen, same classifier" holds; without this the cache would happily answer today's
 * question with a verdict a different prompt produced.
 */
export function classifierIdFor(
  model: string,
  systemInstruction: string,
  states: readonly string[]
): string {
  return createHash("sha256")
    .update(`${model}\n${systemInstruction}\n${states.join(",")}`)
    .digest("hex")
    .slice(0, 16);
}

export interface KimiScreenVerdictStats {
  /** Verdicts answered from a prior classification. */
  hits: number;
  /** Screens that reached the classifier because nothing was stored for them. */
  misses: number;
  /** Verdicts recorded (a `known` classification of a screen not already stored). */
  stored: number;
  /** Entries loaded from disk when this cache opened. */
  loaded: number;
  /**
   * Why this cache is memory-only, or null when it is backed by a file. Non-null is not a
   * failure to report upward: the probe still works, it just cannot replay across processes.
   */
  degraded: string | null;
}

/** Bounded so a long-lived probe dir cannot grow an unbounded verdict file. */
export const MAX_CACHED_VERDICTS = 256;

/**
 * Exact-match replay of past Kimi screen verdicts (ISSUE_NUM, root's sequenced step 1).
 *
 * ## What this is and is not
 * It stores what the LLM already decided about a byte-identical screen and returns that
 * same answer. It never decides anything itself: an unseen screen is a miss, and a miss
 * always reaches the model. Replaying a recorded verdict is not a parser and not a regex —
 * the interpretation plane is still entirely the model's.
 *
 * ## Why it is on disk
 * `scrapeKimiUsage` runs inside a short-lived probe process, so an in-process memo is dead
 * before the next reading. Measured on this worker plane (3 readings, 24 panes): the boot
 * panes are byte-identical ACROSS readings, so cross-process replay is where the win is.
 *
 * ## What it deliberately does not cache
 * Only `known` classifications are stored. An evaluation *failure* — model error, exhausted
 * pool, no key — is never written, because a cached failure would turn a transient outage
 * into a sticky one, which is precisely the dishonest degradation ISSUE_NUM exists to close.
 * (A `known` verdict of `"unknown"` IS stored: the model looked at that screen and found no
 * evidence, and it will find none there again.)
 *
 * ## Failure posture
 * A cache must never be able to break the probe. Unreadable, corrupt, or version-mismatched
 * files load as empty; unwritable paths (this plane hits EROFS, see ISSUE_NUM) degrade to
 * memory-only and say so in `stats().degraded`. No method throws.
 */
export class KimiScreenVerdictCache {
  private readonly entries = new Map<string, KimiScreenState>();
  private readonly counters = { hits: 0, misses: 0, stored: 0, loaded: 0 };
  private degraded: string | null = null;

  constructor(
    private readonly path: string | null,
    private readonly classifierId: string
  ) {
    if (path === null) {
      this.degraded = "no cache path configured; verdicts are replayed within this run only";
      return;
    }
    this.load();
  }

  /** The recorded verdict for this exact screen, or null if it has never been classified. */
  get(raw: string): KimiScreenState | null {
    const found = this.entries.get(this.keyFor(raw));
    if (found === undefined) {
      this.counters.misses++;
      return null;
    }
    this.counters.hits++;
    return found;
  }

  /** Record a `known` classification. Callers must not pass evaluation failures. */
  set(raw: string, state: KimiScreenState): void {
    const key = this.keyFor(raw);
    // Re-inserting moves the entry to the end of the Map's iteration order, so the eviction
    // below drops the least recently written rather than an entry still in active use.
    this.entries.delete(key);
    this.entries.set(key, state);
    this.counters.stored++;
    while (this.entries.size > MAX_CACHED_VERDICTS) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.persist();
  }

  stats(): KimiScreenVerdictStats {
    return { ...this.counters, degraded: this.degraded };
  }

  private keyFor(raw: string): string {
    return createHash("sha256")
      .update(`${this.classifierId}\n${normalizeScreen(raw)}`)
      .digest("hex");
  }

  private load(): void {
    if (this.path === null || !existsSync(this.path)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return;
      const file = parsed as { classifierId?: unknown; entries?: unknown };
      // A different classifier wrote this file: its verdicts answer a different question.
      if (file.classifierId !== this.classifierId) return;
      if (!Array.isArray(file.entries)) return;
      for (const candidate of file.entries) {
        const entry = candidate as { key?: unknown; state?: unknown };
        if (typeof entry.key !== "string") continue;
        // Anything the current vocabulary does not name is dropped, not coerced: a verdict
        // silently rewritten to `unknown` would be a fabricated classification.
        const state = recognizeKimiScreenState(entry.state);
        if (state === null) continue;
        this.entries.set(entry.key, state);
      }
      this.counters.loaded = this.entries.size;
    } catch (err) {
      // Corrupt or unreadable: start empty rather than fail the reading it serves.
      this.entries.clear();
      this.degraded = `could not read verdict cache: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private persist(): void {
    if (this.path === null) return;
    const file = {
      classifierId: this.classifierId,
      entries: [...this.entries].map(([key, state]) => ({ key, state })),
    };
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.path);
      this.degraded = null;
    } catch (err) {
      this.degraded = `verdict cache is memory-only: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Best effort: a leftover temp file is not worth failing a quota reading over.
      }
    }
  }
}
