import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "../config/loader";
import type { RusaConfig } from "../config/types.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const doctorMocks = vi.hoisted(() => ({
  runQuickstartDoctor: vi.fn(async () => [{ name: "node", status: "pass", message: "node ok" }]),
  formatDoctorResults: vi.fn(() => "[quickstart] Preflight doctor:\n  PASS node: node ok"),
}));

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
  default: { spawnSync: spawnSyncMock },
}));

vi.mock("./quickstart-doctor.js", () => doctorMocks);

import {
  buildAppDockerRunArgs,
  buildQuickstartImage,
  buildSetupDockerRunArgs,
  enabledProviders,
  QUICKSTART_DASHBOARD_PORT,
  QUICKSTART_GIT_BRIDGE_PORT,
  runProviderLogins,
  runQuickstart,
  runQuickstartConfigure,
} from "./quickstart.js";

const promptMocks = vi.hoisted(() => {
  const state = {
    inputs: [] as string[],
    passwords: [] as string[],
  };
  return {
    state,
    input: vi.fn(
      async (_options: {
        message: string;
        default?: string;
        validate?: (value: string) => boolean | string;
      }) => {
        const value = state.inputs.shift();
        if (value === undefined) {
          throw new Error("Missing mocked input response");
        }
        return value;
      }
    ),
    password: vi.fn(async () => {
      const value = state.passwords.shift();
      if (value === undefined) {
        throw new Error("Missing mocked password response");
      }
      return value;
    }),
  };
});

vi.mock("@inquirer/prompts", () => ({
  input: promptMocks.input,
  password: promptMocks.password,
}));

