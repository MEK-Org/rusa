import { afterEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyLimiter } from "../actor/concurrency-limiter.js";
import { ProviderPacer, UnifiedAdmissionQueue } from "../actor/provider-pacer.js";
import { coordinatorProviderLanes } from "../commands/quota-coordinator.js";
import type { RusaConfig } from "../config/types.js";
import { clearProviderModelCatalog } from "./model-catalog.js";
import { validateModelConfigPool } from "./model-config.js";
import { providerCapabilityName, validateProviderSelection } from "./provider-selection.js";
import { providerThrottleKey } from "./registry.js";

const config = {
  providers: { codex: { cliCommand: "codex" } },
} as unknown as RusaConfig;

afterEach(() => {
  clearProviderModelCatalog();
  vi.restoreAllMocks();
});

describe("validateProviderSelection", () => {
  it("preserves the unknown-catalog warning while allowing the selected pin", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(validateProviderSelection(config, "codex", "gpt-5.6-sol", "high")).toEqual({
      model: "gpt-5.6-sol",
      effort: "high",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[model-catalog] model catalog for provider "codex" is unknown; allowing pin "gpt-5.6-sol" without validation'
    );
  });
});

it("runs openrouter through the pi command with a model, portable context and no effort", async () => {
  // The minimal config: the provider name stays "openrouter" for routing while
  // cliCommand selects the Pi adapter and names its executable.
  const config = { providers: { openrouter: { cliCommand: "pi" } } } as unknown as RusaConfig;
  const entry = { provider: "openrouter", model: "vendor/model" };
  expect(validateProviderSelection(config, entry.provider, entry.model)).toEqual({
    model: entry.model,
  });
  expect(() => validateProviderSelection(config, entry.provider)).toThrow(/requires a model/);
  expect(() => validateModelConfigPool(config, entry, { portable: false })).toThrow(/portable/);
  expect(validateModelConfigPool(config, entry, { portable: true })[0]).toEqual(entry);
  expect(() => validateProviderSelection(config, entry.provider, entry.model, "high")).toThrow(
    /reasoning-effort/
  );
});

describe("harness vs provider identity at scheduler seam", () => {
  it("proves different providers sharing a harness retain distinct provider quota/pacing identity while executable selection is unchanged", () => {
    const config = {
      providers: {
        openrouter: { cliCommand: "pi" },
        "custom-pi": { cliCommand: "pi" },
        antigravity: { cliCommand: "agy" },
        claude: { cliCommand: "claude" },
        codex: { cliCommand: "codex" },
        kimi: { cliCommand: "kimi" },
        gemini: { cliCommand: "agy" },
        strong: { cliCommand: "claude" },
      },
    } as unknown as RusaConfig;

    // 1. Quota/pacing lane identity follows configured provider identity for harnesses, not cliCommand
    expect(providerThrottleKey("openrouter", config)).toBe("openrouter");
    expect(providerThrottleKey("custom-pi", config)).toBe("custom-pi");

    // 2. Executable selection unchanged: both resolve the "pi" harness/capability
    expect(providerCapabilityName("openrouter", config)).toBe("pi");
    expect(providerCapabilityName("custom-pi", config)).toBe("pi");

    // 3. Existing providers and linked quota aliases are preserved
    expect(providerThrottleKey("antigravity", config)).toBe("agy");
    expect(providerThrottleKey("claude", config)).toBe("claude");
    expect(providerThrottleKey("codex", config)).toBe("codex");
    expect(providerThrottleKey("kimi", config)).toBe("kimi");
    expect(providerThrottleKey("gemini", config)).toBe("agy");
    expect(providerThrottleKey("strong", config)).toBe("claude");

    // 4. Config-consuming boundaries:
    // 4a. coordinatorProviderLanes retains distinct configured provider lanes, does not collapse
    // harnesses to "pi", and includes only quota-tracked providers in collection.
    const { configuredProviders, collectionProviders } = coordinatorProviderLanes(config);
    expect(configuredProviders).toEqual([
      "openrouter",
      "custom-pi",
      "agy",
      "claude",
      "codex",
      "kimi",
    ]);
    expect(collectionProviders).toEqual(["agy", "claude", "codex", "kimi"]);

    // 4b. validateModelConfigPool keys duplicate detection on providerThrottleKey:
    // distinct providers sharing the "pi" harness can coexist in a pool with the same model slug,
    // whereas aliased providers sharing a quota CLI are rejected as duplicates.
    const distinctPiPool = validateModelConfigPool(
      config,
      [
        { provider: "openrouter", model: "openai/gpt-4.1-mini" },
        { provider: "custom-pi", model: "openai/gpt-4.1-mini" },
      ],
      { portable: true }
    );
    expect(distinctPiPool).toHaveLength(2);

    expect(() =>
      validateModelConfigPool(
        config,
        [
          { provider: "claude", model: "claude-sonnet-5" },
          { provider: "strong", model: "claude-sonnet-5" },
        ],
        { portable: true }
      )
    ).toThrow(/duplicate entry: provider "strong" model "claude-sonnet-5"/);

    // 4c. Scheduler seam: admission queue candidates retain distinct provider lanes
    const mesh = new ConcurrencyLimiter(1);
    const queue = new UnifiedAdmissionQueue<{ provider: string; model: string }>();
    const clock = () => Date.now();
    const openrouterPacer = new ProviderPacer(0, clock);
    const customPiPacer = new ProviderPacer(0, clock);

    const openrouterCandidate = {
      config: { provider: "openrouter", model: "openai/gpt-4.1-mini" },
      lane: providerThrottleKey("openrouter", config),
      pacer: openrouterPacer,
      weeklyQuota: undefined,
    };
    const customPiCandidate = {
      config: { provider: "custom-pi", model: "anthropic/claude-3.5-sonnet" },
      lane: providerThrottleKey("custom-pi", config),
      pacer: customPiPacer,
      weeklyQuota: undefined,
    };

    let blockerRelease: (() => void) | undefined;
    // Block concurrency so items stay queued and claimed in the admission queue
    queue.enqueue(
      () =>
        new Promise<string>((resolve) => {
          blockerRelease = () => resolve("done");
        }),
      [openrouterCandidate],
      {
        threadId: "actor-openrouter",
        enqueueNormal: (fn) => mesh.enqueue(fn),
      }
    );
    queue.enqueue(async () => "done", [customPiCandidate], {
      threadId: "actor-custom-pi",
      enqueueNormal: (fn) => mesh.enqueue(fn),
    });

    const snapshot = queue.snapshot();
    expect(snapshot).toHaveLength(2);
    // OpenRouter retains its own provider identity in queue text / lanes, NOT "pi"
    expect(snapshot[0].compatibleLanes).toEqual(["openrouter"]);
    expect(snapshot[0].claimedLane).toBe("openrouter");
    // custom-pi retains its distinct provider lane, NOT "pi" and NOT "openrouter"
    expect(snapshot[1].compatibleLanes).toEqual(["custom-pi"]);

    blockerRelease?.();
  });
});
