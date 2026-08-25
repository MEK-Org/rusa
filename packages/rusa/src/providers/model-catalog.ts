import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@google/genai";
import { parse as parseToml } from "smol-toml";
import { extractGeminiText, getGeminiClient } from "../understanding/gemini-utils.js";

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
}

export type ModelCommandLineField = keyof ModelEntry;

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
      "Codex displays its passable model slug. Copy that slug into both fields and omit UI annotations such as '(current)'. Mark concrete models with passable: true.",
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

  try {
    const client = getGeminiClient(apiKey);
    const response = await client.models.generateContent({
      model: "gemini-3.1-flash-lite",
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
      clearProviderModelCatalog(opts.provider);
      return {
        status: "unknown",
        entries: [],
        message,
      };
    }
  } catch (err) {
    clearProviderModelCatalog(opts.provider);
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

/** Host-enumeration seam for a later slice. An absent provider is unknown. */
export function setProviderModelCatalog(provider: string, entries: readonly ModelEntry[]): void {
  catalogs.set(provider, [...entries]);
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

export type ModelPinValidation = { status: "accepted" } | { status: "unknown"; warning: string };

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
  const isMatch = passableEntries.some(
    (entry) => entry.identifier === pin || entry.displayLabel === pin
  );
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
  return { status: "accepted" };
}

/**
 * Mechanically extract ModelEntry items from Kimi's config.toml content.
 * Reads the `[models."..."]` tables and extracts both the config key and
 * the underlying model slug as accepted identifiers.
 */
export function extractKimiModelsFromToml(tomlContent: string): ModelEntry[] {
  try {
    const parsed = parseToml(tomlContent) as Record<string, unknown>;
    const modelsObj = parsed.models;
    if (!modelsObj || typeof modelsObj !== "object" || modelsObj === null) {
      return [];
    }
    const entries: ModelEntry[] = [];
    const seenIdentifiers = new Set<string>();

    for (const [key, val] of Object.entries(modelsObj)) {
      if (typeof val !== "object" || val === null) continue;
      const modelVal = val as { display_name?: unknown; model?: unknown };
      const displayLabel =
        typeof modelVal.display_name === "string" && modelVal.display_name.trim()
          ? modelVal.display_name.trim()
          : key;

      if (!seenIdentifiers.has(key)) {
        entries.push({ displayLabel, identifier: key });
        seenIdentifiers.add(key);
      }

      if (
        typeof modelVal.model === "string" &&
        modelVal.model.trim() &&
        !seenIdentifiers.has(modelVal.model.trim())
      ) {
        entries.push({ displayLabel, identifier: modelVal.model.trim() });
        seenIdentifiers.add(modelVal.model.trim());
      }
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
    if (identifier && displayLabel) {
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
