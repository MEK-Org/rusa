import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@google/genai";
import { parse as parseToml } from "smol-toml";
import { extractGeminiText, getGeminiClient } from "../understanding/gemini-utils.js";
import { parseCodexModel } from "./codex.js";

/**
 * One model as presented by a provider and as identified underneath that
 * presentation. These are deliberately separate: equality is valid (Codex),
 * but must never be assumed (agy and Kimi).
 */
export interface ModelEntry {
  displayLabel: string;
  identifier: string;
  /**
   * Whether this model entry is passable as a model pin (CLI `--model` value).
   * True for concrete models; false for quota-group headers/labels
   * (e.g. agy's "Gemini Flash" / "Gemini Pro"). Defaults to true when omitted.
   */
  passable?: boolean;
  /**
   * Allowed reasoning efforts for this specific model, if it exposes a discrete
   * set of supported effort levels.
   */
  efforts?: string[];
}

export type ModelCommandLineField = keyof ModelEntry;

/** Antigravity accepts only Gemini-family model pins in this mesh. */
export function isAntigravityGeminiModel(model: string): boolean {
  return /^gemini(?:[\s._-]|$)/i.test(model.trim());
}

export interface ProviderModelDescriptor {
  provider: string;
  /** The ModelEntry field this provider's CLI accepts for `--model`. */
  commandLineField: ModelCommandLineField;
  extractionGuidance: string;
}

// Source: antigravity.ts's class documentation: agy accepts display names such
// as "Gemini 3.1 Pro (High)", including the effort qualifier.
const antigravityDescriptor: ProviderModelDescriptor = {
  provider: "antigravity",
  commandLineField: "displayLabel",
  extractionGuidance:
    "agy accepts the complete display label, including parenthesized effort qualifiers. Preserve that label exactly; record a distinct underlying identifier only when the raw input supplies one. In the /usage 'Models & Quota' panel, quota group header names (such as 'Gemini Flash' or 'Gemini Pro') under 'Models within this group:' are quota group labels, not passable models — mark them with passable: false. Mark actual tiered models (such as 'Gemini 3.7 Flash (High)', 'Gemini 3.1 Pro (High)') with passable: true.",
};

export const PROVIDER_MODEL_DESCRIPTORS: Readonly<Record<string, ProviderModelDescriptor>> = {
  // Source: Operator's investigation in ISSUE_NUM: Codex /model prints passable model ids.
  codex: {
    provider: "codex",
    commandLineField: "identifier",
    extractionGuidance:
      "Codex displays its passable model slug (e.g. 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5') in the 'Select Model and Effort' menu panel. Do not extract model names from the banner status line or '/model to change' header line. Only extract models listed in the selectable menu panel. If no model selection menu is present, return an empty entries list. Omit UI annotations such as '(current)' and reasoning effort qualifiers such as 'medium', 'low', 'high', 'extra-high'. Copy the plain model slug into both fields. Mark concrete models with passable: true.",
  },
  // Source: Operator's investigation in ISSUE_NUM: Claude displays friendly aliases while
  // the corresponding passable values are claude-* identifiers.
  claude: {
    provider: "claude",
    commandLineField: "identifier",
    extractionGuidance:
      "Claude displays friendly labels and descriptions. Map each selectable non-default model to the corresponding full claude-* identifier when the raw input supplies it (e.g. 'Claude Opus 4.8' maps to 'claude-opus-4-8', replacing periods with hyphens). Mark concrete models with passable: true.",
  },
  // Source: antigravity.ts's class documentation: agy accepts display names such
  // as "Gemini 3.1 Pro (High)", including the effort qualifier.
  antigravity: antigravityDescriptor,
  // Provider configs commonly use the binary name as the provider key.
  agy: antigravityDescriptor,
  // Source: Operator's investigation in ISSUE_NUM: Kimi accepts config keys such as
  // kimi-code rather than display strings such as "K2.7 Coding".
  kimi: {
    provider: "kimi",
    commandLineField: "identifier",
    extractionGuidance:
      "Kimi accepts the config key, not its friendly display string. Only emit entries when both are supplied by the raw input. Mark concrete models with passable: true.",
  },
};

export type ModelCatalogExtraction =
  | { status: "known"; entries: ModelEntry[] }
  | { status: "unknown"; entries: []; message: string };

/**
 * LLM-only extraction seam for vendor enumeration output . Code consumes
 * the structured fields returned by Gemini and never regex/substrings the TUI.
 */
