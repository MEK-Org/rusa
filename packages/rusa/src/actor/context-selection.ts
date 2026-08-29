import type { ContextConfig } from "./thread-registry.js";

/**
 * What a spawn caller may ask for on the wire — one flat vocabulary shared by
 * the actor-facing MCP tool, the dashboard control API, and the E2E harness, so
 * there is exactly one spelling of each choice across the system.
 *
 * - `native` — the provider owns the session (the default; unchanged behaviour).
 * - `ledger` — the mesh owns the context as a rolling digest plus a verbatim
 *   recent-message journal, compacted after each run. This is the mode the
 *   feature is *for*, and what to reach for unless you have a reason not to.
 * - `tail` — the mesh owns the context as a bounded raw window with no
 *   compaction and no LLM in the loop; useful for experiments that want the
 *   aging boundary without a compactor.
 *
 * There is deliberately no bare `portable` selection. `ledger` and `tail` ARE
 * the portable modes, so a fourth word naming their family would sit at a
 * different level than the other three and leave "portable vs ledger" reading
 * as a real choice when it is not one. One field, one level: name the mode.
 */
export const CONTEXT_SELECTIONS = ["native", "ledger", "tail"] as const;
export type ContextSelection = (typeof CONTEXT_SELECTIONS)[number];

export function isContextSelection(value: unknown): value is ContextSelection {
  return typeof value === "string" && (CONTEXT_SELECTIONS as readonly string[]).includes(value);
}

/**
 * Turn a wire-level selection into the durable {@link ContextConfig}, or throw
 * with a message naming the valid values.
 *
 * Returns `undefined` for "not specified", which the registry already reads as
 * native — spawning without a selection must leave the record byte-identical to
 * what it was before this door existed.
 *
 * A `compactionModel` supplied alongside a selection that never compacts is an
 * ERROR, not an ignored field. Accepting a knob that cannot take effect is the
 * failure this whole arc keeps finding: a setting that reads as configured while
 * measuring — or here, controlling — nothing.
 */
export function resolveContextSelection(
  selection: unknown,
  opts: { compactionModel?: unknown } = {}
): ContextConfig | undefined {
  if (opts.compactionModel !== undefined && typeof opts.compactionModel !== "string") {
    throw new Error("compactionModel must be a string when set");
  }
  const compactionModel = opts.compactionModel?.trim() || undefined;
  const raw = typeof selection === "string" ? selection.trim() : selection;

  if (raw === undefined || raw === null || raw === "") {
    if (compactionModel) {
      throw new Error("compactionModel requires a portable context selection (ledger)");
    }
    return undefined;
  }
  if (!isContextSelection(raw)) {
    throw new Error(
      `unknown context selection: ${String(raw)} (expected one of ${CONTEXT_SELECTIONS.join(", ")})`
    );
  }
  if (raw === "native") {
    if (compactionModel) {
      throw new Error("compactionModel is meaningless for native context");
    }
    return { type: "native" };
  }
  if (raw === "tail") {
    if (compactionModel) {
      // Tail is the raw window: nothing ever compacts it, so a model here would
      // be accepted, stored, and never consulted.
      throw new Error("compactionModel is meaningless for tail mode, which never compacts");
    }
    return { type: "portable", mode: "tail" };
  }
  return { type: "portable", mode: "ledger", compactionModel };
}

/**
 * Validate and normalize the durable object form used in configuration and the
 * thread registry. The mode-specific rules stay delegated to
 * {@link resolveContextSelection}, so YAML and spawn callers cannot drift.
 */
export function resolveContextConfig(value: unknown): ContextConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("context must be a mapping when set");
  }

  const context = value as Record<string, unknown>;
  if (context.type === "native") {
    if (context.mode !== undefined) {
      throw new Error("mode is meaningless for native context");
    }
    return resolveContextSelection("native", { compactionModel: context.compactionModel });
  }
  if (context.type === "portable") {
    return resolveContextSelection(context.mode, { compactionModel: context.compactionModel });
  }
  throw new Error(
    `unknown context type: ${String(context.type)} (expected one of native, portable)`
  );
}

/**
 * The structural gate on a portable spawn, run at the mesh's single `spawn`
 * choke point so every caller — MCP tool, root control, dashboard, the A/B rig —
 * passes through it.
 *
 * Both refusals exist because the alternative is a silent lie:
 *
 * - A portable actor is invoked STATELESS, so `loadSessionId` returns undefined
 *   and a seeded `conversationId` would be written to the record and then never
 *   resumed. The caller would believe it promoted a conversation into an actor
 *   and get a blank one.
 * - Ledger compaction needs an API key. Without it `buildPrompt` throws on every
 *   run, so the actor is born unable to run at all. Failing at spawn — once,
 *   where the operator is looking — beats a thread that exists and fails forever.
 */
export function assertSpawnContextSupported(
  req: { context?: ContextConfig; conversationId?: string },
  caps: { ledgerCompactionAvailable: boolean }
): void {
  const context = req.context;
  if (context?.type !== "portable") return;
  if (req.conversationId) {
    throw new Error(
      "a portable-context actor is called stateless and never resumes a provider conversation; " +
        "drop conversationId or spawn it with native context"
    );
  }
  if (context.mode === "ledger" && !caps.ledgerCompactionAvailable) {
    throw new Error(
      "portable ledger mode needs a Gemini API key for compaction (config geminiApiKey); " +
        "set it, or spawn with tail mode which never compacts"
    );
  }
}
