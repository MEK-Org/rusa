import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractGeminiText, getGeminiClient } from "../understanding/gemini-utils.js";
import { buildAntigravityArgs, resolveAntigravitySelection } from "./antigravity.js";
import {
  clearProviderModelCatalog,
  extractKimiModelsFromToml,
  extractModelCatalog,
  getAllProviderModelCatalogs,
  getProviderModelCatalog,
  ingestKimiHostModels,
  PROVIDER_MODEL_DESCRIPTORS,
  parseAgyModelsOutput,
  populateModelCatalogsFromDb,
  recordAndExtractModelCatalog,
  setProviderModelCatalog,
  validateModelPin,
} from "./model-catalog.js";

vi.mock("../understanding/gemini-utils.js", () => ({
  getGeminiClient: vi.fn(),
  extractGeminiText: vi.fn(),
}));

afterEach(() => clearProviderModelCatalog());

describe("extractModelCatalog", () => {
  it("has the same clear no-key behavior as quota parsing", async () => {
    await expect(extractModelCatalog("raw TUI", PROVIDER_MODEL_DESCRIPTORS.codex)).resolves.toEqual(
      {
        status: "unknown",
        entries: [],
        message: "no geminiApiKey configured for LLM model catalog parsing",
      }
    );
  });

  it("reads only the LLM's structured model fields", async () => {
    vi.mocked(getGeminiClient).mockReturnValue({
      models: { generateContent: vi.fn().mockResolvedValue({}) },
    } as never);
    vi.mocked(extractGeminiText).mockResolvedValue(
      JSON.stringify({
        entries: [{ displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" }],
      })
    );

    await expect(
      extractModelCatalog("unparsed vendor bytes", PROVIDER_MODEL_DESCRIPTORS.codex, "key")
    ).resolves.toEqual({
      status: "known",
      entries: [{ displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" }],
    });
  });

  it("extracts passable flags correctly for models vs quota group labels", async () => {
    vi.mocked(getGeminiClient).mockReturnValue({
      models: { generateContent: vi.fn().mockResolvedValue({}) },
    } as never);
    vi.mocked(extractGeminiText).mockResolvedValue(
      JSON.stringify({
        entries: [
          { displayLabel: "Gemini Flash", identifier: "gemini-flash", passable: false },
          {
            displayLabel: "Gemini 3.7 Flash (High)",
            identifier: "gemini-3.7-flash",
            passable: true,
          },
          { displayLabel: "Gemini Pro", identifier: "gemini-pro", passable: false },
          { displayLabel: "Gemini 3.1 Pro (High)", identifier: "gemini-3.1-pro", passable: true },
        ],
      })
    );

    await expect(
      extractModelCatalog("raw agy usage output", PROVIDER_MODEL_DESCRIPTORS.agy, "key")
    ).resolves.toEqual({
      status: "known",
      entries: [
        { displayLabel: "Gemini Flash", identifier: "gemini-flash", passable: false },
        { displayLabel: "Gemini 3.7 Flash (High)", identifier: "gemini-3.7-flash", passable: true },
        { displayLabel: "Gemini Pro", identifier: "gemini-pro", passable: false },
        { displayLabel: "Gemini 3.1 Pro (High)", identifier: "gemini-3.1-pro", passable: true },
      ],
    });
  });

  it("guards against panel-less codex captures containing only banner status line", async () => {
    const bannerOnlyScreen = `
OpenAI Codex
model: gpt-5.6-sol medium  /model to change
`;
    const res = await extractModelCatalog(
      bannerOnlyScreen,
      PROVIDER_MODEL_DESCRIPTORS.codex,
      "test-key"
    );
    expect(res).toEqual({
      status: "unknown",
      entries: [],
      message:
        "codex screen capture contains banner status line but no model selection panel rendered",
    });
  });
});

describe("recordAndExtractModelCatalog", () => {
  it("records raw output and updates store and in-memory map on successful extraction", async () => {
    vi.mocked(getGeminiClient).mockReturnValue({
      models: { generateContent: vi.fn().mockResolvedValue({}) },
    } as never);
    vi.mocked(extractGeminiText).mockResolvedValue(
      JSON.stringify({
        entries: [{ displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" }],
      })
    );

    const recordedRaw: Array<{ provider: string; scrapedAt: string; rawOutput: string }> = [];
    const recordedParsed: Array<{ id: string; models: unknown }> = [];
    const recordedErrors: Array<{ id: string; error: unknown }> = [];

    const mockStore = {
      recordRaw: vi.fn((opts) => {
        recordedRaw.push(opts);
        return "scrape-123";
      }),
      recordParsed: vi.fn((id, models) => {
        recordedParsed.push({ id, models });
      }),
      recordParseError: vi.fn((id, error) => {
        recordedErrors.push({ id, error });
      }),
    };

    const res = await recordAndExtractModelCatalog({
      provider: "codex",
      rawOutput: "raw screen output",
      scrapedAt: "2026-08-18T10:00:00.000Z",
      geminiApiKey: "key",
      scrapeStore: mockStore,
    });

    expect(res).toEqual({
      status: "known",
      entries: [{ displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" }],
    });
    expect(recordedRaw).toEqual([
      {
        provider: "codex",
        scrapedAt: "2026-08-18T10:00:00.000Z",
        rawOutput: "raw screen output",
      },
    ]);
    expect(recordedParsed).toEqual([
      {
        id: "scrape-123",
        models: [{ displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" }],
      },
    ]);
    expect(recordedErrors).toHaveLength(0);
    expect(getProviderModelCatalog("codex")).toEqual([
      { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" },
    ]);
    expect(validateModelPin("codex", "gpt-5.6-sol")).toEqual({ status: "accepted" });
  });

  it("records parse error when LLM parsing returns unknown or errors", async () => {
    const recordedRaw: Array<{ provider: string; scrapedAt: string; rawOutput: string }> = [];
    const recordedErrors: Array<{ id: string; error: unknown }> = [];

    const mockStore = {
      recordRaw: vi.fn((opts) => {
        recordedRaw.push(opts);
        return "scrape-456";
      }),
      recordParsed: vi.fn(),
      recordParseError: vi.fn((id, error) => {
        recordedErrors.push({ id, error });
      }),
    };

    const res = await recordAndExtractModelCatalog({
      provider: "codex",
      rawOutput: "raw screen",
      scrapeStore: mockStore,
    });

    expect(res.status).toBe("unknown");
    expect(recordedErrors).toHaveLength(1);
    expect(recordedErrors[0].id).toBe("scrape-456");
  });

  it("retains last-known-good in-memory catalog when extraction fails", async () => {
    setProviderModelCatalog("codex", [
      { displayLabel: "good-model", identifier: "good-model", passable: true },
    ]);
    expect(getProviderModelCatalog("codex")).toBeDefined();

    const mockStore = {
      recordRaw: vi.fn().mockReturnValue("scrape-stale-1"),
      recordParsed: vi.fn(),
      recordParseError: vi.fn(),
    };

    const res = await recordAndExtractModelCatalog({
      provider: "codex",
      rawOutput: "raw screen with no key",
      scrapeStore: mockStore,
    });

    expect(res.status).toBe("unknown");
    expect(getProviderModelCatalog("codex")).toEqual([
      { displayLabel: "good-model", identifier: "good-model", passable: true },
    ]);
    expect(validateModelPin("codex", "good-model")).toEqual({ status: "accepted" });
  });
});

describe("populateModelCatalogsFromDb", () => {
  it("loads latest models per provider and configures in-memory catalog", () => {
    const mockRepo = {
      listLatestForEachProvider: () =>
        new Map([
          ["codex", [{ displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" }]],
          [
            "claude",
            [
              { displayLabel: "Opus", identifier: "claude-opus-4-8" },
              { displayLabel: "Sonnet", identifier: "claude-sonnet-5" },
            ],
          ],
        ]),
    };

    populateModelCatalogsFromDb(mockRepo);

    expect(getProviderModelCatalog("codex")).toEqual([
      { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" },
    ]);
    expect(getProviderModelCatalog("claude")).toEqual([
      { displayLabel: "Opus", identifier: "claude-opus-4-8" },
      { displayLabel: "Sonnet", identifier: "claude-sonnet-5" },
    ]);
    expect(getAllProviderModelCatalogs().size).toBe(2);

    expect(validateModelPin("codex", "gpt-5.6-sol")).toEqual({ status: "accepted" });
    expect(() => validateModelPin("codex", "bad-model")).toThrow();
  });

  it("restores a raw tiered agy entry and emits the exact canonical argv selector pair", () => {
    const mockRepo = {
      listLatestForEachProvider: () =>
        new Map([
          [
            "agy",
            [
              {
                displayLabel: "Gemini 3.5 Flash (High)",
                identifier: "gemini-3.5-flash-high",
                passable: true,
              },
            ],
          ],
        ]),
    };
    populateModelCatalogsFromDb(mockRepo);
    const catalog = getProviderModelCatalog("agy");
    expect(catalog).toEqual([
      {
        displayLabel: "Gemini 3.5 Flash",
        identifier: "gemini-3.5-flash",
        passable: true,
        efforts: ["high"],
      },
    ]);

    const selection = resolveAntigravitySelection("Gemini 3.5 Flash", "high");
    const args = buildAntigravityArgs({
      prompt: "hi",
      model: selection.model,
      effort: selection.effort,
      timeoutMs: 60_000,
    });
    const iModel = args.indexOf("--model");
    const iEffort = args.indexOf("--effort");
    expect(args.slice(iModel, iEffort + 2)).toEqual([
      "--model",
      "gemini-3.5-flash",
      "--effort",
      "high",
    ]);
  });
});

describe("banked fixtures", () => {
  it("keeps the issue-grounded raw enumerations and agy mapping", () => {
    const fixture = (name: string) =>
      readFileSync(join(process.cwd(), "src/providers/fixtures", name), "utf8");
    // Source: Operator's verbatim Codex /model paste in ISSUE_NUM.
    expect(fixture("codex-model-output.txt")).toContain("gpt-5.6-sol");
    // Source: Operator's verbatim Claude /model paste in ISSUE_NUM.
    expect(fixture("claude-model-output.txt")).toContain(
      "Your pick becomes the default for new sessions"
    );
    // Source: antigravity.ts's doc comment plus the corrected agy mapping in ISSUE_NUM.
    expect(JSON.parse(fixture("agy-model-entry.json"))).toEqual({
      displayLabel: "Gemini 3.1 Pro (High)",
      identifier: "gemini-3.1-pro",
    });
  });
});

describe("validateModelPin", () => {
  it("allows unknown catalogs with an explicit warning", () => {
    expect(validateModelPin("codex", "anything")).toEqual({
      status: "unknown",
      warning:
        'model catalog for provider "codex" is unknown; allowing pin "anything" without validation',
    });
  });

  it("accepts and rejects against the provider-selected identifier column", () => {
    // Source fixture: Operator's codex /model paste in ISSUE_NUM.
    setProviderModelCatalog("codex", [
      { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" },
      { displayLabel: "gpt-5.6-terra", identifier: "gpt-5.6-terra" },
    ]);
    expect(validateModelPin("codex", "gpt-5.6-sol")).toEqual({ status: "accepted" });
    expect(validateModelPin("codex", "gpt-5.6-sol medium")).toEqual({ status: "accepted" });
    expect(() => validateModelPin("codex", "bad-pin")).toThrow(
      'provider "codex": rejected "bad-pin"; acceptable values: "gpt-5.6-sol", "gpt-5.6-terra"'
    );
  });

  it("normalizes codex catalog entries with reasoning effort and accepts plain pins", () => {
    setProviderModelCatalog("codex", [
      { displayLabel: "gpt-5.6-sol medium", identifier: "gpt-5.6-sol medium" },
    ]);
    expect(getProviderModelCatalog("codex")).toEqual([
      { displayLabel: "gpt-5.6-sol", identifier: "gpt-5.6-sol" },
    ]);
    expect(validateModelPin("codex", "gpt-5.6-sol")).toEqual({ status: "accepted" });
    expect(validateModelPin("codex", "gpt-5.6-sol medium")).toEqual({ status: "accepted" });
  });

  it("accepts both agy display labels and slug identifiers ", () => {
    setProviderModelCatalog("antigravity", [
      { identifier: "gemini-3.1-pro-high", displayLabel: "Gemini 3.1 Pro (High)" },
    ]);
    expect(validateModelPin("antigravity", "Gemini 3.1 Pro").status).toBe("accepted");
    expect(validateModelPin("antigravity", "gemini-3.1-pro").status).toBe("accepted");
    expect(() => validateModelPin("antigravity", "Gemini 3.1 Pro (High)")).toThrow(
      'model pin validation failed for provider "antigravity": rejected "Gemini 3.1 Pro (High)"; acceptable values: "Gemini 3.1 Pro", "gemini-3.1-pro"'
    );
  });

  it("resolves catalog aliases between agy and antigravity ", () => {
    setProviderModelCatalog("antigravity", [
      { identifier: "gemini-3.1-pro-high", displayLabel: "Gemini 3.1 Pro (High)", passable: true },
    ]);

    // getProviderModelCatalog resolves agy from antigravity
    expect(getProviderModelCatalog("agy")).toEqual([
      {
        displayLabel: "Gemini 3.1 Pro",
        identifier: "gemini-3.1-pro",
        passable: true,
        efforts: ["high"],
      },
    ]);
    // clear resolves the reverse
    clearProviderModelCatalog("agy");
    expect(getProviderModelCatalog("antigravity")).toBeUndefined();
  });

  it("does not hard-block an explicitly populated empty catalog", () => {
    setProviderModelCatalog("agy", []);
    const result = validateModelPin("agy", "Gemini 3.7 Flash");
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.warning).toContain('model catalog for provider "agy" is unknown');
    }
  });

  it("rejects non-passable agy quota group labels while accepting concrete models", () => {
    setProviderModelCatalog("agy", [
      {
        identifier: "gemini-3.7-flash-high",
        displayLabel: "Gemini 3.7 Flash (High)",
        passable: true,
      },
      { identifier: "gemini-3.1-pro-high", displayLabel: "Gemini 3.1 Pro (High)", passable: true },
      { identifier: "gemini-flash", displayLabel: "Gemini Flash", passable: false },
    ]);
    expect(validateModelPin("agy", "Gemini 3.7 Flash").status).toBe("accepted");
    expect(validateModelPin("agy", "gemini-3.7-flash").status).toBe("accepted");
    expect(validateModelPin("agy", "Gemini 3.1 Pro").status).toBe("accepted");
    expect(validateModelPin("agy", "gemini-3.1-pro").status).toBe("accepted");

    // Quota group labels are rejected
    expect(() => validateModelPin("agy", "Gemini Flash")).toThrow(
      'model pin validation failed for provider "agy": rejected "Gemini Flash"; acceptable values: "Gemini 3.7 Flash", "gemini-3.7-flash", "Gemini 3.1 Pro", "gemini-3.1-pro"'
    );
    expect(() => validateModelPin("agy", "gemini-flash")).toThrow(
      'model pin validation failed for provider "agy": rejected "gemini-flash"; acceptable values: "Gemini 3.7 Flash", "gemini-3.7-flash", "Gemini 3.1 Pro", "gemini-3.1-pro"'
    );
    expect(() => validateModelPin("agy", "Gemini Pro")).toThrow(
      'model pin validation failed for provider "agy": rejected "Gemini Pro"; acceptable values: "Gemini 3.7 Flash", "gemini-3.7-flash", "Gemini 3.1 Pro", "gemini-3.1-pro"'
    );
  });
});

describe("parseAgyModelsOutput", () => {
  it("parses two-column slug and display label output correctly, handling spinner noise", () => {
    const raw = `
⠋ Fetching available models...⠙ Fetching available models...gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`;
    const entries = parseAgyModelsOutput(raw);
    expect(entries).toEqual([
      {
        identifier: "gemini-3.7-flash-high",
        displayLabel: "Gemini 3.7 Flash (High)",
        passable: true,
      },
      {
        identifier: "gemini-3.7-flash-medium",
        displayLabel: "Gemini 3.7 Flash (Medium)",
        passable: true,
      },
      { identifier: "gemini-3.1-pro-high", displayLabel: "Gemini 3.1 Pro (High)", passable: true },
      {
        identifier: "claude-sonnet-4-6",
        displayLabel: "Claude Sonnet 4.6 (Thinking)",
        passable: true,
      },
      { identifier: "gpt-oss-120b-medium", displayLabel: "GPT-OSS 120B (Medium)", passable: true },
    ]);
  });

  it("parses the live tab-separated column format ", () => {
    // Verbatim shape of the real `agy models` output on the host: single tab between columns.
    const raw = `gemini-3.7-flash-high\tGemini 3.7 Flash (High)
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`;
    const entries = parseAgyModelsOutput(raw);
    expect(entries).toEqual([
      {
        identifier: "gemini-3.7-flash-high",
        displayLabel: "Gemini 3.7 Flash (High)",
        passable: true,
      },
      {
        identifier: "gemini-3.6-flash-high",
        displayLabel: "Gemini 3.6 Flash (High)",
        passable: true,
      },
      { identifier: "gemini-3.1-pro-high", displayLabel: "Gemini 3.1 Pro (High)", passable: true },
      {
        identifier: "claude-sonnet-4-6",
        displayLabel: "Claude Sonnet 4.6 (Thinking)",
        passable: true,
      },
      { identifier: "gpt-oss-120b-medium", displayLabel: "GPT-OSS 120B (Medium)", passable: true },
    ]);
  });

  it("parses tab-separated rows with spinner noise glued to the first line", () => {
    const raw =
      "⠋ Fetching available models...⠙ Fetching available models...gemini-3.7-flash-high\tGemini 3.7 Flash (High)";
    expect(parseAgyModelsOutput(raw)).toEqual([
      {
        identifier: "gemini-3.7-flash-high",
        displayLabel: "Gemini 3.7 Flash (High)",
        passable: true,
      },
    ]);
  });

  it("skips tab-containing lines whose first column is not a slug", () => {
    expect(parseAgyModelsOutput("Available models\tfor this account")).toEqual([]);
  });

  it("handles multiple tabs, CRLF line endings, and surrounding whitespace", () => {
    const raw =
      "  gemini-3.7-flash-high\t\tGemini 3.7 Flash (High)  \r\n  gemini-3.1-pro-high\tGemini 3.1 Pro (High)\t\r\n";
    expect(parseAgyModelsOutput(raw)).toEqual([
      {
        identifier: "gemini-3.7-flash-high",
        displayLabel: "Gemini 3.7 Flash (High)",
        passable: true,
      },
      {
        identifier: "gemini-3.1-pro-high",
        displayLabel: "Gemini 3.1 Pro (High)",
        passable: true,
      },
    ]);
  });

  it("handles empty or garbage input gracefully", () => {
    expect(parseAgyModelsOutput("")).toEqual([]);
    expect(parseAgyModelsOutput("⠋ Fetching available models...")).toEqual([]);
  });
});

describe("extractKimiModelsFromToml", () => {
  it("extracts only config keys as passable identifiers from config TOML", () => {
    const toml = `
default_model = "kimi-code/k3"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
display_name = "K2.7 Coding"

[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
display_name = "K3"
`;

    const entries = extractKimiModelsFromToml(toml);
    expect(entries).toEqual([
      { displayLabel: "K2.7 Coding", identifier: "kimi-code/kimi-for-coding", passable: true },
      { displayLabel: "K3", identifier: "kimi-code/k3", passable: true },
    ]);
  });

  it("does not advertise bare model slugs the Kimi CLI rejects", () => {
    const toml = `
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
display_name = "K2.7 Coding"
`;

    const entries = extractKimiModelsFromToml(toml);
    expect(entries.map((entry) => entry.identifier)).toEqual(["kimi-code/kimi-for-coding"]);
    expect(entries.some((entry) => entry.identifier === "kimi-for-coding")).toBe(false);
  });

  it("handles missing models section or invalid TOML gracefully", () => {
    expect(extractKimiModelsFromToml("")).toEqual([]);
    expect(extractKimiModelsFromToml("not [ valid toml ===")).toEqual([]);
    expect(extractKimiModelsFromToml("default_model = 'test'")).toEqual([]);
  });
});

describe("ingestKimiHostModels", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("reads config.toml, stores raw TOML to scrapeStore, and sets Kimi catalog", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "kimi-ingest-test-"));
    const configPath = join(tmpDir, "config.toml");
    const tomlContent = `
[models."kimi-code/k3"]
provider = "managed:kimi-code"
model = "k3"
display_name = "K3"
`;
    writeFileSync(configPath, tomlContent);

    const recordedRaw: Array<{ provider: string; rawOutput: string }> = [];
    const recordedParsed: Array<{ id: string; models: unknown }> = [];

    const mockStore = {
      recordRaw: vi.fn((opts) => {
        recordedRaw.push(opts);
        return "scrape-kimi-1";
      }),
      recordParsed: vi.fn((id, models) => {
        recordedParsed.push({ id, models });
      }),
      recordParseError: vi.fn(),
    };

    const entries = ingestKimiHostModels({
      configPath,
      scrapeStore: mockStore,
    });

    expect(entries).toEqual([{ displayLabel: "K3", identifier: "kimi-code/k3", passable: true }]);
    expect(recordedRaw).toHaveLength(1);
    expect(recordedRaw[0].provider).toBe("kimi");
    expect(recordedRaw[0].rawOutput).toBe(tomlContent);
    expect(recordedParsed).toEqual([
      {
        id: "scrape-kimi-1",
        models: [{ displayLabel: "K3", identifier: "kimi-code/k3", passable: true }],
      },
    ]);

    expect(getProviderModelCatalog("kimi")).toEqual([
      { displayLabel: "K3", identifier: "kimi-code/k3", passable: true },
    ]);
    expect(validateModelPin("kimi", "kimi-code/k3")).toEqual({ status: "accepted" });
    expect(() => validateModelPin("kimi", "k3")).toThrow();
    expect(() => validateModelPin("kimi", "unsupported-model")).toThrow();
  });
});

describe("PROVIDER_MODEL_DESCRIPTORS", () => {
  it("resolves agy and antigravity to identical descriptor content", () => {
    expect(PROVIDER_MODEL_DESCRIPTORS.agy).toBeDefined();
    expect(PROVIDER_MODEL_DESCRIPTORS.antigravity).toBeDefined();
    expect(PROVIDER_MODEL_DESCRIPTORS.agy).toBe(PROVIDER_MODEL_DESCRIPTORS.antigravity);
    expect(PROVIDER_MODEL_DESCRIPTORS.agy).toEqual(PROVIDER_MODEL_DESCRIPTORS.antigravity);
    expect(PROVIDER_MODEL_DESCRIPTORS.agy.commandLineField).toBe("displayLabel");
    expect(PROVIDER_MODEL_DESCRIPTORS.antigravity.commandLineField).toBe("displayLabel");
  });

  it("includes a worked example for period-bearing model ids in claude extraction guidance", () => {
    const guidance = PROVIDER_MODEL_DESCRIPTORS.claude.extractionGuidance;
    expect(guidance).toContain("Claude Opus 4.8");
    expect(guidance).toContain("claude-opus-4-8");
  });
});
