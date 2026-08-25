import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type CommandResult,
  checkProviderEnvKeys,
  defaultFlutterDashboardDir,
  defaultRepoRoot,
  formatDoctorResults,
  QUICKSTART_DOCTOR_CHECKS,
  type QuickstartDoctorDeps,
  runQuickstartDoctor,
  satisfiesVersionRange,
} from "./quickstart-doctor.js";

function ok(stdout = ""): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

function fail(stderr = ""): CommandResult {
  return { status: 1, stdout: "", stderr };
}

function enoent(command: string): CommandResult {
  return {
    status: null,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" }),
  };
}

function deps(
  commands: Record<string, CommandResult>,
  overrides: Partial<QuickstartDoctorDeps> = {}
): Partial<QuickstartDoctorDeps> {
  return {
    env: {},
    cwd: "/repo",
    arch: () => "x64",
    run: (command, args) => commands[[command, ...args].join(" ")] ?? fail("missing"),
    readText: () => JSON.stringify({ engines: { node: ">=20.19.0" } }),
    fileExists: () => true,
    freeBytes: () => 20 * 1024 * 1024 * 1024,
    isPortAvailable: async () => true,
    ...overrides,
  };
}

function depsWithRunLog(overrides: Partial<QuickstartDoctorDeps> = {}): {
  deps: Partial<QuickstartDoctorDeps>;
  calls: Array<{ command: string; args: string[]; cwd?: string }>;
} {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  return {
    calls,
    deps: {
      env: {},
      cwd: "/repo",
      arch: () => "x64",
      run: (command, args, cwd) => {
        calls.push({ command, args, cwd });
        return fail("missing");
      },
      readText: () => JSON.stringify({ engines: { node: ">=20.19.0" } }),
      fileExists: () => true,
      freeBytes: () => 20 * 1024 * 1024 * 1024,
      isPortAvailable: async () => true,
      ...overrides,
    },
  };
}

const passingCommands: Record<string, CommandResult> = {
  "node --version": ok("v20.19.0\n"),
  "pnpm --version": ok("10.29.3\n"),
  "fvm --version": ok("3.2.1\n"),
  "fvm flutter --version": ok("Flutter 3.24.0\n"),
  "docker info": ok("Server Version: 27.0.0\n"),
  "docker compose version": ok("Docker Compose version v2.29.0\n"),
  "git --version": ok("git version 2.45.0\n"),
};

describe("satisfiesVersionRange", () => {
  it("accepts versions within simple minimum ranges", () => {
    expect(satisfiesVersionRange("v20.19.0", ">=20.19.0")).toBe(true);
    expect(satisfiesVersionRange("20.18.1", ">=20.19.0")).toBe(false);
  });

  it("handles compound alternatives used by package engine declarations", () => {
    const range = "^20.19.0 || ^22.12.0 || >=24.0.0";

    expect(satisfiesVersionRange("20.19.1", range)).toBe(true);
    expect(satisfiesVersionRange("22.12.0", range)).toBe(true);
    expect(satisfiesVersionRange("24.0.0", range)).toBe(true);
    expect(satisfiesVersionRange("23.0.0", range)).toBe(false);
  });
});

describe("checkProviderEnvKeys", () => {
  it("warns when exported provider keys can override subscription auth", () => {
    const result = checkProviderEnvKeys({
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
    });

    expect(result.status).toBe("warn");
    expect(result.message).toContain("ANTHROPIC_API_KEY");
    expect(result.message).toContain("OPENAI_API_KEY");
    expect(result.hint).toContain("unset ANTHROPIC_API_KEY OPENAI_API_KEY");
  });

  it("passes when no provider keys are exported", () => {
    expect(checkProviderEnvKeys({}).status).toBe("pass");
  });
});

