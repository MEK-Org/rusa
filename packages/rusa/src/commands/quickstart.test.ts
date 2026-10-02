import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  configureBridgeRemote,
  enabledProviders,
  type GitCommandExecutor,
  printFallbackCommands,
  QUICKSTART_DASHBOARD_PORT,
  QUICKSTART_GIT_BRIDGE_PORT,
  readExistingRepos,
  runProviderLogins,
  runQuickstart,
  runQuickstartConfigure,
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
      replaceablePorts: [],
    });
    // Only the read-only `docker port` lookups run before the doctor.
    for (const [cmd, args] of spawnSyncMock.mock.calls as [string, string[]][]) {
      expect(cmd).toBe("docker");
      expect(args[0]).toBe("port");
    }
    expect(process.exitCode).toBe(1);
  });

  it("lets a rerun replace its own running container instead of failing the port check", async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "docker" && args[0] === "port" && args[1] === "rusa-quickstart") {
        return {
          status: 0,
          stdout:
            "8080/tcp -> 127.0.0.1:8080\n8085/tcp -> 127.0.0.1:8085\n9742/tcp -> 127.0.0.1:9742\n",
          stderr: "",
        };
      }
      if (cmd === "docker" && args[0] === "port") {
        return { status: 1, stdout: "", stderr: "Error: No such container" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await runQuickstart({ skipBuild: true });

    expect(doctorMocks.runQuickstartDoctor).toHaveBeenCalledWith({
      ports: [QUICKSTART_DASHBOARD_PORT, QUICKSTART_GIT_BRIDGE_PORT],
      replaceablePorts: [QUICKSTART_DASHBOARD_PORT, QUICKSTART_GIT_BRIDGE_PORT],
    });
    const dockerArgs = spawnSyncMock.mock.calls
      .filter((call: unknown[]) => call[0] === "docker")
      .map((call: unknown[]) => (call[1] as string[]).join(" "));
    const removeApp = dockerArgs.indexOf("rm -f rusa-quickstart");
    const startApp = dockerArgs.findIndex(
      (args) => args.startsWith("run ") && args.includes("--name rusa-quickstart ")
    );
    expect(removeApp).toBeGreaterThan(-1);
    expect(startApp).toBeGreaterThan(removeApp);
  });

  it("still probes a port its own container publishes on another address or protocol", async () => {
    spawnSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "docker" && args[0] === "port" && args[1] === "rusa-quickstart") {
        return {
          status: 0,
          stdout: "8080/tcp -> 127.0.0.2:8080\n8085/udp -> 127.0.0.1:8085\n",
          stderr: "",
        };
      }
      if (cmd === "docker" && args[0] === "port") {
        return { status: 1, stdout: "", stderr: "Error: No such container" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    await runQuickstart({ skipBuild: true });

    expect(doctorMocks.runQuickstartDoctor).toHaveBeenCalledWith({
      ports: [QUICKSTART_DASHBOARD_PORT, QUICKSTART_GIT_BRIDGE_PORT],
      replaceablePorts: [],
    });
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

  it("carries github.repos forward when configure rewrites an existing config", async () => {
    writeFileSync(
      join(home, "config.yaml"),
      toYaml({
        profile: "quickstart",
        github: { repos: ["local/first", "local/hand-added", "upstream/project"] },
        providers: { codex: { cliCommand: "codex" } },
        webhook: { port: 9742, secret: "old" },
      })
    );
    promptMocks.state.inputs = ["codex", "my-root-entity", "gpt-5.6-sol"];
    promptMocks.state.passwords = ["test-gemini-key"];

    await runQuickstartConfigure({ home, executeProviderCommand: () => 0 });

    const config = loadConfig(home);
    expect(config.github?.repos).toEqual(["local/first", "local/hand-added", "upstream/project"]);
    expect(updateQuickstartRepoConfig(config, "local/second").github?.repos).toEqual([
      "local/first",
      "local/hand-added",
      "upstream/project",
      "local/second",
    ]);
  });

  it("rejects and leaves the file byte-identical when config.yaml is malformed", async () => {
    const malformedContent = "this: is: invalid: yaml:\n  [unclosed-bracket";
    const configPath = join(home, "config.yaml");
    writeFileSync(configPath, malformedContent, "utf8");

    promptMocks.state.inputs = ["codex", "my-root-entity", "gpt-5.6-sol"];
    promptMocks.state.passwords = ["test-gemini-key"];

    await expect(runQuickstartConfigure({ home, executeProviderCommand: () => 0 })).rejects.toThrow(
      /Could not read existing configuration/
    );

    expect(readFileSync(configPath, "utf8")).toBe(malformedContent);
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
      "[quickstart] Quickstart login for kimi isn't supported yet; complete auth via the vendor's own CLI."
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
            if (args.includes("symbolic-ref")) {
              return { status: 0, stdout: "main\n", stderr: "" };
            }
            return { status: 0, stdout: "", stderr: "" };
          });
          const res = validateLocalGitRepo(tempDir, fakeGit);
          expect(res.valid).toBe(true);
          expect(res.branch).toBe("main");
          expect(res.repoName).toBe(tempDir.split("/").pop());
          expect(res.repoKey).toBe(`local/${res.repoName}`);
          expect(res.resolvedPath).toBe(tempDir);
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });

    describe("validateLocalGitRepo repository name", () => {
      const acceptingGit = vi.fn((args: string[]) => ({
        status: 0,
        stdout: args.includes("--is-inside-work-tree") ? "true\n" : "c0ffee\n",
        stderr: "",
      }));

      for (const dirName of ["My Project", "repo#1", "what?", "pct%20"]) {
        it(`rejects a directory name the loader or bridge cannot route: ${JSON.stringify(dirName)}`, () => {
          const parent = mkdtempSync(join(tmpdir(), "repo-name-"));
          const repoDir = join(parent, dirName);
          try {
            mkdirSync(repoDir);
            const res = validateLocalGitRepo(repoDir, acceptingGit);
            expect(res.valid).toBe(false);
            expect(res.error).toContain(dirName);
          } finally {
            rmSync(parent, { recursive: true, force: true });
          }
        });
      }

      it("accepts letters, digits, dot, underscore and hyphen, and the key loads", () => {
        const parent = mkdtempSync(join(tmpdir(), "repo-name-"));
        const repoDir = join(parent, "My.repo_2-x");
        try {
          mkdirSync(repoDir);
          const res = validateLocalGitRepo(repoDir, acceptingGit);
          expect(res.valid).toBe(true);
          expect(res.repoKey).toBe("local/My.repo_2-x");
          writeFileSync(
            join(home, "config.yaml"),
            toYaml(
              createTestConfig({
                github: { repos: [res.repoKey as string] },
                providers: { codex: { cliCommand: "codex" } },
                rootActor: { provider: "codex", model: "gpt-5.6-sol", handle: "root" },
              })
            )
          );
          expect(loadConfig(home).github?.repos).toEqual(["local/My.repo_2-x"]);
        } finally {
          rmSync(parent, { recursive: true, force: true });
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

      it("adds a new local entry without removing any existing entry", () => {
        const config = createTestConfig({
          github: { repos: ["local/old-repo", "local/hand-added"] },
        });
        const updated = updateQuickstartRepoConfig(config, "local/new-repo");
        expect(updated.github?.repos).toEqual([
          "local/old-repo",
          "local/hand-added",
          "local/new-repo",
        ]);
      });

      it("does not duplicate entry when existing config already holds the same entry", () => {
        const config = createTestConfig({
          github: { repos: ["local/my-repo"] },
        });
        const updated = updateQuickstartRepoConfig(config, "local/my-repo");
        expect(updated.github?.repos).toEqual(["local/my-repo"]);
      });

      it("preserves non-local repositories when adding the local entry", () => {
        const config = createTestConfig({
          github: { repos: ["upstream/project", "local/old-repo"] },
        });
        const updated = updateQuickstartRepoConfig(config, "local/new-repo");
        expect(updated.github?.repos).toEqual([
          "upstream/project",
          "local/old-repo",
          "local/new-repo",
        ]);
      });
    });

    describe("readExistingRepos", () => {
      it("returns an empty array when config.yaml does not exist", () => {
        expect(readExistingRepos(join(home, "non-existent-config.yaml"))).toEqual([]);
      });

      it("returns github.repos when config.yaml contains valid repos", () => {
        const configPath = join(home, "test-config.yaml");
        writeFileSync(configPath, toYaml({ github: { repos: ["local/repo-a", "org/repo-b"] } }));
        expect(readExistingRepos(configPath)).toEqual(["local/repo-a", "org/repo-b"]);
      });

      it("throws when config.yaml exists but cannot be parsed", () => {
        const configPath = join(home, "broken-config.yaml");
        writeFileSync(configPath, "not: [valid: yaml", "utf8");
        expect(() => readExistingRepos(configPath)).toThrow(
          /Could not read existing configuration/
        );
      });
    });

    describe("configureBridgeRemote", () => {
      const remoteUrl = `http://localhost:${QUICKSTART_GIT_BRIDGE_PORT}/local/my-repo.git`;

      it("adds remote rusa when it does not exist and pushes nothing", () => {
        const executeGit = vi.fn((args: string[]) =>
          args.includes("get-url")
            ? { status: 2, stdout: "", stderr: "No such remote" }
            : { status: 0, stdout: "", stderr: "" }
        );
        expect(configureBridgeRemote("/work/my-repo", "local/my-repo", executeGit)).toBe(true);
        expect(executeGit.mock.calls.map((call) => call[0])).toEqual([
          ["-C", "/work/my-repo", "remote", "get-url", "rusa"],
          ["-C", "/work/my-repo", "remote", "add", "rusa", remoteUrl],
        ]);
      });

      it("repoints an existing rusa remote with set-url", () => {
        const executeGit = vi.fn((_args: string[]) => ({ status: 0, stdout: "", stderr: "" }));
        expect(configureBridgeRemote("/work/my-repo", "local/my-repo", executeGit)).toBe(true);
        expect(executeGit.mock.calls.map((call) => call[0])).toEqual([
          ["-C", "/work/my-repo", "remote", "get-url", "rusa"],
          ["-C", "/work/my-repo", "remote", "set-url", "rusa", remoteUrl],
        ]);
      });

      it("logs update notice when repointing an existing remote with a different url", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const executeGit = vi.fn((args: string[]) => {
          if (args.includes("remote") && args.includes("get-url")) {
            return { status: 0, stdout: "git@github.com:MEK-Org/rusa.git\n", stderr: "" };
          }
          return { status: 0, stdout: "", stderr: "" };
        });
        expect(configureBridgeRemote("/work/my-repo", "local/my-repo", executeGit)).toBe(true);
        expect(log).toHaveBeenCalledWith(
          expect.stringContaining(
            'Remote "rusa" in /work/my-repo updated: was git@github.com:MEK-Org/rusa.git, now points at http://localhost:8085/local/my-repo.git'
          )
        );
        log.mockRestore();
      });

      it("prints the recovery command when the remote cannot be set", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const executeGit = vi.fn((args: string[]) =>
          args.includes("get-url")
            ? { status: 0, stdout: "", stderr: "" }
            : { status: 1, stdout: "", stderr: "could not lock config file" }
        );
        expect(configureBridgeRemote("/work/my-repo", "local/my-repo", executeGit)).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not lock config file"));
        expect(log).toHaveBeenCalledWith(expect.stringContaining("remote set-url rusa"));
        log.mockRestore();
        warn.mockRestore();
      });
    });

    describe("printFallbackCommands", () => {
      it("recovers an existing rusa remote and quotes the path and URL", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        printFallbackCommands("/work/it's repo", "http://localhost:8085/local/my-repo.git");
        const printed = log.mock.calls.map((call) => String(call[0])).join("\n");
        expect(printed).toContain(
          "git -C '/work/it'\\''s repo' remote set-url rusa 'http://localhost:8085/local/my-repo.git' || git -C '/work/it'\\''s repo' remote add rusa 'http://localhost:8085/local/my-repo.git'"
        );
        log.mockRestore();
      });
    });

    describe("runQuickstart with a local repository", () => {
      // A git double for a valid repo on branch main whose `rusa` remote is absent
      // unless `remoteExists` is set.
      function validRepoGit(gitOps: string[][], remoteExists = false) {
        return vi.fn((args: string[]) => {
          gitOps.push(args);
          if (args.includes("--is-inside-work-tree"))
            return { status: 0, stdout: "true\n", stderr: "" };
          if (args.includes("symbolic-ref")) return { status: 0, stdout: "main\n", stderr: "" };
          if (args.includes("get-url"))
            return remoteExists
              ? { status: 0, stdout: "http://localhost:8085/old.git\n", stderr: "" }
              : { status: 2, stdout: "", stderr: "" };
          return { status: 0, stdout: "commit1\n", stderr: "" };
        });
      }

      function dockerDouble(
        dockerOps: string[][],
        opts: {
          config: RusaConfig;
          onWrite?: (input: string) => void;
          seedStatus?: number;
        }
      ) {
        spawnSyncMock.mockImplementation(
          (cmd: string, args: string[], spawnOpts?: { input?: string }) => {
            if (cmd !== "docker") return { status: 0, stdout: "", stderr: "" };
            dockerOps.push(args);
            if (args.includes("cat")) return { status: 0, stdout: toYaml(opts.config), stderr: "" };
            if (args.includes("sh") && spawnOpts?.input !== undefined) {
              opts.onWrite?.(spawnOpts.input);
              return { status: 0, stdout: "", stderr: "" };
            }
            if (args.includes("seed"))
              return { status: opts.seedStatus ?? 0, stdout: "", stderr: "seed failed" };
            return { status: 0, stdout: "", stderr: "" };
          }
        );
      }

      const isAppRun = (args: string[]) => args[0] === "run" && !args.includes("sleep");

      it("registers beside existing entries, seeds before the app starts, then sets the remote", async () => {
        const gitOps: string[][] = [];
        const dockerOps: string[][] = [];
        let writtenConfig = "";
        dockerDouble(dockerOps, {
          config: createTestConfig({ github: { repos: ["local/old-repo"] } }),
          onWrite: (input) => {
            writtenConfig = input;
          },
        });
        const testRepoDir = mkdtempSync(join(tmpdir(), "new-repo-"));
        const repoKey = `local/${basename(testRepoDir)}`;
        try {
          await runQuickstart({
            skipBuild: true,
            reconfigure: true,
            localRepo: testRepoDir,
            executeGit: validRepoGit(gitOps),
          });

          expect((parseYaml(writtenConfig) as RusaConfig).github?.repos).toEqual([
            "local/old-repo",
            repoKey,
          ]);
          const bundleOp = gitOps.find((args) => args.includes("bundle"));
          expect(bundleOp?.slice(0, 4)).toEqual(["-C", testRepoDir, "bundle", "create"]);
          expect(bundleOp?.at(-1)).toBe("refs/heads/main");

          const cpIndex = dockerOps.findIndex((args) => args[0] === "cp");
          const seedIndex = dockerOps.findIndex((args) => args.includes("seed"));
          const appIndex = dockerOps.findIndex(isAppRun);
          expect(cpIndex).toBeGreaterThan(-1);
          expect(dockerOps[seedIndex]).toEqual([
            "exec",
            "rusa-quickstart-setup",
            "rusa",
            "quickstart",
            "seed",
            "--repo-key",
            repoKey,
            "--bundle",
            "/tmp/rusa-seed.bundle",
            "--branch",
            "main",
          ]);
          expect(cpIndex).toBeLessThan(seedIndex);
          expect(seedIndex).toBeLessThan(appIndex);

          expect(gitOps.at(-1)).toEqual([
            "-C",
            testRepoDir,
            "remote",
            "add",
            "rusa",
            `http://localhost:${QUICKSTART_GIT_BRIDGE_PORT}/${repoKey}.git`,
          ]);
          expect(gitOps.some((args) => args.includes("push"))).toBe(false);
        } finally {
          rmSync(testRepoDir, { recursive: true, force: true });
        }
      });

      it("does not duplicate an entry the volume already holds and repoints the remote", async () => {
        const gitOps: string[][] = [];
        const dockerOps: string[][] = [];
        const testRepoDir = mkdtempSync(join(tmpdir(), "existing-repo-"));
        const repoKey = `local/${basename(testRepoDir)}`;
        let writtenConfig = "";
        dockerDouble(dockerOps, {
          config: createTestConfig({ github: { repos: [repoKey] } }),
          onWrite: (input) => {
            writtenConfig = input;
          },
        });
        try {
          await runQuickstart({
            skipBuild: true,
            localRepo: testRepoDir,
            executeGit: validRepoGit(gitOps, true),
          });

          expect((parseYaml(writtenConfig) as RusaConfig).github?.repos).toEqual([repoKey]);
          expect(dockerOps.some((args) => args.includes("seed"))).toBe(true);
          expect(gitOps.at(-1)?.slice(2, 4)).toEqual(["remote", "set-url"]);
        } finally {
          rmSync(testRepoDir, { recursive: true, force: true });
        }
      });

      const registrationFailures: Array<{
        name: string;
        cat: { status: number; stdout: string; stderr: string };
        writeStatus?: number;
      }> = [
        { name: "cat exits non-zero", cat: { status: 1, stdout: "", stderr: "no such file" } },
        { name: "cat returns empty output", cat: { status: 0, stdout: "", stderr: "" } },
        { name: "config does not parse", cat: { status: 0, stdout: "github: [", stderr: "" } },
        {
          name: "write fails",
          cat: { status: 0, stdout: toYaml(createTestConfig()), stderr: "" },
          writeStatus: 1,
        },
      ];
      for (const failure of registrationFailures) {
        it(`stops before seeding, the app container and any host remote change when ${failure.name}`, async () => {
          const gitOps: string[][] = [];
          const dockerOps: string[][] = [];
          spawnSyncMock.mockImplementation(
            (cmd: string, args: string[], opts?: { input?: string }) => {
              if (cmd === "docker") dockerOps.push(args);
              if (cmd === "docker" && args.includes("cat")) return failure.cat;
              if (cmd === "docker" && args.includes("sh") && opts?.input !== undefined)
                return { status: failure.writeStatus ?? 0, stdout: "", stderr: "denied" };
              return { status: 0, stdout: "", stderr: "" };
            }
          );
          const testRepoDir = mkdtempSync(join(tmpdir(), "reg-fail-"));
          const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
          try {
            await expect(
              runQuickstart({
                skipBuild: true,
                reconfigure: true,
                localRepo: testRepoDir,
                executeGit: validRepoGit(gitOps),
              })
            ).rejects.toThrow(/Could not register local\/reg-fail-/);
            expect(
              gitOps.filter((args) => args.includes("remote") || args.includes("bundle"))
            ).toEqual([]);
            expect(dockerOps.some((args) => args[0] === "cp" || args.includes("seed"))).toBe(false);
            // Only the setup container ever starts; the app container never does.
            expect(dockerOps.filter((args) => args[0] === "run")).toHaveLength(1);
          } finally {
            errorSpy.mockRestore();
            rmSync(testRepoDir, { recursive: true, force: true });
          }
        });
      }

      it("stops before the app container and any host remote change when seeding fails", async () => {
        const gitOps: string[][] = [];
        const dockerOps: string[][] = [];
        dockerDouble(dockerOps, { config: createTestConfig(), seedStatus: 1 });
        const testRepoDir = mkdtempSync(join(tmpdir(), "seed-fail-"));
        try {
          await expect(
            runQuickstart({
              skipBuild: true,
              localRepo: testRepoDir,
              executeGit: validRepoGit(gitOps),
            })
          ).rejects.toThrow(/seed failed/);
          expect(dockerOps.some(isAppRun)).toBe(false);
          expect(gitOps.some((args) => args.includes("remote"))).toBe(false);
        } finally {
          rmSync(testRepoDir, { recursive: true, force: true });
        }
      });

      it("exits 1 with only the friendly line and no container work for a missing path", async () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
          await expect(
            runQuickstart({
              skipBuild: true,
              localRepo: "/does/not/exist/at/all",
            })
          ).resolves.toBeUndefined();
          expect(process.exitCode).toBe(1);
          expect(errorSpy).toHaveBeenCalledTimes(1);
          expect(String(errorSpy.mock.calls[0]?.[0])).toMatch(
            /^\[quickstart\] Invalid repository path: .*Path does not exist/
          );
          const containerWork = spawnSyncMock.mock.calls.filter(
            (call: unknown[]) => !(call[0] === "docker" && (call[1] as string[])[0] === "port")
          );
          expect(containerWork).toHaveLength(0);
        } finally {
          errorSpy.mockRestore();
        }
      });
    });

    describe("real disposable git repository", () => {
      const realGit: GitCommandExecutor = (args) => {
        try {
          const stdout = execFileSync("git", args, { encoding: "utf8", stdio: "pipe" });
          return { status: 0, stdout, stderr: "" };
        } catch (err) {
          const failed = err as { status?: number; stderr?: string };
          return { status: failed.status ?? 1, stdout: "", stderr: String(failed.stderr ?? "") };
        }
      };
      const getUrl = (cwd: string) =>
        execFileSync("git", ["remote", "get-url", "rusa"], { cwd, encoding: "utf8" }).trim();

      it("validates step by step, then adds and repoints the rusa remote on disk", () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const repo = mkdtempSync(join(tmpdir(), "rusa-real-git-"));
        try {
          expect(validateLocalGitRepo(repo, realGit).error).toContain("Not a git repository");

          execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
          execFileSync("git", ["config", "user.name", "Quickstart Tester"], { cwd: repo });
          execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
          expect(validateLocalGitRepo(repo, realGit).error).toContain("has no commits");

          execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], {
            cwd: repo,
            stdio: "pipe",
          });
          const valid = validateLocalGitRepo(repo, realGit);
          expect(valid).toMatchObject({
            valid: true,
            repoKey: `local/${basename(repo)}`,
            resolvedPath: repo,
            branch: "main",
          });

          execFileSync("git", ["checkout", "-q", "--detach"], { cwd: repo });
          expect(validateLocalGitRepo(repo, realGit).error).toContain("HEAD is detached");
          execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });

          const repoKey = valid.repoKey as string;
          const url = `http://localhost:${QUICKSTART_GIT_BRIDGE_PORT}/${repoKey}.git`;
          expect(configureBridgeRemote(repo, repoKey, realGit)).toBe(true);
          expect(getUrl(repo)).toBe(url);

          execFileSync("git", ["remote", "set-url", "rusa", "http://localhost:9/stale.git"], {
            cwd: repo,
          });
          expect(configureBridgeRemote(repo, repoKey, realGit)).toBe(true);
          expect(getUrl(repo)).toBe(url);
        } finally {
          rmSync(repo, { recursive: true, force: true });
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
