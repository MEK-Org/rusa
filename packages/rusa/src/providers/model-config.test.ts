import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import {
  MAX_MODEL_CONFIG_POOL_SIZE,
  type ModelClassStore,
  type ModelConfigInput,
  type ProviderModelConfig,
  resolveModelClasses,
  validateModelConfigPool,
} from "./model-config.js";

function configWith(): RusaConfig {
  return {
    providers: {
      antigravity: { cliCommand: "agy" },
      claude: { cliCommand: "claude" },
      codex: { cliCommand: "codex" },
      kimi: { cliCommand: "kimi" },
    },
  } as unknown as RusaConfig;
}

function classStore(definitions: Record<string, ProviderModelConfig[]> = {}): ModelClassStore {
  return {
    get: (name) => {
      const modelConfig = definitions[name];
      return modelConfig ? { modelConfig } : undefined;
    },
    list: () => Object.keys(definitions).map((name) => ({ name })),
  };
}

describe("validateModelConfigPool", () => {
  it("normalizes a single object into a one-entry array", () => {
    const pool = validateModelConfigPool(
      configWith(),
      { provider: "claude", model: "claude-sonnet-5" },
      { portable: false }
    );
    expect(pool).toEqual([{ provider: "claude", model: "claude-sonnet-5", effort: undefined }]);
  });

  it("preserves declaration order for an array of fixed entries", () => {
    const pool = validateModelConfigPool(
      configWith(),
      [
        { provider: "claude", model: "claude-sonnet-5" },
        { provider: "kimi", model: "kimi-for-coding" },
        { provider: "codex", model: "gpt-5.6-sol" },
      ],
      { portable: true }
    );
    expect(pool.map((entry: { provider: string }) => entry.provider)).toEqual([
      "claude",
      "kimi",
      "codex",
    ]);
  });

  it("rejects an empty pool", () => {
    expect(() => validateModelConfigPool(configWith(), [], { portable: true })).toThrow(
      /at least one/
    );
  });

  it("rejects an oversized pool", () => {
    const entries = Array.from({ length: MAX_MODEL_CONFIG_POOL_SIZE + 1 }, () => ({
      provider: "claude",
      model: "claude-sonnet-5",
    }));
    expect(() => validateModelConfigPool(configWith(), entries, { portable: true })).toThrow(
      /at most/
    );
  });

  it("rejects a pool of more than one entry for a non-portable actor", () => {
    expect(() =>
      validateModelConfigPool(
        configWith(),
        [
          { provider: "claude", model: "claude-sonnet-5" },
          { provider: "kimi", model: "kimi-for-coding" },
        ],
        { portable: false }
      )
    ).toThrow(/portable/);
  });

  it("rejects duplicate entries (same canonical provider/model/effort)", () => {
    expect(() =>
      validateModelConfigPool(
        configWith(),
        [
          { provider: "claude", model: "claude-sonnet-5" },
          { provider: "claude", model: "claude-sonnet-5" },
        ],
        { portable: true }
      )
    ).toThrow(/duplicate/);
  });

  it("treats aliased providers sharing a CLI command as the same canonical lane for duplicate detection", () => {
    const config = configWith();
    config.providers.strong = { cliCommand: "claude" };
    expect(() =>
      validateModelConfigPool(
        config,
        [
          { provider: "claude", model: "claude-sonnet-5" },
          { provider: "strong", model: "claude-sonnet-5" },
        ],
        { portable: true }
      )
    ).toThrow(/duplicate/);
  });

  it("rejects an invalid tuple by routing through validateProviderSelection", () => {
    expect(() =>
      validateModelConfigPool(configWith(), { provider: "bogus", model: "x" }, { portable: false })
    ).toThrow(/not configured/);
  });

  it("rejects an entry missing a provider", () => {
    expect(() =>
      validateModelConfigPool(configWith(), [{ provider: "  ", model: "claude-sonnet-5" }], {
        portable: false,
      })
    ).toThrow(/provider/);
  });

  it("rejects an entry with an omitted model rather than falling back to a provider default", () => {
    expect(() =>
      validateModelConfigPool(configWith(), { provider: "claude" }, { portable: false })
    ).toThrow(/model/);
  });

  it("rejects an entry with a blank model", () => {
    expect(() =>
      validateModelConfigPool(
        configWith(),
        { provider: "claude", model: "   " },
        { portable: false }
      )
    ).toThrow(/model/);
  });

  it("fails before mutation: the first invalid entry in a pool rejects the whole pool", () => {
    expect(() =>
      validateModelConfigPool(
        configWith(),
        [{ provider: "claude", model: "claude-sonnet-5" }, { provider: "kimi" }],
        { portable: true }
      )
    ).toThrow(/model/);
  });
});

