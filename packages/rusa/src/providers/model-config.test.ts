import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import { MAX_MODEL_CONFIG_POOL_SIZE, validateModelConfigPool } from "./model-config.js";

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
