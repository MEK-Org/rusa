import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface HaltState {
  reason?: string;
  providers?: string[];
  until?: string;
}

export interface HaltCommand {
  providers?: string[];
  until?: string;
}

/**
 * A mechanical, file-backed emergency brake for the mesh. A legacy empty/plain
 * sentinel remains a global indefinite halt. Structured halts are stored as JSON
 * so they can target providers and/or expire at a requested datetime.
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
 * a hand-edit. `isHalted()` asks whether a provider (or the whole system) is
 * halted; `hasActiveHalt()` asks whether any provider scope is active.
 */
export class HaltSwitch {
  constructor(
    private readonly file: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** True iff an active sentinel applies system-wide or to `provider`. */
  isHalted(provider?: string): boolean {
    const state = this.state();
    if (!state) return false;
    if (!state.providers?.length) return true;
    if (!provider) return false;
    return state.providers.includes(normalizeProvider(provider));
  }

  /** True iff any global or provider-scoped halt is active. */
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
    return {
      ...(typeof value.reason === "string" && value.reason ? { reason: value.reason } : {}),
      ...(providers?.length ? { providers: [...new Set(providers)] } : {}),
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
    } else if (key === "until") {
      const timestamp = Date.parse(value);
      if (!Number.isFinite(timestamp)) throw new Error(`invalid halt datetime "${value}"`);
      result.until = new Date(timestamp).toISOString();
    } else {
      throw new Error(`unknown halt option "${key}"`);
    }
  }
  return result;
}

function normalizeProvider(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === "agy" ? "antigravity" : normalized;
}
