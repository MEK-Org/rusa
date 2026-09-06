import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import {
  MAX_MODEL_CONFIG_POOL_SIZE,
  type ModelConfigInput,
  type ProviderModelConfig,
  resolveModelClasses,
  validateModelConfigPool,
} from "./model-config.js";

function configWith(modelClasses?: Record<string, ProviderModelConfig[]>): RusaConfig {
  return {
    providers: {
      antigravity: { cliCommand: "agy" },
      claude: { cliCommand: "claude" },
      codex: { cliCommand: "codex" },
      kimi: { cliCommand: "kimi" },
    },
    ...(modelClasses ? { modelClasses } : {}),
  } as unknown as RusaConfig;
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
    expect(resolveModelClasses(configWith(), input)).toBe(input);
  });

  it("returns a concrete pool unchanged, by identity", () => {
    const input = [
      { provider: "claude", model: "claude-sonnet-5" },
      { provider: "kimi", model: "kimi-for-coding" },
    ];
    expect(resolveModelClasses(configWith(), input)).toBe(input);
  });

  it("expands a class reference into its configured pool in declaration order", () => {
    const config = configWith({
      fast: [
        { provider: "claude", model: "claude-sonnet-5" },
        { provider: "kimi", model: "kimi-for-coding", effort: "high" },
      ],
    });
    expect(resolveModelClasses(config, { class: "fast" })).toEqual([
      { provider: "claude", model: "claude-sonnet-5" },
      { provider: "kimi", model: "kimi-for-coding", effort: "high" },
    ]);
  });

  it("rejects an unknown class by name rather than falling back to any default", () => {
    const config = configWith({ fast: [{ provider: "claude", model: "claude-sonnet-5" }] });
    expect(() => resolveModelClasses(config, { class: "nope" })).toThrow(
      /unknown model class "nope"/
    );
  });

  it("rejects a class reference when no classes are configured at all", () => {
    expect(() => resolveModelClasses(configWith(), { class: "fast" })).toThrow(
      /unknown model class "fast"/
    );
  });

  it("rejects a class whose definition is empty", () => {
    const config = configWith({ empty: [] });
    expect(() => resolveModelClasses(config, { class: "empty" })).toThrow(
      /model class "empty" is empty/
    );
  });

  it("rejects a blank class name", () => {
    expect(() => resolveModelClasses(configWith(), { class: "   " })).toThrow(
      /model class reference is missing a class name/
    );
  });

  it("rejects a class reference nested inside a pool — a reference is the whole value", () => {
    const config = configWith({ fast: [{ provider: "claude", model: "claude-sonnet-5" }] });
    expect(() =>
      resolveModelClasses(config, [
        { provider: "claude", model: "claude-sonnet-5" },
        { class: "fast" },
      ] as unknown as ModelConfigInput)
    ).toThrow(/whole model_config value/);
  });

  it("returns a copy, so a caller cannot mutate the class definition in config", () => {
    const config = configWith({ fast: [{ provider: "claude", model: "claude-sonnet-5" }] });
    const resolved = resolveModelClasses(config, { class: "fast" }) as { model: string }[];
    resolved[0].model = "tampered";
    expect(config.modelClasses?.fast).toEqual([{ provider: "claude", model: "claude-sonnet-5" }]);
  });
});

describe("validateModelConfigPool with model classes", () => {
  it("rejects an unresolved class reference rather than repairing it", () => {
    const config = configWith({ fast: [{ provider: "claude", model: "claude-sonnet-5" }] });
    expect(() => validateModelConfigPool(config, { class: "fast" }, { portable: false })).toThrow(
      /model class reference/
    );
  });

  it("validates a resolved class pool through the same provider/model/effort checks", () => {
    const config = configWith({
      bogus: [{ provider: "not-configured", model: "x" }],
    });
    expect(() =>
      validateModelConfigPool(config, resolveModelClasses(config, { class: "bogus" }), {
        portable: false,
      })
    ).toThrow(/not configured/);
  });

  it("still requires a portable actor for a multi-entry class pool", () => {
    const config = configWith({
      wide: [
        { provider: "claude", model: "claude-sonnet-5" },
        { provider: "kimi", model: "kimi-for-coding" },
      ],
    });
    expect(() =>
      validateModelConfigPool(config, resolveModelClasses(config, { class: "wide" }), {
        portable: false,
      })
    ).toThrow(/portable/);
  });

  it("snapshots the resolved pool: editing the class afterwards does not retro-apply", () => {
    const config = configWith({ fast: [{ provider: "claude", model: "claude-sonnet-5" }] });
    const snapshot = validateModelConfigPool(
      config,
      resolveModelClasses(config, { class: "fast" }),
      { portable: false }
    );
    expect(snapshot).toEqual([{ provider: "claude", model: "claude-sonnet-5", effort: undefined }]);

    // A later config edit changes what a *new* selection resolves to, and
    // leaves the already-resolved pool exactly as it was.
    config.modelClasses = { fast: [{ provider: "kimi", model: "kimi-for-coding" }] };
    expect(snapshot).toEqual([{ provider: "claude", model: "claude-sonnet-5", effort: undefined }]);
    expect(resolveModelClasses(config, { class: "fast" })).toEqual([
      { provider: "kimi", model: "kimi-for-coding" },
    ]);
  });
});
