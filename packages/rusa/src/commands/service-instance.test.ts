import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveExecutableSource,
  resolvePathEnvForUnit,
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
