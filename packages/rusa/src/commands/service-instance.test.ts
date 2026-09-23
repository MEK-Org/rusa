import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readUnitPathEnv,
  resolveExecutableOnPath,
  resolveExecutableSource,
  resolvePathEnvForUnit,
  resolveProbePathEnv,
  resolveServiceDashboardUrl,
  resolveServiceHome,
  resolveServiceInstance,
} from "./service-instance.js";

const originalArgv = [...process.argv];
const originalEnv = { PATH: process.env.PATH, FNM_DIR: process.env.FNM_DIR };

afterEach(() => {
  process.argv = [...originalArgv];
  process.env.PATH = originalEnv.PATH;
  process.env.FNM_DIR = originalEnv.FNM_DIR;
});

describe("service-instance", () => {
  it("maps production and staging to distinct homes and unit names", () => {
    const production = resolveServiceInstance("production");
    const staging = resolveServiceInstance("staging");

    expect(production.serviceUnit).toBe("rusa.service");
    expect(staging.serviceUnit).toBe("rusa-staging.service");
    expect(production.mcHome).toBe(resolveServiceHome("production"));
    expect(staging.mcHome).toBe(resolveServiceHome("staging"));
    expect(production.mcHome).not.toBe(staging.mcHome);
  });

  it("builds dashboard urls for tailscale hostnames and services", () => {
    expect(resolveServiceDashboardUrl("rusa.tail.ts.net")).toBe("https://rusa.tail.ts.net/");
    expect(resolveServiceDashboardUrl(undefined, "rusabot", "tail.ts.net")).toBe(
      "https://rusabot.tail.ts.net/"
    );
    expect(resolveServiceDashboardUrl(undefined, "rusabot")).toBeNull();
  });

  it("resolves package mode from the current process entry", () => {
    process.argv[1] = "/tmp/fake/dist/cli.js";

    const source = resolveExecutableSource("package");

    expect(source.cliPath).toBe("/tmp/fake/dist/cli.js");
    expect(source.nodePath).toBe(process.execPath);
  });

  it("resolves self mode from an explicit repo path", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "rusa-self-"));
    const packageDir = join(repoRoot, "packages", "rusa");
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    writeFileSync(join(packageDir, "package.json"), '{"name":"rusa"}\n', "utf-8");
    writeFileSync(join(packageDir, "dist", "cli.js"), "console.log('ok');\n", "utf-8");

    const source = resolveExecutableSource("self", repoRoot);

    expect(source.cliPath).toBe(join(packageDir, "dist", "cli.js"));
    expect(source.nodePath).toBe(process.execPath);
  });

  it("fails self mode when the built cli is missing", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "rusa-self-missing-"));
    const packageDir = join(repoRoot, "packages", "rusa");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), '{"name":"rusa"}\n', "utf-8");

    expect(() => resolveExecutableSource("self", repoRoot)).toThrow(/Run 'pnpm build'/);
  });
});

describe("resolvePathEnvForUnit", () => {
  it("rewrites ANY ephemeral fnm multishell bin (even a stale shell's) to the stable bin", () => {
    process.env.FNM_DIR = "/home/u/.local/share/fnm";
    const stableBin = `/home/u/.local/share/fnm/node-versions/${process.version}/installation/bin`;
    // A multishell id that is NOT this process's current shell — the old exact-match
    // sanitizer would have left it baked into the unit.
    process.env.PATH = `/run/user/1898434496/fnm_multishells/1271_1782478825333/bin:/usr/bin`;

    const result = resolvePathEnvForUnit().split(":");
    expect(result).toContain(stableBin);
    expect(result.some((p) => p.includes("fnm_multishells"))).toBe(false);
    expect(result).toContain("/usr/bin");
  });

  it("dedupes repeated segments while preserving first-occurrence order", () => {
    process.env.FNM_DIR = "/home/u/.local/share/fnm";
    process.env.PATH = "/home/u/.local/bin:/usr/bin:/home/u/.local/bin:/bin";
    expect(resolvePathEnvForUnit()).toBe("/home/u/.local/bin:/usr/bin:/bin");
  });
});

