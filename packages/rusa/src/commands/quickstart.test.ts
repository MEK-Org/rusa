import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { loadConfig } from "../config/loader";
import type { RusaConfig } from "../config/types.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const doctorMocks = vi.hoisted(() => ({
  runQuickstartDoctor: vi.fn(async () => [{ name: "node", status: "pass", message: "node ok" }]),
  formatDoctorResults: vi.fn(() => "[quickstart] Preflight doctor:\n  PASS node: node ok"),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawnSync: spawnSyncMock,
    default: {
      ...actual,
      spawnSync: spawnSyncMock,
    },
  };
});

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
  setupBridgeRemoteAndPush,
  updateQuickstartRepoConfig,
  validateLocalGitRepo,
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
    promptMocks.state.inputs = ["codex", ""];
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
    promptMocks.state.inputs = ["codex", "my-root-entity", "gpt-5.6-sol"];
    promptMocks.state.passwords = ["test-gemini-key"];
    await runQuickstartConfigure({
      home,
      executeProviderCommand: () => 0,
    });

    const configPath = join(home, "config.yaml");
    const config = parseYaml(readFileSync(configPath, "utf8")) as RusaConfig;

    expect(config.profile).toBe("quickstart");
    expect(readFileSync(join(home, "secrets", "gemini-api-key"), "utf8")).toBe("test-gemini-key\n");
    expect(config.github).toEqual({});
    expect(config).not.toHaveProperty("targets");
    expect(config.rootActor?.provider).toBe("codex");
    expect(config.rootActor?.model).toBe("gpt-5.6-sol");
    expect(config.rootActor?.handle).toBe("my-root-entity");
    expect(config.dashboard?.port).toBe(8080);
    expect(config.providers).toEqual({ codex: { cliCommand: "codex" } });
  });

  it("generates a valid config for antigravity that loadConfig accepts", async () => {
    promptMocks.state.inputs = ["antigravity", "my-root-entity", "Gemini 3.7 Flash"];
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
    promptMocks.state.inputs = ["codex", "", "gpt-5.6-sol"];
    promptMocks.state.passwords = ["test-gemini-key"];

    await runQuickstartConfigure({ home, executeProviderCommand: () => 0 });

    const configPath = join(home, "config.yaml");
    const config = parseYaml(readFileSync(configPath, "utf8")) as RusaConfig;

    expect(readFileSync(join(home, "secrets", "gemini-api-key"), "utf8")).toBe("test-gemini-key\n");
    expect(config.github).toEqual({});
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

    await runQuickstart({
      skipBuild: true,
      reconfigure: true,
      promptLocalRepo: async () => "",
    });

    const configureCalls = spawnSyncMock.mock.calls.filter(
      (call: unknown[]) =>
        call[0] === "docker" && Array.isArray(call[1]) && call[1].includes("configure")
    );
    expect(configureCalls).toHaveLength(1);
  });

  describe("local repository support (#69)", () => {
    describe("validateLocalGitRepo", () => {
      it("rejects empty or whitespace-only path", () => {
        expect(validateLocalGitRepo("")).toEqual({
          valid: false,
          error: "Repository path cannot be empty.",
        });
        expect(validateLocalGitRepo("   ")).toEqual({
          valid: false,
          error: "Repository path cannot be empty.",
        });
      });

      it("rejects non-existent path", () => {
        const res = validateLocalGitRepo("/non/existent/path/for/rusa/test");
        expect(res.valid).toBe(false);
        expect(res.error).toContain("Path does not exist");
      });

      it("rejects a path that is not a directory", () => {
        const tempFile = join(home, "regular-file.txt");
        writeFileSync(tempFile, "hello");
        const res = validateLocalGitRepo(tempFile);
        expect(res.valid).toBe(false);
        expect(res.error).toContain("Path is not a directory");
      });

      it("rejects a path that is not a git repository", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "non-git-"));
        try {
          const fakeGit = vi.fn(() => ({ status: 128, stdout: "", stderr: "not a git repo" }));
          const res = validateLocalGitRepo(tempDir, fakeGit);
          expect(res.valid).toBe(false);
          expect(res.error).toContain("Not a git repository");
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it("rejects a git repository with no commits", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "git-no-commits-"));
        try {
          const fakeGit = vi.fn((args: string[]) => {
            if (args.includes("--is-inside-work-tree")) {
              return { status: 0, stdout: "true\n", stderr: "" };
            }
            if (args.includes("--verify")) {
              return { status: 1, stdout: "", stderr: "fatal: Needed a single revision" };
            }
            return { status: 0, stdout: "", stderr: "" };
          });
          const res = validateLocalGitRepo(tempDir, fakeGit);
          expect(res.valid).toBe(false);
          expect(res.error).toContain("Git repository has no commits");
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it("accepts a valid git repository with commits", () => {
        const tempDir = mkdtempSync(join(tmpdir(), "valid-repo-"));
        try {
          const fakeGit = vi.fn((args: string[]) => {
            if (args.includes("--is-inside-work-tree")) {
              return { status: 0, stdout: "true\n", stderr: "" };
            }
            if (args.includes("--verify")) {
              return { status: 0, stdout: "c0ffee\n", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          });
          const res = validateLocalGitRepo(tempDir, fakeGit);
          expect(res.valid).toBe(true);
          expect(res.repoName).toBe(tempDir.split("/").pop());
          expect(res.repoKey).toBe(`local/${res.repoName}`);
          expect(res.resolvedPath).toBe(tempDir);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });

    const createTestConfig = (overrides?: Partial<RusaConfig>): RusaConfig => ({
      profile: "quickstart",
      github: {},
      providers: {},
      webhook: { port: 9742, secret: "test" },
      ...overrides,
    });

    describe("updateQuickstartRepoConfig", () => {
      it("adds initial repoKey to github.repos", () => {
        const config = createTestConfig();
        const updated = updateQuickstartRepoConfig(config, "local/my-repo");
        expect(updated.github?.repos).toEqual(["local/my-repo"]);
      });

      it("updates existing local/ repo entry without duplicating on reconfigure", () => {
        const config = createTestConfig({
          github: { repos: ["local/old-repo"] },
        });
        const updated = updateQuickstartRepoConfig(config, "local/new-repo");
        expect(updated.github?.repos).toEqual(["local/new-repo"]);
      });

      it("does not duplicate entry when existing config already holds the same entry", () => {
        const config = createTestConfig({
          github: { repos: ["local/my-repo"] },
        });
        const updated = updateQuickstartRepoConfig(config, "local/my-repo");
        expect(updated.github?.repos).toEqual(["local/my-repo"]);
      });

      it("preserves non-local repositories while updating the local entry", () => {
        const config = createTestConfig({
          github: { repos: ["upstream/project", "local/old-repo"] },
        });
        const updated = updateQuickstartRepoConfig(config, "local/new-repo");
        expect(updated.github?.repos).toEqual(["upstream/project", "local/new-repo"]);
      });
    });

    describe("setupBridgeRemoteAndPush", () => {
      it("adds remote rusa and pushes HEAD when remote does not exist", () => {
        const gitCalls: string[][] = [];
        const executeGit = vi.fn((args: string[]) => {
          gitCalls.push(args);
          if (args.includes("remote") && args.includes("get-url")) {
            return { status: 1, stdout: "", stderr: "no such remote" };
          }
          return { status: 0, stdout: "", stderr: "" };
        });

        const res = setupBridgeRemoteAndPush({
          repoPath: "/work/my-repo",
          repoKey: "local/my-repo",
          port: 8085,
          executeGit,
        });

        expect(res.success).toBe(true);
        expect(res.pushed).toBe(true);
        expect(gitCalls).toEqual([
          ["-C", "/work/my-repo", "remote", "get-url", "rusa"],
          [
            "-C",
            "/work/my-repo",
            "remote",
            "add",
            "rusa",
            "http://localhost:8085/local/my-repo.git",
          ],
          ["-C", "/work/my-repo", "push", "rusa", "HEAD"],
        ]);
      });

      it("updates remote rusa with set-url when remote already exists", () => {
        const gitCalls: string[][] = [];
        const executeGit = vi.fn((args: string[]) => {
          gitCalls.push(args);
          if (args.includes("remote") && args.includes("get-url")) {
            return { status: 0, stdout: "http://localhost:8085/old.git\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        });

        const res = setupBridgeRemoteAndPush({
          repoPath: "/work/my-repo",
          repoKey: "local/my-repo",
          port: 8085,
          executeGit,
        });

        expect(res.success).toBe(true);
        expect(res.pushed).toBe(true);
        expect(gitCalls).toEqual([
          ["-C", "/work/my-repo", "remote", "get-url", "rusa"],
          [
            "-C",
            "/work/my-repo",
            "remote",
            "set-url",
            "rusa",
            "http://localhost:8085/local/my-repo.git",
          ],
          ["-C", "/work/my-repo", "push", "rusa", "HEAD"],
        ]);
      });

      it("prints fallback commands and returns failure when push fails", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const executeGit = vi.fn((args: string[]) => {
          if (args.includes("push")) {
            return { status: 1, stdout: "", stderr: "Connection refused" };
          }
          return { status: 0, stdout: "", stderr: "" };
        });

        const res = setupBridgeRemoteAndPush({
          repoPath: "/work/my-repo",
          repoKey: "local/my-repo",
          port: 8085,
          executeGit,
        });

        expect(res.success).toBe(false);
        expect(res.pushed).toBe(false);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Automatic git push to local bridge failed")
        );
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining("You can manually configure and push your repository")
        );
        log.mockRestore();
        warn.mockRestore();
      });
    });

    describe("runQuickstart four root scenarios", () => {
      it("scenario 1 (reconfigure path): updates github.repos from local/old to local/new and pushes", async () => {
        doctorMocks.runQuickstartDoctor.mockResolvedValue([
          { name: "node", status: "pass", message: "node ok" },
        ]);

        let writtenConfig = "";
        const gitOps: string[][] = [];

        const executeGit = vi.fn((args: string[]) => {
          gitOps.push(args);
          if (args.includes("--is-inside-work-tree"))
            return { status: 0, stdout: "true\n", stderr: "" };
          if (args.includes("--verify")) return { status: 0, stdout: "commit1\n", stderr: "" };
          if (args.includes("remote") && args.includes("get-url"))
            return { status: 1, stdout: "", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        });

        const testRepoDir = mkdtempSync(join(tmpdir(), "new-repo-"));

        spawnSyncMock.mockImplementation(
          (cmd: string, args: string[], opts?: { input?: string }) => {
            if (cmd === "docker") {
              if (args.includes("test") && args.includes("/home/node/.rusa/config.yaml")) {
                return { status: 0, stdout: "", stderr: "" };
              }
              if (args.includes("cat") && args.includes("/home/node/.rusa/config.yaml")) {
                const initialConfig = createTestConfig({
                  github: { repos: ["local/old-repo"] },
                });
                return { status: 0, stdout: toYaml(initialConfig), stderr: "" };
              }
              if (args.includes("sh") && opts?.input) {
                writtenConfig = opts.input;
                return { status: 0, stdout: "", stderr: "" };
              }
            }
            return { status: 0, stdout: "", stderr: "" };
          }
        );

        try {
          await runQuickstart({
            skipBuild: true,
            reconfigure: true,
            localRepo: testRepoDir,
            executeGit,
            waitForBridgeReady: async () => true,
          });

          const parsed = parseYaml(writtenConfig) as RusaConfig;
          const repoName = testRepoDir.split("/").pop();
          expect(parsed.github?.repos).toEqual([`local/${repoName}`]);
          expect(gitOps.some((args) => args.includes("push") && args.includes("rusa"))).toBe(true);
        } finally {
          rmSync(testRepoDir, { recursive: true, force: true });
        }
      });

      it("scenario 2 (missing/non-git path): rejects invalid path before container launch", async () => {
        doctorMocks.runQuickstartDoctor.mockResolvedValue([
          { name: "node", status: "pass", message: "node ok" },
        ]);

        await expect(
          runQuickstart({
            skipBuild: true,
            localRepo: "/does/not/exist/at/all",
          })
        ).rejects.toThrow("Path does not exist");
      });

      it("scenario 3 (existing volume with a config already holding the entry): does not duplicate and updates remote", async () => {
        doctorMocks.runQuickstartDoctor.mockResolvedValue([
          { name: "node", status: "pass", message: "node ok" },
        ]);

        const testRepoDir = mkdtempSync(join(tmpdir(), "existing-repo-"));
        const repoName = testRepoDir.split("/").pop();
        const repoKey = `local/${repoName}`;

        let writtenConfig = "";
        const gitOps: string[][] = [];

        const executeGit = vi.fn((args: string[]) => {
          gitOps.push(args);
          if (args.includes("--is-inside-work-tree"))
            return { status: 0, stdout: "true\n", stderr: "" };
          if (args.includes("--verify")) return { status: 0, stdout: "commit1\n", stderr: "" };
          if (args.includes("remote") && args.includes("get-url")) {
            return { status: 0, stdout: `http://localhost:8085/${repoKey}.git\n`, stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        });

        spawnSyncMock.mockImplementation(
          (cmd: string, args: string[], opts?: { input?: string }) => {
            if (cmd === "docker") {
              if (args.includes("test") && args.includes("/home/node/.rusa/config.yaml")) {
                return { status: 0, stdout: "", stderr: "" };
              }
              if (args.includes("cat") && args.includes("/home/node/.rusa/config.yaml")) {
                const existingConfig = createTestConfig({
                  github: { repos: [repoKey] },
                });
                return { status: 0, stdout: toYaml(existingConfig), stderr: "" };
              }
              if (args.includes("sh") && opts?.input) {
                writtenConfig = opts.input;
                return { status: 0, stdout: "", stderr: "" };
              }
            }
            return { status: 0, stdout: "", stderr: "" };
          }
        );

        try {
          await runQuickstart({
            skipBuild: true,
            localRepo: testRepoDir,
            executeGit,
            waitForBridgeReady: async () => true,
          });

          const parsed = parseYaml(writtenConfig) as RusaConfig;
          expect(parsed.github?.repos).toEqual([repoKey]);
          expect(
            gitOps.some(
              (args) => args.includes("remote") && args.includes("set-url") && args.includes("rusa")
            )
          ).toBe(true);
          expect(gitOps.some((args) => args.includes("push") && args.includes("rusa"))).toBe(true);
        } finally {
          rmSync(testRepoDir, { recursive: true, force: true });
        }
      });

      it("scenario 4 (bridge not ready within the wait): logs warning and prints fallback instructions", async () => {
        doctorMocks.runQuickstartDoctor.mockResolvedValue([
          { name: "node", status: "pass", message: "node ok" },
        ]);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const testRepoDir = mkdtempSync(join(tmpdir(), "unready-bridge-"));

        const executeGit = vi.fn((args: string[]) => {
          if (args.includes("--is-inside-work-tree"))
            return { status: 0, stdout: "true\n", stderr: "" };
          if (args.includes("--verify")) return { status: 0, stdout: "commit1\n", stderr: "" };
          return { status: 0, stdout: "", stderr: "" };
        });

        spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === "docker") {
            if (args.includes("test") && args.includes("/home/node/.rusa/config.yaml")) {
              return { status: 0, stdout: "", stderr: "" };
            }
            if (args.includes("cat") && args.includes("/home/node/.rusa/config.yaml")) {
              return {
                status: 0,
                stdout: toYaml({ profile: "quickstart", github: {} }),
                stderr: "",
              };
            }
          }
          return { status: 0, stdout: "", stderr: "" };
        });

        try {
          await runQuickstart({
            skipBuild: true,
            localRepo: testRepoDir,
            executeGit,
            waitForBridgeReady: async () => false,
          });

          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining("did not become ready within the timeout")
          );
          expect(log).toHaveBeenCalledWith(
            expect.stringContaining("You can manually configure and push your repository")
          );
          expect(executeGit.mock.calls.some((c) => c[0].includes("push"))).toBe(false);
        } finally {
          rmSync(testRepoDir, { recursive: true, force: true });
          warn.mockRestore();
          log.mockRestore();
        }
      });
    });

    describe("real disposable git repository integration", () => {
      it("validates a real git repository on disk and configures remote", async () => {
        const cp = await vi.importActual<typeof import("child_process")>("child_process");
        const actualSpawnSync = cp.spawnSync;
        spawnSyncMock.mockImplementation((cmd: string, args: string[], opts?: unknown) =>
          actualSpawnSync(cmd, args as never, opts as never)
        );

        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const realRepoDir = mkdtempSync(join(tmpdir(), "rusa-real-git-"));
        try {
          // 1. Directory before git init
          const emptyDirRes = validateLocalGitRepo(realRepoDir);
          expect(emptyDirRes.valid).toBe(false);
          expect(emptyDirRes.error).toContain("Not a git repository");

          // 2. Initialized repo with no commits
          execFileSync("git", ["init"], { cwd: realRepoDir });
          execFileSync("git", ["config", "user.name", "Quickstart Tester"], { cwd: realRepoDir });
          execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: realRepoDir });

          const noCommitRes = validateLocalGitRepo(realRepoDir);
          expect(noCommitRes.valid).toBe(false);
          expect(noCommitRes.error).toContain("has no commits");

          // 3. Repo with an initial commit
          execFileSync("git", ["commit", "--allow-empty", "-m", "initial commit"], {
            cwd: realRepoDir,
          });

          const validRes = validateLocalGitRepo(realRepoDir);
          expect(validRes.valid).toBe(true);
          const repoName = basename(realRepoDir);
          expect(validRes.repoName).toBe(repoName);
          expect(validRes.repoKey).toBe(`local/${repoName}`);
          expect(validRes.resolvedPath).toBe(realRepoDir);

          if (!validRes.valid || !validRes.repoKey) {
            throw new Error(`Expected repo to be valid: ${validRes.error}`);
          }
          const repoKey = validRes.repoKey;

          // 4. End-to-end setupBridgeRemoteAndPush: adds remote 'rusa' on disk
          const setupRes = setupBridgeRemoteAndPush({
            repoPath: realRepoDir,
            repoKey,
          });
          expect(setupRes.success).toBe(false);
          expect(setupRes.pushed).toBe(false);
          expect(setupRes.error).toBeDefined();

          const remoteUrlOnDisk = execFileSync("git", ["remote", "get-url", "rusa"], {
            cwd: realRepoDir,
            encoding: "utf8",
          }).trim();
          expect(remoteUrlOnDisk).toBe(
            `http://localhost:${QUICKSTART_GIT_BRIDGE_PORT}/${repoKey}.git`
          );

          // 5. Subsequent run: updates remote url via set-url on disk
          const updatedPort = 8089;
          const reconfigureRes = setupBridgeRemoteAndPush({
            repoPath: realRepoDir,
            repoKey,
            port: updatedPort,
          });
          expect(reconfigureRes.success).toBe(false);
          expect(reconfigureRes.pushed).toBe(false);

          const updatedUrlOnDisk = execFileSync("git", ["remote", "get-url", "rusa"], {
            cwd: realRepoDir,
            encoding: "utf8",
          }).trim();
          expect(updatedUrlOnDisk).toBe(`http://localhost:${updatedPort}/${repoKey}.git`);
        } finally {
          rmSync(realRepoDir, { recursive: true, force: true });
          warn.mockRestore();
          log.mockRestore();
        }
      });
    });
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
