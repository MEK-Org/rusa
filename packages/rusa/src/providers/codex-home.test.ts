import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexHomeDir,
  codexHomeFromConfig,
  configureCodexHome,
  configuredCodexHome,
} from "./codex-home.js";
import { getHostCodexModelsCachePath } from "./model-catalog.js";

describe("Codex home resolver (#782)", () => {
  afterEach(() => {
    configureCodexHome(undefined);
    vi.unstubAllEnvs();
  });

  it("defaults to ~/.codex, or <hostHome>/.codex when a host home is given", () => {
    expect(configuredCodexHome()).toBeUndefined();
    expect(codexHomeDir()).toBe(join(homedir(), ".codex"));
    expect(codexHomeDir("/home/fixture")).toBe("/home/fixture/.codex");
  });

  it("returns the configured home for every caller once configured", () => {
    configureCodexHome(codexHomeFromConfig({ providers: { codex: { home: "/srv/canary" } } }));
    expect(configuredCodexHome()).toBe("/srv/canary");
    expect(codexHomeDir()).toBe("/srv/canary");
    expect(codexHomeDir("/home/fixture")).toBe("/srv/canary");
  });

  it("restores the default when configured from a config without the key", () => {
    configureCodexHome("/srv/canary");
    configureCodexHome(codexHomeFromConfig({ providers: { codex: { cliCommand: "codex" } } }));
    expect(configuredCodexHome()).toBeUndefined();
    expect(codexHomeDir("/home/fixture")).toBe("/home/fixture/.codex");
  });

  it("reads the models cache from the configured home over an inherited CODEX_HOME", () => {
    vi.stubEnv("CODEX_HOME", "/srv/ambient");
    expect(getHostCodexModelsCachePath()).toBe("/srv/ambient/models_cache.json");
    configureCodexHome("/srv/canary");
    expect(getHostCodexModelsCachePath()).toBe("/srv/canary/models_cache.json");
    vi.stubEnv("CODEX_HOME", "");
    configureCodexHome(undefined);
    expect(getHostCodexModelsCachePath()).toBe(join(homedir(), ".codex", "models_cache.json"));
  });
});
