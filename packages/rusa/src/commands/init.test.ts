/**
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const promptMocks = vi.hoisted(() => {
  const state = {
    inputs: [] as string[],
    confirms: [] as boolean[],
    passwords: [] as string[],
  };

  return {
    state,
    input: vi.fn(async () => {
      const value = state.inputs.shift();
      if (value === undefined) throw new Error("Missing mocked input response");
      return value;
    }),
    confirm: vi.fn(async () => {
      const value = state.confirms.shift();
      if (value === undefined) throw new Error("Missing mocked confirm response");
      return value;
    }),
    password: vi.fn(async () => {
      const value = state.passwords.shift();
      if (value === undefined) throw new Error("Missing mocked password response");
      return value;
    }),
  };
});

function defaultExecSyncBehavior(command: string): string {
  if (command === "git config --global user.name") {
    throw new Error("git user.name not configured");
  }
  if (command === "git config --global user.email") {
    throw new Error("git user.email not configured");
  }
  if (command.startsWith("git config --global user.name ")) {
    return "";
  }
  if (command.startsWith("git config --global user.email ")) {
    return "";
  }
  if (command.includes("Metadata-Flavor: Google")) {
    throw new Error("Not running on GCE");
  }
  if (command.includes("rev-parse --show-toplevel")) {
    return "/tmp/current-repo";
  }
  if (command === "pnpm install --frozen-lockfile") {
    return "";
  }
  if (command === "pnpm build") {
    return "";
  }
  if (command === "npm link") {
    return "";
  }
  if (command.endsWith("--version")) {
    throw new Error("CLI not installed");
  }
  throw new Error(`Unexpected execSync command: ${command}`);
}

const execSyncMock = vi.hoisted(() => vi.fn(defaultExecSyncBehavior));

const initializeWorkspaceMock = vi.hoisted(() =>
  vi.fn(() => ({
    success: true,
    repoKey: "repo-key",
    barePath: "/tmp/repo.git",
  }))
);

const addWorktreeMock = vi.hoisted(() =>
  vi.fn(() => ({
    success: true,
    path: "/tmp/deploy-worktree",
  }))
);

const getRemoteUrlMock = vi.hoisted(() =>
  vi.fn(() => "https://github.com/dummy-org/dummy-repo.git")
);

const generateRepoKeyMock = vi.hoisted(() => vi.fn(() => "repo-key"));

vi.mock("@inquirer/prompts", () => ({
  input: promptMocks.input,
  confirm: promptMocks.confirm,
  password: promptMocks.password,
}));

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

vi.mock("../gitops/worktree.js", () => ({
  addWorktree: addWorktreeMock,
  generateRepoKey: generateRepoKeyMock,
  getRemoteUrl: getRemoteUrlMock,
  initializeWorkspace: initializeWorkspaceMock,
}));

import type { RusaConfig } from "../config/types.js";
import { closeDb } from "../db/index.js";
import { runInit } from "./init.js";

describe("runInit", () => {
  let mcHome: string;
  let originalArgv1: string;

  beforeEach(() => {
    mcHome = mkdtempSync(join(tmpdir(), "rusa-init-test-"));
    originalArgv1 = process.argv[1];
    promptMocks.state.inputs = [
      mcHome,
      "test-gemini-key",
      "test-user",
      "Test User",
      "test@example.com",
      "300",
      "9742",
      "",
      "8080",
      "",
    ];
    promptMocks.state.confirms = [false];
    promptMocks.state.passwords = [];
    promptMocks.input.mockClear();
    promptMocks.confirm.mockClear();
    promptMocks.password.mockClear();
    execSyncMock.mockClear();
    initializeWorkspaceMock.mockClear();
    addWorktreeMock.mockClear();
    getRemoteUrlMock.mockClear();
    generateRepoKeyMock.mockClear();
  });

  afterEach(() => {
    closeDb();
    process.argv[1] = originalArgv1;
    rmSync(mcHome, { recursive: true, force: true });
  });

  it("initializes the database without auto-seeding models or provider associations", async () => {
    await runInit();

    const config = parseYaml(readFileSync(join(mcHome, "config.yaml"), "utf-8")) as RusaConfig;
    // No CLIs detected (all --version probes throw) and the gemini-CLI api
    // fallback is gone, so no providers are auto-configured.
    expect(config.providers).toEqual({});
  });

  it("preserves an existing copilot provider config when re-running init", async () => {
    const existingConfig: RusaConfig = {
      github: { account: "existing-user", pollIntervalSeconds: 300 },
      providers: {
        copilot: { cliCommand: "copilot" },
        gemini: { cliCommand: "agy", dailyCap: "$50" },
      },
      geminiApiKey: "existing-gemini-key",
      webhook: { port: 9742, secret: "existing-secret" },
      dashboard: { port: 8080 },
    };

    writeFileSync(join(mcHome, "config.yaml"), stringifyYaml(existingConfig), "utf-8");

    promptMocks.state.inputs = [
      mcHome,
      "existing-user",
      "Test User",
      "test@example.com",
      "300",
      "9742",
      "",
      "8080",
      "",
    ];
    promptMocks.state.confirms = [true, false];

    await runInit();

    const config = parseYaml(readFileSync(join(mcHome, "config.yaml"), "utf-8")) as RusaConfig;
    expect(config.providers.copilot).toEqual({ cliCommand: "copilot" });
  });

  it("detects the copilot CLI provider during init without seeding models", async () => {
    execSyncMock.mockImplementation((command: string) => {
      if (command === "copilot --version") {
        return "copilot 1.0.0";
      }
      return defaultExecSyncBehavior(command);
    });

    await runInit();

    const config = parseYaml(readFileSync(join(mcHome, "config.yaml"), "utf-8")) as RusaConfig;
    expect(config.providers.copilot).toEqual({
      cliCommand: "copilot",
    });
  });

  it("fails non-interactive defaults when no provider is configured", async () => {
    // No silent provider default (ISSUE_NUM review): with nothing to go on, defaults
    // must fail rather than invent a provider.
    await expect(runInit({ nonInteractive: true, defaults: true, home: mcHome })).rejects.toThrow(
      /at least one provider/
    );

    expect(promptMocks.confirm).not.toHaveBeenCalled();
  });

  /**
   * an issue: The system should not "hallucinate" models
   *
   * This test verifies that:
   * 1. Configured providers (like 'copilot') do NOT automatically create entries in the ProviderModels table
   * 2. The ProviderModels table should only be modified via direct human interaction in the UI
   * 3. Re-running init with configured providers preserves the config but does not auto-create DB entries
   */
  it("does not auto-create provider model entries for configured providers (an issue)", async () => {
    // Pre-populate config with providers that have no corresponding models in the database
    const existingConfig: RusaConfig = {
      github: { account: "test-user", pollIntervalSeconds: 300 },
      providers: {
        // copilot is configured but should NOT auto-create a provider_model entry
        copilot: { cliCommand: "copilot" },
        gemini: { cliCommand: "agy", dailyCap: "$50" },
      },
      geminiApiKey: "test-gemini-key",
      webhook: { port: 9742, secret: "test-secret" },
      dashboard: { port: 8080 },
    };

    writeFileSync(join(mcHome, "config.yaml"), stringifyYaml(existingConfig), "utf-8");

    // Run init non-interactively with the existing config
    await runInit({ nonInteractive: true, defaults: false, home: mcHome });

    // Verify: Config is preserved
    const config = parseYaml(readFileSync(join(mcHome, "config.yaml"), "utf-8")) as RusaConfig;
    expect(config.providers.copilot).toEqual({ cliCommand: "copilot" });
  });

  /**
   * an issue: Verify non-interactive mode with custom config file
   *
   * This test verifies that the init command can be fully automated in CI
   * by providing a config file path, without requiring any interactive input.
   */
  it("supports non-interactive mode with seeded config file for CI automation", async () => {
    // Create a custom config file to use as seed
    const customConfig: RusaConfig = {
      github: { account: "ci-user", pollIntervalSeconds: 300 },
      providers: {
        gemini: { cliCommand: "agy", dailyCap: "$25" },
      },
      geminiApiKey: "ci-gemini-api-key",
      webhook: { port: 9999, secret: "ci-webhook-secret" },
      dashboard: { port: 9090 },
    };

    const configPath = join(mcHome, "seed-config.yaml");
    writeFileSync(configPath, stringifyYaml(customConfig), "utf-8");

    // Run init with the custom config file - no interactive prompts
    await runInit({ nonInteractive: true, configPath, home: mcHome });

    // Verify: No interactive prompts were shown
    expect(promptMocks.input).not.toHaveBeenCalled();
    expect(promptMocks.confirm).not.toHaveBeenCalled();
    expect(promptMocks.password).not.toHaveBeenCalled();

    // Verify: Config was loaded from the seed file
    const config = parseYaml(readFileSync(join(mcHome, "config.yaml"), "utf-8")) as RusaConfig;
    expect(config.github.account).toBe("ci-user");
    expect(config.geminiApiKey).toBe("ci-gemini-api-key");
    expect(config.webhook.port).toBe(9999);
    expect(config.dashboard?.port).toBe(9090);
  });

  it("nests configured glass_goals under understanding.glassGoals during interactive init ", async () => {
    execSyncMock.mockImplementation((command: string) => {
      if (command === "copilot --version") {
        return "copilot 1.0.0";
      }
      return defaultExecSyncBehavior(command);
    });

    promptMocks.state.inputs = [
      mcHome,
      "test-gemini-key",
      "test-user",
      "Test User",
      "test@example.com",
      "300",
      "gg-user@example.com",
      "/path/to/firebase-key.json",
      "9742",
      "",
      "8080",
      "",
    ];
    promptMocks.state.confirms = [true, false]; // [confirm glass_goals = true, confirm write = false]
    promptMocks.state.passwords = ["gg-secret-password"];

    await runInit();

    const config = parseYaml(readFileSync(join(mcHome, "config.yaml"), "utf-8")) as RusaConfig;
    expect(config.understanding?.glassGoals).toEqual({
      username: "gg-user@example.com",
      firebaseServiceAccountKeyPath: "/path/to/firebase-key.json",
    });
    expect(config.glassGoals).toBeUndefined();
  });
});