describe("resolveModelClasses", () => {
  it("returns a concrete single entry unchanged, by identity", () => {
    const input = { provider: "claude", model: "claude-sonnet-5" };
    expect(resolveModelClasses(classStore(), input)).toBe(input);
  });

  it("returns a concrete pool unchanged, by identity", () => {
    const input = [
      { provider: "claude", model: "claude-sonnet-5" },
      { provider: "kimi", model: "kimi-for-coding" },
    ];
    expect(resolveModelClasses(classStore(), input)).toBe(input);
  });

  it("expands a class reference into its current runtime pool in declaration order", () => {
    const store = classStore({
      fast: [
        { provider: "claude", model: "claude-sonnet-5" },
        { provider: "kimi", model: "kimi-for-coding", effort: "high" },
      ],
    });
    expect(resolveModelClasses(store, { class: "fast" })).toEqual([
      { provider: "claude", model: "claude-sonnet-5" },
      { provider: "kimi", model: "kimi-for-coding", effort: "high" },
    ]);
  });

  it("rejects an unknown class by name rather than falling back to any default", () => {
    const store = classStore({ fast: [{ provider: "claude", model: "claude-sonnet-5" }] });
    expect(() => resolveModelClasses(store, { class: "nope" })).toThrow(
      /unknown model class "nope"/
    );
  });

  it("rejects a class reference when no runtime classes exist", () => {
    expect(() => resolveModelClasses(classStore(), { class: "fast" })).toThrow(
      /unknown model class "fast"/
    );
  });

  it("rejects a class whose definition is empty", () => {
    const store = classStore({ empty: [] });
    expect(() => resolveModelClasses(store, { class: "empty" })).toThrow(
      /model class "empty" is empty/
    );
  });

  it("rejects blank and whitespace-padded class names", () => {
    expect(() => resolveModelClasses(classStore(), { class: "   " })).toThrow(
      /model class reference is missing a class name/
    );
    expect(() => resolveModelClasses(classStore(), { class: " fast " })).toThrow(/whitespace/);
  });

  it("rejects a class reference nested inside a pool — a reference is the whole value", () => {
    const store = classStore({ fast: [{ provider: "claude", model: "claude-sonnet-5" }] });
    expect(() =>
      resolveModelClasses(store, [
        { provider: "claude", model: "claude-sonnet-5" },
        { class: "fast" },
      ] as unknown as ModelConfigInput)
    ).toThrow(/whole model_config value/);
  });

  it("returns a copy, so a caller cannot mutate the committed class definition", () => {
    const definitions = { fast: [{ provider: "claude", model: "claude-sonnet-5" }] };
    const resolved = resolveModelClasses(classStore(definitions), { class: "fast" }) as {
      model: string;
    }[];
    resolved[0].model = "tampered";
    expect(definitions.fast).toEqual([{ provider: "claude", model: "claude-sonnet-5" }]);
  });
});

describe("validateModelConfigPool with model classes", () => {
  it("rejects an unresolved class reference rather than repairing it", () => {
    expect(() =>
      validateModelConfigPool(configWith(), { class: "fast" }, { portable: false })
    ).toThrow(/model class reference/);
  });

  it("validates a resolved class pool through the same provider/model/effort checks", () => {
    const config = configWith();
    const store = classStore({
      bogus: [{ provider: "not-configured", model: "x" }],
    });
    expect(() =>
      validateModelConfigPool(config, resolveModelClasses(store, { class: "bogus" }), {
        portable: false,
      })
    ).toThrow(/not configured/);
  });

  it("still requires a portable actor for a multi-entry class pool", () => {
    const config = configWith();
    const store = classStore({
      wide: [
        { provider: "claude", model: "claude-sonnet-5" },
        { provider: "kimi", model: "kimi-for-coding" },
      ],
    });
    expect(() =>
      validateModelConfigPool(config, resolveModelClasses(store, { class: "wide" }), {
        portable: false,
      })
    ).toThrow(/portable/);
  });

  it("snapshots the resolved pool while a later runtime update serves future selections", () => {
    const config = configWith();
    const definitions = { fast: [{ provider: "claude", model: "claude-sonnet-5" }] };
    const store = classStore(definitions);
    const snapshot = validateModelConfigPool(
      config,
      resolveModelClasses(store, { class: "fast" }),
      { portable: false }
    );
    expect(snapshot).toEqual([{ provider: "claude", model: "claude-sonnet-5", effort: undefined }]);

    // A later committed edit changes what a *new* selection resolves to, and
    // leaves the already-resolved pool exactly as it was.
    definitions.fast = [{ provider: "kimi", model: "kimi-for-coding" }];
    expect(snapshot).toEqual([{ provider: "claude", model: "claude-sonnet-5", effort: undefined }]);
    expect(resolveModelClasses(store, { class: "fast" })).toEqual([
      { provider: "kimi", model: "kimi-for-coding" },
    ]);
  });
});
