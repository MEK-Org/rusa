import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HaltState {
  reason?: string;
  providers?: string[];
  models?: string[];
  until?: string;
}

export interface HaltCommand {
  providers?: string[];
  models?: string[];
  until?: string;
}

/**
 * A mechanical, file-backed emergency brake for the mesh. A legacy empty/plain
 * sentinel remains a global indefinite halt. Structured halts are stored as JSON
 * so they can target providers, models, and/or expire at a requested datetime.
 *
 *  - by hand on the box:   `touch ~/.rusa/HALT`  /  `rm ~/.rusa/HALT`
 *  - by chat command:      `/halt` / `/resume` are matched mechanically at the
 *    chat-ingestion edge and just create/remove this same file
 *  - super-fallback:       pull the VM plug
 *
 * Enforcement is in every actor's `beforeRun`: a halted run is skipped, and a
 * skipped run does not self-continue, so the mesh quiesces within one run-cycle.
 * In-flight runs are allowed to finish (this is a brake on *starting* work, not a
 * kill -9); the plug is the hard stop.
 *
 * Every query reads the file — there is no cached state to get out of sync with
 * a hand-edit. `isHalted()` asks whether a provider/model (or the whole system) is
 * halted; `hasActiveHalt()` asks whether any provider or model scope is active.
 */
export class HaltSwitch {
  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** True iff an active sentinel applies system-wide, to `provider`, or to `model`. */
  isHalted(provider?: string, model?: string): boolean {
    const state = this.state();
    if (!state) return false;
    if (!state.providers?.length && !state.models?.length) return true;
    if (!provider) return false;
    const providerMatches =
      !state.providers?.length || state.providers.includes(normalizeProvider(provider));
    if (!providerMatches) return false;
    if (state.models?.length) {
      // A model-scoped hold is a brake: a caller that cannot identify its
      // selected model must not run on the held provider. Normal selection
      // always carries a validated model; this protects less-specific callers
      // while they are brought to that same boundary.
      if (!model) return true;
      return state.models.includes(normalizeModel(model));
    }
    return true;
  }

  /** True iff any global or provider/model-scoped halt is active. */
  hasActiveHalt(): boolean {
    return this.state() !== null;
  }

  /**
   * Create the sentinel. Returns false without changing it when an active halt
   * already exists; operators must `/resume` before choosing a different scope.
   */
  halt(reason = "", options: HaltCommand = {}): boolean {
    if (this.state()) return false;
    mkdirSync(dirname(this.file), { recursive: true });
    const state: HaltState = {
      ...(reason ? { reason } : {}),
      ...(options.providers?.length
        ? { providers: [...new Set(options.providers.map(normalizeProvider))] }
        : {}),
      ...(options.models?.length
        ? { models: [...new Set(options.models.map(normalizeModel))] }
        : {}),
      ...(options.until ? { until: new Date(options.until).toISOString() } : {}),
    };
    writeFileSync(this.file, `${JSON.stringify(state)}\n`, "utf8");
    return true;
  }

  /** Remove the sentinel (idempotent — resuming an already-running mesh is fine). */
  resume(): void {
    rmSync(this.file, { force: true });
  }

  /** The reason recorded at halt time, if any (best-effort; empty when unknown). */
  reason(): string {
    return this.state()?.reason ?? "";
  }

  /** Active structured state, or null for absent/expired/corrupt sentinels. */
  state(): HaltState | null {
    if (!existsSync(this.file)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8").trim();
    } catch {
      return null;
    }
    // `touch ~/.rusa/HALT` and pre-structured reason files are global,
    // indefinite halts for backward compatibility.
    if (!raw) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { reason: raw };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const value = parsed as Record<string, unknown>;
    const until = typeof value.until === "string" ? value.until : undefined;
    if (until) {
      const timestamp = Date.parse(until);
      if (!Number.isFinite(timestamp) || timestamp <= this.now()) return null;
    }
    const providers = Array.isArray(value.providers)
      ? value.providers
          .filter((provider): provider is string => typeof provider === "string")
          .map(normalizeProvider)
          .filter(Boolean)
      : undefined;
    const models = Array.isArray(value.models)
      ? value.models
          .filter((model): model is string => typeof model === "string")
          .map(normalizeModel)
          .filter(Boolean)
      : undefined;
    return {
      ...(typeof value.reason === "string" && value.reason ? { reason: value.reason } : {}),
      ...(providers?.length ? { providers: [...new Set(providers)] } : {}),
      ...(models?.length ? { models: [...new Set(models)] } : {}),
      ...(until ? { until } : {}),
    };
  }
}