describe("runQuickstartDoctor", () => {
  it("reports every check independently", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      targetPath: "/repo",
      ports: [8080, 8085],
      deps: deps(passingCommands),
    });

    expect(results).toHaveLength(QUICKSTART_DOCTOR_CHECKS.length);
    expect(results.map((result) => result.name)).toEqual([
      "node",
      "pnpm",
      "flutter/fvm",
      "docker daemon",
      "docker compose",
      "git",
      "arch",
      "free disk",
      "loopback ports",
      "provider API key environment",
    ]);
    expect(results.filter((result) => result.status === "fail")).toEqual([]);
  });

  it("aggregates multiple failures and warnings in one run", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      targetPath: "/repo",
      minFreeDiskBytes: 10 * 1024 * 1024 * 1024,
      ports: [8080, 8085],
      deps: deps(
        {
          ...passingCommands,
          "node --version": ok("v18.19.0\n"),
          "fvm --version": enoent("fvm"),
          "flutter --version": ok("Flutter 3.10.0\n"),
          "docker info": fail("Cannot connect to Docker daemon"),
        },
        {
          env: { ANTHROPIC_API_KEY: "secret" },
          freeBytes: () => 2 * 1024 * 1024 * 1024,
          isPortAvailable: vi.fn(async (port: number) => port !== 8085),
        }
      ),
    });

    expect(
      results.filter((result) => result.status === "fail").map((result) => result.name)
    ).toEqual(["node", "flutter/fvm", "docker daemon", "free disk", "loopback ports"]);
    expect(results.find((result) => result.name === "provider API key environment")?.status).toBe(
      "warn"
    );
    expect(formatDoctorResults(results)).toContain("Fix:");
    expect(formatDoctorResults(results)).toContain("docker is installed but the probe failed");
    expect(formatDoctorResults(results)).toContain("exited with code 1");
    expect(formatDoctorResults(results)).toContain("localhost port(s) already in use: 8085");
  });

  it("runs the flutter version check from the real flutter_dashboard/ directory", async () => {
    const expectedCwd = defaultFlutterDashboardDir();
    const { deps: loggedDeps, calls } = depsWithRunLog();
    await runQuickstartDoctor({
      deps: loggedDeps,
    });

    const flutterCalls = calls.filter(
      (call) =>
        call.args.includes("--version") &&
        (call.command === "fvm" || call.command === "flutter" || call.args[0] === "flutter")
    );
    expect(flutterCalls.length).toBeGreaterThan(0);
    for (const call of flutterCalls) {
      expect(call.cwd).toBe(expectedCwd);
    }
  });

  it("defaultFlutterDashboardDir resolves to an existing directory", () => {
    const dir = defaultFlutterDashboardDir();
    expect(existsSync(dir)).toBe(true);
    expect(dir).toMatch(/flutter_dashboard$/);
  });

  it("defaultRepoRoot resolves to the real workspace root, whose package.json declares engines.node ", () => {
    // Deliberately does not inject a repoRoot fake, per ISSUE_NUM — a fake never
    // exercises the fixed-`../../..` bug, which only shows up against the
    // real module location on disk.
    const dir = defaultRepoRoot();
    expect(existsSync(join(dir, "pnpm-workspace.yaml"))).toBe(true);
    // Regression guard: the old fixed `../../..` walk landed on `<repo>/packages`,
    // which has no package.json at all.
    expect(dir.endsWith(`${sep}packages`)).toBe(false);

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      engines?: { node?: unknown };
    };
    expect(typeof pkg.engines?.node).toBe("string");
  });

  it("fails with a clear message when the flutter_dashboard directory is missing", async () => {
    const flutterCwd = defaultFlutterDashboardDir();
    const results = await runQuickstartDoctor({
      deps: depsWithRunLog({
        fileExists: (path) => path !== flutterCwd,
      }).deps,
    });

    const flutter = results.find((result) => result.name === "flutter/fvm");
    expect(flutter).toMatchObject({
      status: "fail",
      message: expect.stringContaining("Flutter project directory is missing"),
    });
    expect(flutter?.message).toContain(flutterCwd);
  });

  it("falls back to flutter when fvm is absent", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      deps: deps({
        ...passingCommands,
        "fvm --version": enoent("fvm"),
        "flutter --version": ok("Flutter 3.24.2\n"),
      }),
    });

    expect(results.find((result) => result.name === "flutter/fvm")).toMatchObject({
      status: "pass",
      message: "flutter 3.24.2 is available.",
    });
  });

  it("resolves fvm from PATH before falling back to global flutter", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      deps: deps(
        {
          ...passingCommands,
          "/Users/operator/fvm/bin/fvm --version": ok("3.2.1\n"),
          "/Users/operator/fvm/bin/fvm flutter --version": ok("Flutter 3.24.3\n"),
        },
        {
          env: { PATH: "/Users/operator/fvm/bin:/usr/local/bin", HOME: "/Users/operator" },
          fileExists: (path) =>
            path === "/repo" ||
            path === "/Users/operator/fvm/bin/fvm" ||
            path === defaultFlutterDashboardDir(),
        }
      ),
    });

    expect(results.find((result) => result.name === "flutter/fvm")).toMatchObject({
      status: "pass",
      message: "fvm 3.2.1 is installed; resolved Flutter 3.24.3 is available.",
    });
  });

  it("checks the standalone fvm fallback under HOME when PATH misses it", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      deps: deps(
        {
          ...passingCommands,
          "fvm --version": enoent("fvm"),
          "/Users/operator/fvm/bin/fvm --version": ok("3.2.1\n"),
          "/Users/operator/fvm/bin/fvm flutter --version": ok("Flutter 3.24.4\n"),
        },
        {
          env: { PATH: "/usr/local/bin", HOME: "/Users/operator" },
          fileExists: (path) =>
            path === "/repo" ||
            path === "/Users/operator/fvm/bin/fvm" ||
            path === defaultFlutterDashboardDir(),
        }
      ),
    });

    expect(results.find((result) => result.name === "flutter/fvm")).toMatchObject({
      status: "pass",
      message: "fvm 3.2.1 is installed; resolved Flutter 3.24.4 is available.",
    });
  });

  it("passes when fvm exists but project Flutter cannot resolve in this directory", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      deps: deps({
        ...passingCommands,
        "fvm --version": ok("3.2.1\n"),
        "fvm flutter --version": fail("Not a Flutter project"),
        "flutter --version": enoent("flutter"),
      }),
    });

    const flutter = results.find((result) => result.name === "flutter/fvm");

    expect(flutter).toMatchObject({
      status: "pass",
    });
    expect(flutter?.message).toContain("fvm 3.2.1 is installed");
    expect(flutter?.message).toContain("Flutter version is unresolvable in this directory");
    expect(flutter?.message).toContain("exited with code 1");
    expect(flutter?.message).toContain("Not a Flutter project");
  });

  it("fails with the install hint when neither fvm nor flutter exists", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      deps: deps({
        ...passingCommands,
        "fvm --version": enoent("fvm"),
        "flutter --version": enoent("flutter"),
      }),
    });

    const flutter = results.find((result) => result.name === "flutter/fvm");

    expect(flutter).toMatchObject({
      status: "fail",
      message: "Neither fvm nor flutter is installed or on PATH.",
    });
    expect(flutter?.hint).toContain("Install Flutter with fvm");
    expect(flutter?.message).not.toContain("installed but the probe failed");
  });

  it("reports exit code and stderr when an installed command probe fails", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      deps: deps({
        ...passingCommands,
        "pnpm --version": fail("corepack shim crashed\nlast stderr line"),
      }),
    });

    const pnpm = results.find((result) => result.name === "pnpm");

    expect(pnpm).toMatchObject({
      status: "fail",
    });
    expect(pnpm?.message).toContain("pnpm is installed but the probe failed");
    expect(pnpm?.message).toContain("pnpm --version exited with code 1");
    expect(pnpm?.message).toContain("last stderr line");
    expect(pnpm?.hint).not.toContain("corepack enable");
  });

  it("formats failed check probe details with commands, searched paths, and fallbacks", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      deps: deps(
        {
          ...passingCommands,
          "fvm --version": enoent("fvm"),
          "flutter --version": enoent("flutter"),
        },
        {
          env: { PATH: "/usr/local/bin", HOME: "/Users/operator" },
          fileExists: (path) => path === "/repo" || path === defaultFlutterDashboardDir(),
        }
      ),
    });

    const formatted = formatDoctorResults(results);

    expect(formatted).toContain("Probed:");
    expect(formatted).toContain("commands tried: fvm --version, flutter --version");
    expect(formatted).toContain("PATH searched: /usr/local/bin");
    expect(formatted).toContain("fallback paths: /Users/operator/fvm/bin/fvm");
  });

  it("fails gracefully and continues when package.json is missing", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      targetPath: "/repo",
      ports: [8080, 8085],
      deps: deps(passingCommands, {
        readText: () => {
          throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
        },
      }),
    });

    expect(results).toHaveLength(QUICKSTART_DOCTOR_CHECKS.length);
    const nodeResult = results.find((result) => result.name === "node");
    expect(nodeResult).toMatchObject({
      status: "fail",
      message:
        "package.json is missing or unreadable, so quickstart cannot verify Node compatibility.",
    });
    expect(nodeResult?.hint).toContain("Ensure package.json exists");
  });

  it("fails gracefully and continues when package.json is malformed JSON", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      targetPath: "/repo",
      ports: [8080, 8085],
      deps: deps(passingCommands, {
        readText: () => "{ not valid json",
      }),
    });

    expect(results).toHaveLength(QUICKSTART_DOCTOR_CHECKS.length);
    const nodeResult = results.find((result) => result.name === "node");
    expect(nodeResult).toMatchObject({
      status: "fail",
      message:
        "package.json is missing or unreadable, so quickstart cannot verify Node compatibility.",
    });
    expect(nodeResult?.hint).toContain("Ensure package.json exists");
  });

  it("fails gracefully when package.json does not declare engines.node", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      targetPath: "/repo",
      ports: [8080, 8085],
      deps: deps(passingCommands, {
        readText: () => JSON.stringify({ name: "my-package" }),
      }),
    });

    expect(results).toHaveLength(QUICKSTART_DOCTOR_CHECKS.length);
    const nodeResult = results.find((result) => result.name === "node");
    expect(nodeResult).toMatchObject({
      status: "fail",
      message:
        "package.json does not declare engines.node, so quickstart cannot verify Node compatibility.",
    });
    expect(nodeResult?.hint).toContain("Add engines.node to package.json");
  });

  it("isolates check failures so a throwing check produces a fail result and returns full results array", async () => {
    const results = await runQuickstartDoctor({
      repoRoot: "/repo",
      targetPath: "/repo",
      ports: [8080, 8085],
      deps: deps(passingCommands, {
        freeBytes: () => {
          throw new Error("statfs crash");
        },
      }),
    });

    expect(results).toHaveLength(QUICKSTART_DOCTOR_CHECKS.length);
    const diskResult = results.find((result) => result.name === "free-disk");
    expect(diskResult).toMatchObject({
      status: "fail",
      message: "check threw an unexpected error: statfs crash",
    });
    const nodeResult = results.find((result) => result.name === "node");
    expect(nodeResult?.status).toBe("pass");
  });
});