describe("readUnitPathEnv", () => {
  it("reads the PATH an instance unit assigns", () => {
    const unit = [
      "[Service]",
      "Environment=RUSA_HOME=/home/u/.rusa",
      "Environment=PATH=/home/u/.local/bin:/usr/bin:/bin",
      "Restart=always",
    ].join("\n");
    expect(readUnitPathEnv(unit)).toBe("/home/u/.local/bin:/usr/bin:/bin");
  });

  it("accepts the quoted spelling an operator drop-in may use", () => {
    expect(readUnitPathEnv('Environment="PATH=/opt/bin:/usr/bin"')).toBe("/opt/bin:/usr/bin");
  });

  it("takes the last assignment, because that is the one systemd applies", () => {
    const unit = ["Environment=PATH=/first/bin", "Environment=PATH=/second/bin"].join("\n");
    expect(readUnitPathEnv(unit)).toBe("/second/bin");
  });

  it("returns null for a unit that assigns no PATH, rather than an empty one", () => {
    expect(readUnitPathEnv("[Service]\nEnvironment=RUSA_HOME=/home/u/.rusa")).toBeNull();
    expect(readUnitPathEnv("Environment=PATH=")).toBeNull();
    // A different variable that merely ends in PATH must not be mistaken for it.
    expect(readUnitPathEnv("Environment=RUSA_SLACK_BOT_TOKEN_PATH=/tmp/tok")).toBeNull();
  });
});

describe("resolveProbePathEnv", () => {
  it("prefers the installed instance unit over the shell that ran the installer", () => {
    // Issue #525: installing from a minimal environment wrote a coordinator unit
    // whose PATH had no provider CLI on it. The instance unit on disk does.
    process.env.PATH = "/usr/bin:/bin";
    const unit = "[Service]\nEnvironment=PATH=/opt/providers/bin:/usr/bin:/bin";

    expect(resolveProbePathEnv(unit)).toEqual({
      path: "/opt/providers/bin:/usr/bin:/bin",
      source: "instance-unit",
    });
  });

  it("falls back to this process when no instance unit is installed yet", () => {
    process.env.FNM_DIR = "";
    process.env.PATH = "/usr/bin:/bin";

    expect(resolveProbePathEnv(null)).toEqual({ path: "/usr/bin:/bin", source: "process" });
  });

  it("falls back when the instance unit exists but assigns no PATH of its own", () => {
    process.env.FNM_DIR = "";
    process.env.PATH = "/usr/bin:/bin";

    expect(resolveProbePathEnv("[Service]\nRestart=always").source).toBe("process");
  });
});

describe("resolveExecutableOnPath", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rusa-path-resolve-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds an executable on the given PATH, not on this process's", () => {
    writeFileSync(join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = "/nonexistent";

    expect(resolveExecutableOnPath("codex", `${dir}:/usr/bin`)).toBe(join(dir, "codex"));
  });

  it("returns null for a name that is present but not executable", () => {
    // A non-executable file would still satisfy an existsSync check while the
    // probe's tmux session fails to launch it.
    writeFileSync(join(dir, "codex"), "not a program", { mode: 0o644 });

    expect(resolveExecutableOnPath("codex", dir)).toBeNull();
  });

  it("returns null for a directory that shares the command's name", () => {
    mkdirSync(join(dir, "codex"));

    expect(resolveExecutableOnPath("codex", dir)).toBeNull();
  });

  it("treats a command containing a slash as the path it already is", () => {
    writeFileSync(join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });

    expect(resolveExecutableOnPath(join(dir, "codex"), "/nonexistent")).toBe(join(dir, "codex"));
    expect(resolveExecutableOnPath(join(dir, "absent"), dir)).toBeNull();
  });

  it("skips empty segments rather than resolving against the working directory", () => {
    writeFileSync(join(dir, "codex"), "#!/bin/sh\n", { mode: 0o755 });

    expect(resolveExecutableOnPath("codex", `::${dir}`)).toBe(join(dir, "codex"));
  });
});
