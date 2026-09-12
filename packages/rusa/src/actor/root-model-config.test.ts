import { describe, expect, it } from "vitest";
import type { RusaConfig } from "../config/types.js";
import type { ProviderModelConfig } from "../providers/model-config.js";
import { InMemoryActorRepository } from "../repositories/in-memory-actor-repository.js";
import type { ActorRecord } from "./actor-record.js";
import { RootModelConfigStartupError, resolveRootBootModelConfig } from "./root-model-config.js";

function configWith(providers: Record<string, { cliCommand: string }>): RusaConfig {
  return { providers } as unknown as RusaConfig;
}

const bothProviders = configWith({
  antigravity: { cliCommand: "agy" },
  claude: { cliCommand: "claude" },
});

const bootstrap = { provider: "antigravity", model: "Gemini 3.7 Flash", effort: "high" };

const pool: ProviderModelConfig[] = [
  { provider: "claude", model: "claude-sonnet-5", effort: "high" },
  { provider: "antigravity", model: "Gemini 4.1 Ultra", effort: "low" },
];

function rootRecord(overrides: Partial<ActorRecord> = {}): ActorRecord {
  return {
    id: "root",
    charter: "root",
    parentId: null,
    isRoot: true,
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function repositoryWith(record?: ActorRecord): InMemoryActorRepository {
  const actors = new InMemoryActorRepository();
  if (record) actors.upsert(record);
  return actors;
}

describe("resolveRootBootModelConfig", () => {
  it("preserves a persisted ordered pool over the configured tuple, preflighting every entry in order", () => {
    const actors = repositoryWith(rootRecord({ modelConfig: pool, modelClass: "frontier" }));
    const preflighted: ProviderModelConfig[] = [];

    const resolved = resolveRootBootModelConfig({
      config: bothProviders,
      actors,
      rootId: "root",
      bootstrap,
      portable: true,
      preflight: (entry) => preflighted.push(entry),
    });

    // Class provenance is not this decision's to make: it rides along on the
    // record merge, so the resolved value carries only the pool.
    expect(resolved).toEqual({ source: "persisted", modelConfig: pool });
    expect(preflighted).toEqual(pool);
  });

  it("seeds from the configured tuple when the record has no persisted pool", () => {
    const actors = repositoryWith(rootRecord());

    const resolved = resolveRootBootModelConfig({
      config: bothProviders,
      actors,
      rootId: "root",
      bootstrap,
      portable: false,
    });

    expect(resolved).toEqual({ source: "bootstrap", modelConfig: [bootstrap] });
  });

  it("seeds from the configured tuple when there is no root record at all", () => {
    const resolved = resolveRootBootModelConfig({
      config: bothProviders,
      actors: repositoryWith(),
      rootId: "minted-root",
      bootstrap,
      portable: false,
    });

    expect(resolved).toEqual({ source: "bootstrap", modelConfig: [bootstrap] });
  });

  it("fails by name when the persisted pool names a provider the config no longer declares", () => {
    const actors = repositoryWith(rootRecord({ modelConfig: pool }));

    const attempt = () =>
      resolveRootBootModelConfig({
        config: configWith({ antigravity: { cliCommand: "agy" } }),
        actors,
        rootId: "root",
        bootstrap,
        portable: true,
      });

    expect(attempt).toThrow(RootModelConfigStartupError);
    expect(attempt).toThrow(
      /root actor 'root' has a persisted model_config that is not valid under the current configuration: provider "claude" is not configured/
    );
    let caught: unknown;
    try {
      attempt();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RootModelConfigStartupError);
    const error = caught as RootModelConfigStartupError;
    expect(error.name).toBe("RootModelConfigStartupError");
    expect(error.action).toMatch(/clear the root row's model_config/);
    expect(error.cause).toBeInstanceOf(Error);
    // The failure is the whole point: the record is not touched on the way out.
    expect(actors.get("root")?.modelConfig).toEqual(pool);
  });

  it("fails by name when a persisted multi-entry pool meets a root the file has made native", () => {
    const actors = repositoryWith(rootRecord({ modelConfig: pool }));

    expect(() =>
      resolveRootBootModelConfig({
        config: bothProviders,
        actors,
        rootId: "root",
        bootstrap,
        portable: false,
      })
    ).toThrow(RootModelConfigStartupError);
  });

  it("fails by name when a persisted entry validates but its provider cannot be instantiated", () => {
    const actors = repositoryWith(rootRecord({ modelConfig: pool }));

    const attempt = () =>
      resolveRootBootModelConfig({
        config: bothProviders,
        actors,
        rootId: "root",
        bootstrap,
        portable: true,
        preflight: (entry) => {
          if (entry.provider === "antigravity") throw new Error("no adapter for agy in this build");
        },
      });

    expect(attempt).toThrow(RootModelConfigStartupError);
    expect(attempt).toThrow(
      /persisted model_config that is not valid under the current configuration: no adapter for agy in this build/
    );
  });

  it("fails by name when the configured tuple cannot seed an empty record", () => {
    const attempt = () =>
      resolveRootBootModelConfig({
        config: bothProviders,
        actors: repositoryWith(rootRecord()),
        rootId: "root",
        bootstrap: { provider: "codex", model: "gpt-5.6" },
        portable: false,
      });

    expect(attempt).toThrow(RootModelConfigStartupError);
    expect(attempt).toThrow(/has no persisted model_config and the configured rootActor tuple/);
  });
});