export async function extractModelCatalog(
  rawOutput: string,
  descriptor: ProviderModelDescriptor,
  geminiApiKey?: string
): Promise<ModelCatalogExtraction> {
  const apiKey = geminiApiKey?.trim();
  if (!apiKey) {
    return {
      status: "unknown",
      entries: [],
      message: "no geminiApiKey configured for LLM model catalog parsing",
    };
  }

  // Guard against panel-less captures that contain only the startup banner/status line.
  // Note: Keep regex in sync with buildCodexModelTmuxScript panel detection markers in model-scrape.ts
  if (
    descriptor.provider === "codex" &&
    /(?:model\s*:\s*[^\n]+\/model to change|OpenAI Codex|Welcome to Codex)/i.test(rawOutput) &&
    !/(?:Select Model|Select a model|Select model and effort|[0-9]+\.\s*gpt-)/i.test(rawOutput)
  ) {
    return {
      status: "unknown",
      entries: [],
      message:
        "codex screen capture contains banner status line but no model selection panel rendered",
    };
  }

  try {
    const client = getGeminiClient(apiKey);
    const response = await client.models.generateContent({
      model: "gemini-3.5-flash-lite",
      contents: `Extract the model catalog for provider '${descriptor.provider}' from this raw enumeration output:\n\n${rawOutput}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            entries: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  displayLabel: { type: Type.STRING },
                  identifier: { type: Type.STRING },
                  passable: {
                    type: Type.BOOLEAN,
                    description:
                      "Whether this entry is a passable model pin (true) or a quota group header/label that is not a valid model pin (false).",
                  },
                },
                required: ["displayLabel", "identifier"],
              },
            },
          },
          required: ["entries"],
        },
        systemInstruction:
          "You are a precise model-catalog parser. Return only models grounded in the raw input; never invent or infer an identifier that is not present. " +
          "For each entry, set 'passable' to true if it is a concrete selectable model, or false if it is a quota-group header or non-passable label. " +
          descriptor.extractionGuidance,
      },
    });
    const parsed = JSON.parse(await extractGeminiText(response)) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) {
      throw new Error("structured response omitted entries");
    }
    const entries = parsed.entries
      .filter(
        (entry): entry is ModelEntry =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as ModelEntry).displayLabel === "string" &&
          typeof (entry as ModelEntry).identifier === "string"
      )
      .map((entry) => ({
        displayLabel: entry.displayLabel,
        identifier: entry.identifier,
        ...(typeof (entry as { passable?: unknown }).passable === "boolean"
          ? { passable: (entry as { passable: boolean }).passable }
          : {}),
      }));
    return { status: "known", entries };
  } catch (err) {
    return {
      status: "unknown",
      entries: [],
      message: `LLM model catalog parsing failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export interface ModelScrapeStore {
  recordRaw(opts: { provider: string; scrapedAt: string; rawOutput: string }): string;
  recordParsed(id: string, models: readonly ModelEntry[]): void;
  recordParseError(id: string, error: unknown): void;
  getLatestForProvider?(
    provider: string
  ): { scrapedAt: string; parsedModels: readonly ModelEntry[] | null } | null;
  getLatestParsedForProvider?(
    provider: string
  ): { scrapedAt: string; parsedModels: readonly ModelEntry[] | null } | null;
}

/**
 * Persist raw screen output and parsed model entries following the quota scrape pattern (ISSUE_NUM, ISSUE_NUM).
 * Records raw output before LLM extraction, updates DB on success/failure, and syncs in-memory catalog on success.
 */
export async function recordAndExtractModelCatalog(opts: {
  provider: string;
  rawOutput: string;
  scrapedAt?: string;
  descriptor?: ProviderModelDescriptor;
  geminiApiKey?: string;
  scrapeStore?: ModelScrapeStore;
}): Promise<ModelCatalogExtraction> {
  const scrapedAt = opts.scrapedAt ?? new Date().toISOString();
  let id: string | undefined;
  try {
    id = opts.scrapeStore?.recordRaw({
      provider: opts.provider,
      scrapedAt,
      rawOutput: opts.rawOutput,
    });
  } catch (err) {
    console.warn(
      `[model-catalog] failed to record raw model scrape for ${opts.provider}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const descriptor = opts.descriptor ?? PROVIDER_MODEL_DESCRIPTORS[opts.provider];
  if (!descriptor) {
    const message = `no provider model descriptor configured for "${opts.provider}"`;
    if (id && opts.scrapeStore) {
      try {
        opts.scrapeStore.recordParseError(id, new Error(message));
      } catch {
        /* best effort */
      }
    }
    return {
      status: "unknown",
      entries: [],
      message,
    };
  }

  try {
    const result = await extractModelCatalog(opts.rawOutput, descriptor, opts.geminiApiKey);
    if (result.status === "known" && result.entries.length > 0) {
      if (id && opts.scrapeStore) {
        try {
          opts.scrapeStore.recordParsed(id, result.entries);
        } catch {
          /* best effort */
        }
      }
      setProviderModelCatalog(opts.provider, result.entries);
      return result;
    } else {
      const message =
        result.status === "unknown"
          ? result.message
          : `no models parsed from ${opts.provider} output`;
      if (id && opts.scrapeStore) {
        try {
          opts.scrapeStore.recordParseError(id, new Error(message));
        } catch {
          /* best effort */
        }
      }
      return {
        status: "unknown",
        entries: [],
        message,
      };
    }
  } catch (err) {
    if (id && opts.scrapeStore) {
      try {
        opts.scrapeStore.recordParseError(id, err);
      } catch {
        /* best effort */
      }
    }
    throw err;
  }
}

const catalogs = new Map<string, readonly ModelEntry[]>();

/**
 * Normalizes model entries for a provider if necessary.
 * For Codex, entries that include reasoning effort suffixes (e.g. 'gpt-5.6-sol medium')
 * are normalized to their base model identifier and display label ('gpt-5.6-sol').
 */
export function normalizeModelEntries(
  provider: string,
  entries: readonly ModelEntry[]
): ModelEntry[] {
  if (provider === "codex") {
    const seen = new Set<string>();
    const normalized: ModelEntry[] = [];
    for (const entry of entries) {
      const { model } = parseCodexModel(entry.identifier);
      const slug = model || entry.identifier;
      if (!seen.has(slug)) {
        seen.add(slug);
        normalized.push({
          identifier: slug,
          displayLabel: slug,
          ...(entry.passable !== undefined ? { passable: entry.passable } : {}),
        });
      }
    }
    return normalized;
  }
  if (provider === "agy" || provider === "antigravity") {
    const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
    const baseModels = new Map<string, ModelEntry>();

    for (const entry of entries) {
      if (!isAntigravityGeminiModel(entry.identifier)) {
        continue;
      }
      let parsedBase = entry.identifier;
      let parsedEffort: string | undefined;

      const slugRe = new RegExp(`-(${AGY_EFFORTS.join("|")})$`, "i");
      const match = entry.identifier.match(slugRe);
      if (match) {
        parsedBase = entry.identifier.replace(slugRe, "").trim();
        parsedEffort = match[1].toLowerCase();
      }

      let parsedDisplay = entry.displayLabel;
      const displayRe = new RegExp(`\\s*\\((${AGY_EFFORTS.join("|")})\\)$`, "i");
      const displayMatch = entry.displayLabel.match(displayRe);
      if (displayMatch) {
        parsedDisplay = entry.displayLabel.replace(displayRe, "").trim();
        if (!parsedEffort) parsedEffort = displayMatch[1].toLowerCase();
      }

      let existing = baseModels.get(parsedBase);
      if (!existing) {
        existing = {
          identifier: parsedBase,
          displayLabel: parsedDisplay,
          ...(entry.passable !== undefined ? { passable: entry.passable } : {}),
          efforts: [],
        };
        baseModels.set(parsedBase, existing);
      } else {
        if (entry.passable !== undefined) existing.passable = entry.passable;
      }

      if (parsedEffort && existing.efforts && !existing.efforts.includes(parsedEffort)) {
        existing.efforts.push(parsedEffort);
      }
    }
    return Array.from(baseModels.values());
  }
  return [...entries];
}

/** Host-enumeration seam for a later slice. An absent provider is unknown. */
export function setProviderModelCatalog(provider: string, entries: readonly ModelEntry[]): void {
  catalogs.set(provider, normalizeModelEntries(provider, entries));
}

export function clearProviderModelCatalog(provider?: string): void {
  if (provider) {
    catalogs.delete(provider);
    if (provider === "agy") catalogs.delete("antigravity");
    if (provider === "antigravity") catalogs.delete("agy");
  } else {
    catalogs.clear();
  }
}

export function getProviderModelCatalog(provider: string): readonly ModelEntry[] | undefined {
  const entries =
    catalogs.get(provider) ??
    (provider === "agy"
      ? catalogs.get("antigravity")
      : provider === "antigravity"
        ? catalogs.get("agy")
        : undefined);
  return entries ? [...entries] : undefined;
}

export function getAllProviderModelCatalogs(): ReadonlyMap<string, readonly ModelEntry[]> {
  return new Map(catalogs);
}

/**
 * Populate in-memory catalogs from the latest model scrapes in SQLite.
 * Called at startup to restore known model inventories.
 */
export function populateModelCatalogsFromDb(repo: {
  listLatestForEachProvider(): Map<string, readonly ModelEntry[]>;
}): void {
  const latest = repo.listLatestForEachProvider();
  for (const [provider, entries] of latest) {
    setProviderModelCatalog(provider, entries);
  }
}

export type ModelPinValidation =
  | { status: "accepted"; efforts?: string[] }
  | { status: "unknown"; warning: string };

/**
 * Validate locally before constructing a provider. Absent and empty catalogs
 * are unknown and remain permissive until live enumeration lands.
 * Accepts both slug identifiers (e.g. gemini-3.1-pro-high) and display labels (e.g. Gemini 3.1 Pro (High)) .
 */
export function validateModelPin(provider: string, pin: string): ModelPinValidation {
  const descriptor = PROVIDER_MODEL_DESCRIPTORS[provider];
  const entries = getProviderModelCatalog(provider);
  if (!descriptor || !entries || entries.length === 0) {
    return {
      status: "unknown",
      warning: `model catalog for provider "${provider}" is unknown; allowing pin "${pin}" without validation`,
    };
  }

  const passableEntries = entries.filter((entry) => entry.passable !== false);
  // Kimi's CLI takes only the config key (identifier), never the friendly
  // display_name, so a display-label match here would accept a pin that
  // fails to launch. Every other provider keeps matching either field.
  let matchedEntry = passableEntries.find((entry) =>
    provider === "kimi"
      ? entry.identifier === pin
      : entry.identifier === pin || entry.displayLabel === pin
  );
  let isMatch = !!matchedEntry;

  if (!isMatch && provider === "codex") {
    const { model: pinModel } = parseCodexModel(pin);
    if (pinModel) {
      matchedEntry = passableEntries.find(
        (entry) =>
          entry.identifier === pinModel ||
          entry.displayLabel === pinModel ||
          parseCodexModel(entry.identifier).model === pinModel ||
          parseCodexModel(entry.displayLabel).model === pinModel
      );
      isMatch = !!matchedEntry;
    }
  }
  if (!isMatch) {
    const acceptable = Array.from(
      new Set(
        passableEntries.flatMap((entry) => [entry.displayLabel, entry.identifier]).filter(Boolean)
      )
    );
    throw new Error(
      `model pin validation failed for provider "${provider}": rejected "${pin}"; acceptable values: ${acceptable.length > 0 ? acceptable.map((value) => `"${value}"`).join(", ") : "(none)"}`
    );
  }
  return { status: "accepted", efforts: matchedEntry?.efforts };
}

/**
 * Mechanically extract ModelEntry items from Kimi's config.toml content.
 * Reads the `[models."..."]` tables and emits each config key as the only
 * accepted identifier. The Kimi CLI's `-m/--model` takes the config key
 * ("LLM model alias to use for this invocation"), never the underlying
 * `model` slug, so the bare slug is not advertised.
 */
export function extractKimiModelsFromToml(tomlContent: string): ModelEntry[] {
  try {
    const parsed = parseToml(tomlContent) as Record<string, unknown>;
    const modelsObj = parsed.models;
    if (!modelsObj || typeof modelsObj !== "object" || modelsObj === null) {
      return [];
    }
    const entries: ModelEntry[] = [];

    for (const [key, val] of Object.entries(modelsObj)) {
      if (typeof val !== "object" || val === null) continue;
      const modelVal = val as { display_name?: unknown; model?: unknown };
      const displayLabel =
        typeof modelVal.display_name === "string" && modelVal.display_name.trim()
          ? modelVal.display_name.trim()
          : key;

      entries.push({ displayLabel, identifier: key, passable: true });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Structural parse of `agy models` non-interactive CLI output .
 * Splits two columns: <slug> <display label>.
 */
export function parseAgyModelsOutput(raw: string): ModelEntry[] {
  const lines = raw.split("\n");
  const entries: ModelEntry[] = [];
  for (let line of lines) {
    // Strip spinner noise or ANSI/status prefixes if present
    line = line.replace(/(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]*Fetching available models\.{3})+/gi, "").trim();
    if (!line) continue;
    let identifier: string;
    let displayLabel: string;
    if (line.includes("\t")) {
      // Live `agy models` output separates the columns with a single tab
      const tabIdx = line.indexOf("\t");
      identifier = line.slice(0, tabIdx).trim();
      displayLabel = line.slice(tabIdx + 1).trim();
      if (identifier.includes(" ")) continue; // first column must be a slug, not prose
    } else {
      // Match "<slug>   <display label>" (two-or-more spaces)
      const match = line.match(/^([a-z0-9_.-]+)\s{2,}(.+)$/i);
      if (!match) continue;
      identifier = match[1].trim();
      displayLabel = match[2].trim();
    }
    if (identifier && displayLabel && isAntigravityGeminiModel(identifier)) {
      entries.push({ identifier, displayLabel, passable: true });
    }
  }
  return entries;
}

/**
 * Resolves the host Kimi config.toml path.
 */
export function getHostKimiConfigPath(): string | null {
  const primary = join(process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"), "config.toml");
  if (existsSync(primary)) return primary;
  const legacy = join(homedir(), ".kimi", "config.toml");
  if (existsSync(legacy)) return legacy;
  return null;
}

/**
 * Ingests Kimi's host config.toml:
 * 1. Reads config.toml from disk
 * 2. Mechanically parses model definitions
 * 3. Persists to model_scrapes (using config.toml content as raw_output)
 * 4. Populates in-memory catalog for "kimi"
 */
export function ingestKimiHostModels(opts?: {
  configPath?: string;
  scrapeStore?: ModelScrapeStore;
}): ModelEntry[] {
  const path = opts?.configPath ?? getHostKimiConfigPath();
  if (!path || !existsSync(path)) return [];

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    console.warn(
      `[model-catalog] failed to read kimi config from ${path}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }

  const entries = extractKimiModelsFromToml(content);
  if (entries.length > 0) {
    const scrapedAt = new Date().toISOString();
    try {
      const id = opts?.scrapeStore?.recordRaw({
        provider: "kimi",
        scrapedAt,
        rawOutput: content,
      });
      if (id && opts?.scrapeStore) {
        opts.scrapeStore.recordParsed(id, entries);
      }
    } catch (err) {
      console.warn(
        `[model-catalog] failed to persist kimi model scrape: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    setProviderModelCatalog("kimi", entries);
  }
  return entries;
}

/**
 * The one visibility value the Codex CLI's own model picker lists.
 * Entries carrying any other value (`"hide"`) are reachable by pin but are not
 * what `/model` enumerates, so the catalog does not advertise them.
 */
export const CODEX_LISTED_VISIBILITY = "list";

/**
 * How old the Codex models cache may be and still be preferred over driving the
 * TUI. The CLI rewrites the file whenever it starts, and the daemon refreshes
 * catalogs on start and daily, so a file older than a day means the CLI has not
 * run in that window — and the TUI fallback launches the CLI, which refreshes
 * the file for the next pass. One day is therefore the point where falling back
 * both costs least and repairs the cheap source.
 */
export const CODEX_MODELS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Why a Codex models cache could not be used, or that it could.
 * `malformed` covers every structural problem including a missing or
 * unparseable `fetched_at`, since the freshness rule cannot be applied without
 * one; `stale` is reserved for a well-formed cache that is simply too old.
 */
export type CodexModelsCacheStatus =
  | "usable"
  | "absent"
  | "unreadable"
  | "malformed"
  | "stale"
  | "empty";

export interface CodexModelsCacheRead {
  status: CodexModelsCacheStatus;
  entries: ModelEntry[];
  fetchedAt?: string;
  /** Bounded, path-free explanation, present on every non-usable status. */
  reason?: string;
}

/**
 * Identifier-only projection of a `models_cache.json` document.
 *
 * Two fields are read and no others: `visibility`, to take exactly the subset
 * the picker lists, and `slug`, which is the value codex accepts for `--model`.
 * A cache entry also carries `display_name`, `description`, `availability_nux`
 * and `model_messages` — vendor- and model-authored prose — and #195 settled
 * that catalog validation consumes identifiers only, so none of it is read,
 * stored or advertised. The slug is copied into both fields, which is also
 * exactly what `normalizeModelEntries` reduces a Codex entry to.
 *
 * Returns null when the content is not a cache document at all.
 */
export function extractCodexModelsFromCacheJson(
  content: string
): { fetchedAt?: string; entries: ModelEntry[] } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null) return null;
  const models = (doc as { models?: unknown }).models;
  if (!Array.isArray(models)) return null;
  const rawFetchedAt = (doc as { fetched_at?: unknown }).fetched_at;
  const fetchedAt = typeof rawFetchedAt === "string" ? rawFetchedAt : undefined;

  const seen = new Set<string>();
  const entries: ModelEntry[] = [];
  for (const model of models) {
    if (typeof model !== "object" || model === null) continue;
    const { slug, visibility } = model as { slug?: unknown; visibility?: unknown };
    if (visibility !== CODEX_LISTED_VISIBILITY) continue;
    if (typeof slug !== "string") continue;
    const identifier = slug.trim();
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);
    entries.push({ displayLabel: identifier, identifier, passable: true });
  }
  return { fetchedAt, entries };
}

/** Resolves the host Codex models cache path, honouring `CODEX_HOME` as codex does. */
export function getHostCodexModelsCachePath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
}

/**
 * Read and age-check the host Codex models cache. Every failure is a named
 * status with a bounded reason so the caller can say which stage gave up; the
 * reason never carries a filesystem path, since it ends up in operator-facing
 * logs and issue reports.
 */
export function readCodexModelsCache(opts?: {
  cachePath?: string;
  now?: number;
  maxAgeMs?: number;
}): CodexModelsCacheRead {
  const path = opts?.cachePath ?? getHostCodexModelsCachePath();
  if (!existsSync(path)) {
    return { status: "absent", entries: [], reason: "codex models cache file is absent" };
  }
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    return {
      status: "unreadable",
      entries: [],
      reason: `codex models cache could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = extractCodexModelsFromCacheJson(content);
  if (!parsed) {
    return {
      status: "malformed",
      entries: [],
      reason: "codex models cache is not a JSON document with a models array",
    };
  }
  const fetchedAtMs = parsed.fetchedAt ? Date.parse(parsed.fetchedAt) : Number.NaN;
  if (Number.isNaN(fetchedAtMs)) {
    return {
      status: "malformed",
      entries: [],
      reason: "codex models cache has no parseable fetched_at timestamp",
    };
  }
  const maxAgeMs = opts?.maxAgeMs ?? CODEX_MODELS_CACHE_MAX_AGE_MS;
  const ageMs = (opts?.now ?? Date.now()) - fetchedAtMs;
  if (ageMs > maxAgeMs) {
    return {
      status: "stale",
      entries: [],
      fetchedAt: parsed.fetchedAt,
      reason: `codex models cache is stale (fetched at ${parsed.fetchedAt}, max age ${maxAgeMs}ms)`,
    };
  }
  if (parsed.entries.length === 0) {
    return {
      status: "empty",
      entries: [],
      fetchedAt: parsed.fetchedAt,
      reason: `codex models cache lists no models with visibility "${CODEX_LISTED_VISIBILITY}"`,
    };
  }
  return { status: "usable", entries: parsed.entries, fetchedAt: parsed.fetchedAt };
}

/**
 * Ingests the Codex CLI's own models cache as the catalog source:
 * 1. Reads and age-checks `models_cache.json`
 * 2. Projects the listed entries down to identifiers
 * 3. Persists the projection to model_scrapes
 * 4. Populates the in-memory catalog for "codex"
 *
 * The persisted raw output is that identifier projection rather than the file
 * itself. The file is a quarter-megabyte of model-authored prose per refresh,
 * none of which the catalog is allowed to consume, so storing it verbatim would
 * be paying to keep the exact material #195 put outside the trust boundary.
 */
export function ingestCodexHostModels(opts?: {
  cachePath?: string;
  scrapeStore?: ModelScrapeStore;
  now?: number;
  maxAgeMs?: number;
}): CodexModelsCacheRead {
  const read = readCodexModelsCache(opts);
  if (read.status !== "usable") return read;

  const scrapedAt = new Date().toISOString();
  try {
    const id = opts?.scrapeStore?.recordRaw({
      provider: "codex",
      scrapedAt,
      rawOutput: JSON.stringify(
        {
          source: "codex-models-cache",
          fetchedAt: read.fetchedAt,
          listedIdentifiers: read.entries.map((entry) => entry.identifier),
        },
        null,
        2
      ),
    });
    if (id && opts?.scrapeStore) {
      opts.scrapeStore.recordParsed(id, read.entries);
    }
  } catch (err) {
    console.warn(
      `[model-catalog] failed to persist codex models cache scrape: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  setProviderModelCatalog("codex", read.entries);
  return read;
}