/** Parse `/halt` atoms without involving an actor/LLM. */
export function parseHaltCommand(text: string): HaltCommand | null {
  const match = text.trim().match(/^\/(?:halt|pause)(?:\s+(.*))?$/i);
  if (!match) return null;
  const tail = match[1]?.trim();
  if (!tail) return {};

  const result: HaltCommand = {};
  for (const atom of tail.split(/\s+/)) {
    const separator = atom.indexOf(":");
    if (separator <= 0 || separator === atom.length - 1) {
      throw new Error(`invalid halt option "${atom}"`);
    }
    const key = atom.slice(0, separator).toLowerCase();
    const value = atom.slice(separator + 1);
    if (key === "provider") {
      const providers = value.split(",").map(normalizeProvider).filter(Boolean);
      if (providers.length === 0) throw new Error("provider list cannot be empty");
      result.providers = [...new Set(providers)];
    } else if (key === "model") {
      const models = value.split(",").map(normalizeModel).filter(Boolean);
      if (models.length === 0) throw new Error("model list cannot be empty");
      result.models = [...new Set(models)];
    } else if (key === "until") {
      const timestamp = Date.parse(value);
      if (!Number.isFinite(timestamp)) throw new Error(`invalid halt datetime "${value}"`);
      result.until = new Date(timestamp).toISOString();
    } else {
      throw new Error(`unknown halt option "${key}"`);
    }
  }
  if (result.models?.length && !result.providers?.length) {
    throw new Error("model-scoped halt requires a provider");
  }
  return result;
}

export function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === "agy" ? "antigravity" : normalized;
}

function normalizeModel(model: string): string {
  return model.trim().toLowerCase();
}

/** One `/halt model:` scope that no pool entry names. */
export interface UnpooledHaltModel {
  /** The model as the operator named it, so the warning quotes them back. */
  model: string;
  /** Closest pool entries, nearest first — what they probably meant. */
  nearest: string[];
}

/** How many pool entries a warning offers back before it stops being a hint. */
const NEAREST_POOL_ENTRIES = 2;

/**
 * The `models` that no entry of `pooled` names, each with the closest pool
 * entries to offer back.
 *
 * This is advisory and never a gate: halting a model that is not yet pooled is
 * deliberate — an operator staging a rollout wants the hold in place *before*
 * the model appears, so the first run on it cannot start. The caller places
 * the halt as asked and uses this only to say what the mesh can presently see.
 *
 * Comparison is case-insensitive because {@link parseHaltCommand} lowercases
 * what was typed while a pool keeps the provider's own casing; a literal
 * compare would warn about models that are in fact held.
 *
 * An empty `pooled` yields nothing. A provider no live actor is using cannot
 * tell a typo from a model the mesh has not been told about yet, and warning
 * on every name there would teach the operator to ignore the warning.
 */
export function findUnpooledHaltModels(
  models: readonly string[],
  pooled: readonly string[]
): UnpooledHaltModel[] {
  if (pooled.length === 0) return [];
  const known = new Set(pooled.map(normalizeModel));
  const findings: UnpooledHaltModel[] = [];
  for (const model of models) {
    const normalized = normalizeModel(model);
    if (known.has(normalized)) continue;
    // Pool entries retain their configured spelling, but matching is
    // case-insensitive. Keep one stable spelling per semantic model so a
    // suggestion cannot spend both of its slots on casing variants.
    const distinct = new Map<string, string>();
    for (const entry of pooled) {
      const key = normalizeModel(entry);
      const existing = distinct.get(key);
      if (existing === undefined || entry.localeCompare(existing) < 0) distinct.set(key, entry);
    }
    const nearest = [...distinct.values()]
      .map((entry) => ({ entry, distance: editDistance(normalized, normalizeModel(entry)) }))
      .sort((a, b) => a.distance - b.distance || a.entry.localeCompare(b.entry))
      .slice(0, NEAREST_POOL_ENTRIES)
      .map((candidate) => candidate.entry);
    findings.push({ model, nearest });
  }
  return findings;
}

/** Levenshtein distance, for ranking pool entries against a name that missed. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}
