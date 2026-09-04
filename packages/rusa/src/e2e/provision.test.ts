import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify as toYaml } from "yaml";
import { loadConfig } from "../config/index.js";
import type { RusaConfig } from "../config/types.js";
import {
  buildE2EConfig,
  E2E_IU_ROOT_NODE_ID,
  PID_FILE,
  provisionE2EInstance,
  resumeE2EInstance,
  runE2EDown,
} from "./provision.js";

const TEST_TMPDIR = tmpdir();
const E2E_ENV_KEYS = [
  "RUSA_HOME",
  "GIT_CONFIG_GLOBAL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
] as const;
const ORIGINAL_E2E_ENV = new Map(E2E_ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreE2EEnvironment(): void {
  for (const key of E2E_ENV_KEYS) {
    const value = ORIGINAL_E2E_ENV.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("buildE2EConfig", () => {
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(TEST_TMPDIR, "rusa-e2e-config-test-"));
  });

  afterEach(() => {
    if (home) {
      rmSync(home, { recursive: true, force: true });
      home = "";
    }
  });

  it("is valid per loadConfig even with no base config (minimal fallback)", () => {
    const config = buildE2EConfig({ scratchPath: "/some/scratch", baseConfig: null });
    writeFileSync(join(home, "config.yaml"), toYaml(config), "utf8");

    const loaded = loadConfig(home);
    expect(loaded.github.account).toBeTruthy();
    expect(Object.keys(loaded.providers).length).toBeGreaterThan(0);
    expect(loaded.geminiApiKey).toBeTruthy();
    expect(loaded.understanding?.rootNodeId).toBe(E2E_IU_ROOT_NODE_ID);
    expect(loaded.glassGoals).toBeUndefined();
  });

  it("omits rootActor/chat by default but threads them when given", () => {
    const bare = buildE2EConfig({ scratchPath: "/some/scratch", baseConfig: null });
    expect(bare.rootActor).toBeUndefined();
    expect(bare.chat).toBeUndefined();

    const am = buildE2EConfig({
      scratchPath: "/some/scratch",
      baseConfig: null,
      rootActor: { provider: "antigravity", effort: "high" },
      chat: { projectId: "e2e", subscription: "e2e", pubsubKeyPath: "/dev/null" },
    });
    expect(am.rootActor?.provider).toBe("antigravity");
    expect(am.rootActor?.effort).toBe("high");
    expect(am.chat?.projectId).toBe("e2e");

    // Still schema-valid with the actor-mesh edges present.
    writeFileSync(join(home, "config.yaml"), toYaml(am), "utf8");
    const loaded = loadConfig(home);
    expect(loaded.rootActor?.provider).toBe("antigravity");
    expect(loaded.rootActor?.effort).toBe("high");
    expect(loaded.chat?.subscription).toBe("e2e");
  });

  it("seeds providers and the Gemini key from the base config when present", () => {
    const base = {
      providers: {
        claude: { cliCommand: "claude" },
        codex: { cliCommand: "codex" },
      },
      geminiApiKey: "base-key-123",
    } as unknown as RusaConfig;

    const config = buildE2EConfig({ scratchPath: "/some/scratch", baseConfig: base });

    expect(Object.keys(config.providers)).toEqual(["claude", "codex", "fake"]);
    expect(config.providers.fake?.cliCommand).toBe("fake");
    expect(config.geminiApiKey).toBe("base-key-123");
  });
});

describe("resumeE2EInstance", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    restoreE2EEnvironment();
  });

  it("loads an existing instance without rewriting its scratch state", () => {
    root = mkdtempSync(join(TEST_TMPDIR, "rusa-e2e-resume-test-"));
    const provisioned = provisionE2EInstance({ root });
    mkdirSync(join(provisioned.home, "data"), { recursive: true });
    writeFileSync(join(provisioned.home, "data", "mesh.db"), "", "utf8");
    writeFileSync(join(provisioned.scratchPath, "DESIGN.md"), "preserve me\n", "utf8");

    const resumed = resumeE2EInstance(root);

    expect(resumed.root).toBe(root);
    expect(resumed.config.github.account).toBe("rusa-e2e-bot");
    expect(readFileSync(join(resumed.scratchPath, "DESIGN.md"), "utf8")).toBe("preserve me\n");
  });
});

describe("runE2EDown", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("preserves state and removes a stale pidfile when requested", async () => {
    root = mkdtempSync(join(TEST_TMPDIR, "rusa-e2e-keep-test-"));
    writeFileSync(join(root, PID_FILE), "99999999", "utf8");
    writeFileSync(join(root, "state.txt"), "preserve me\n", "utf8");

    await runE2EDown({ root, preserve: true });

    expect(readFileSync(join(root, "state.txt"), "utf8")).toBe("preserve me\n");
    expect(existsSync(join(root, PID_FILE))).toBe(false);
  });

  it("removes the root by default", async () => {
    root = mkdtempSync(join(TEST_TMPDIR, "rusa-e2e-remove-test-"));

    await runE2EDown({ root });

    expect(existsSync(root)).toBe(false);
  });
});