describe("quickstart command", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rusa-quickstart-"));
    process.exitCode = undefined;
    spawnSyncMock.mockReset();
    doctorMocks.runQuickstartDoctor.mockResolvedValue([
      { name: "node", status: "pass", message: "node ok" },
    ]);
    doctorMocks.formatDoctorResults.mockReturnValue(
      "[quickstart] Preflight doctor:\n  PASS node: node ok"
    );
    promptMocks.state.inputs = ["codex", "dummy-org/dummy-repo"];
    promptMocks.state.passwords = [];
    promptMocks.input.mockClear();
    promptMocks.password.mockClear();
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("publishes dashboard and git bridge ports on host loopback for the app container", () => {
    const args = buildAppDockerRunArgs({
      image: "rusa:test",
      container: "mc-test",
      volume: "mc-home",
    });

    expect(args).toContain("--init");
    expect(args).toContain(`127.0.0.1:${QUICKSTART_DASHBOARD_PORT}:${QUICKSTART_DASHBOARD_PORT}`);
    expect(args).toContain(`127.0.0.1:${QUICKSTART_GIT_BRIDGE_PORT}:${QUICKSTART_GIT_BRIDGE_PORT}`);
  });

  it("uses the same loopback publish flags for the setup container", () => {
    const args = buildSetupDockerRunArgs({
      image: "rusa:test",
      container: "mc-test-setup",
      volume: "mc-home",
    });

    expect(args).toContain("--init");
    expect(args).toContain("--entrypoint");
    expect(args).toContain("sleep");
    expect(args).toContain(`127.0.0.1:${QUICKSTART_DASHBOARD_PORT}:${QUICKSTART_DASHBOARD_PORT}`);
    expect(args).toContain(`127.0.0.1:${QUICKSTART_GIT_BRIDGE_PORT}:${QUICKSTART_GIT_BRIDGE_PORT}`);
  });

  it("runs the preflight doctor before any Docker work and exits on failure", async () => {
    doctorMocks.runQuickstartDoctor.mockResolvedValue([
      { name: "node", status: "fail", message: "node missing" },
      { name: "git", status: "pass", message: "git ok" },
    ]);

    await runQuickstart({ skipBuild: true });

    expect(doctorMocks.runQuickstartDoctor).toHaveBeenCalledWith({
      ports: [QUICKSTART_DASHBOARD_PORT, QUICKSTART_GIT_BRIDGE_PORT],
    });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("writes quickstart config without the removed targets field", async () => {
    promptMocks.state.inputs = ["codex", "/work/example-repo", "my-root-entity"];
    promptMocks.state.passwords = ["test-gemini-key"];
    await runQuickstartConfigure({
      home,
      executeProviderCommand: () => 0,
    });

    const configPath = join(home, "config.yaml");
    const config = parseYaml(readFileSync(configPath, "utf8")) as RusaConfig;

    expect(config.profile).toBe("quickstart");
    expect(readFileSync(join(home, "secrets", "gemini-api-key"), "utf8")).toBe("test-gemini-key\n");
    expect(config.github).toEqual({
      pollIntervalSeconds: 30,
      ingestionMode: "poll",
    });
    expect(config).not.toHaveProperty("targets");
    expect(config.rootActor?.provider).toBe("codex");
    expect(config.rootActor?.handle).toBe("my-root-entity");
    expect(config.dashboard?.port).toBe(8080);
    expect(config.providers).toEqual({ codex: { cliCommand: "codex" } });
  });

  it("generates a valid config for antigravity that loadConfig accepts", async () => {
    promptMocks.state.inputs = ["antigravity", "/work/example-repo", "my-root-entity"];
    promptMocks.state.passwords = ["test-gemini-key"];
    await runQuickstartConfigure({
      home,
      executeProviderCommand: () => 0,
    });

    const loadedConfig = loadConfig(home);
    expect(loadedConfig.rootActor?.provider).toBe("antigravity");
    expect(loadedConfig.rootActor?.effort).toBe("high");
  });

  it("keeps the generated root handle when the handle prompt is blank", async () => {
    promptMocks.state.inputs = ["codex", "", ""];
    promptMocks.state.passwords = ["test-gemini-key"];

    await runQuickstartConfigure({ home, executeProviderCommand: () => 0 });

    const configPath = join(home, "config.yaml");
    const config = parseYaml(readFileSync(configPath, "utf8")) as RusaConfig;

    expect(readFileSync(join(home, "secrets", "gemini-api-key"), "utf8")).toBe("test-gemini-key\n");
    expect(config.github).toEqual({
      pollIntervalSeconds: 30,
      ingestionMode: "poll",
    });
    expect(config).not.toHaveProperty("targets");
    expect(config.rootActor?.handle).toMatch(/^[a-z]+(?:-[a-z]+)+$/);
  });

  it("persists the entire node home for provider CLI state", () => {
    const args = buildAppDockerRunArgs({
      image: "rusa:test",
      container: "mc-test",
      volume: "mc-home",
    });

    expect(args).toContain("mc-home:/home/node");
    expect(args).not.toContain("mc-home:/home/node/.rusa");
  });

  it("logs in then verifies each enabled provider in order", () => {
    const execute = vi.fn(() => 0);

    runProviderLogins(["codex", "claude", "antigravity"], execute);

    expect(execute.mock.calls).toEqual([
      ["codex", ["login", "--device-auth"]],
      ["codex", ["login", "status"]],
      ["claude", ["auth", "login"]],
      ["claude", ["auth", "status"]],
      ["agy", []],
      ["agy", ["-p", "ping", "--dangerously-skip-permissions"]],
    ]);
  });

  it("stops at the provider whose verification fails", () => {
    let calls = 0;
    const execute = vi.fn(() => (++calls === 2 ? 1 : 0));
    const results: Array<{ provider: string; outcome: string; exitCode: number | null }> = [];

    expect(() =>
      runProviderLogins(["codex", "claude"], execute, (result) => results.push(result))
    ).toThrow("codex login could not be verified");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      {
        provider: "codex",
        outcome: "fail",
        exitCode: 1,
      },
    ]);
  });

  it("filters duplicate enabled providers and accepts providers awaiting login support", () => {
    expect(enabledProviders("codex, claude, codex")).toEqual(["codex", "claude"]);
    expect(enabledProviders("antigravity, kimi")).toEqual(["antigravity", "kimi"]);
    expect(() => enabledProviders("codex, unknown")).toThrow('Unsupported provider "unknown"');
  });

  it("skips interactive login for providers awaiting support", () => {
    const execute = vi.fn(() => 0);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    runProviderLogins(["kimi"], execute);

    expect(execute).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Quickstart login for kimi isn't supported yet (tracked in ISSUE_NUM)"
      )
    );
    log.mockRestore();
  });

  it("skips interactive configuration when config.yaml already exists in volume", async () => {
    doctorMocks.runQuickstartDoctor.mockResolvedValue([
      { name: "node", status: "pass", message: "node ok" },
    ]);
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (
        cmd === "docker" &&
        args.includes("test") &&
        args.includes("/home/node/.rusa/config.yaml")
      ) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await runQuickstart({ skipBuild: true });

    const configureCalls = spawnSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "docker" && Array.isArray(call[1]) && call[1].includes("configure")
    );
    expect(configureCalls).toHaveLength(0);
  });

  it("re-runs interactive configuration when reconfigure: true is passed", async () => {
    doctorMocks.runQuickstartDoctor.mockResolvedValue([
      { name: "node", status: "pass", message: "node ok" },
    ]);
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (
        cmd === "docker" &&
        args.includes("test") &&
        args.includes("/home/node/.rusa/config.yaml")
      ) {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await runQuickstart({ skipBuild: true, reconfigure: true });

    const configureCalls = spawnSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "docker" && Array.isArray(call[1]) && call[1].includes("configure")
    );
    expect(configureCalls).toHaveLength(1);
  });
});

describe("buildQuickstartImage", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" });
  });

  it("builds the image with no npm-token secret mount", () => {
    expect(() => buildQuickstartImage("rusa:test")).not.toThrow();

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnSyncMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("docker");
    expect(args).toEqual(["build", "-t", "rusa:test", "."]);
    expect(args).not.toContain("--secret");
    expect(args.join(" ")).not.toMatch(/npmrc/);
  });
});
