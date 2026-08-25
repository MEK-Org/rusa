import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  alignPnpmInstallStoreDir,
  buildPnpmInstallBwrapArgs,
  buildPnpmRebuildArgs,
  createPnpmInstallMcpServer,
  PNPM_INSTALL_PNPM_VERSION,
  PNPM_INSTALL_STORE_VERSION,
  type PnpmInstallDeps,
  type PnpmInstallResult,
} from "./pnpm-install-mcp.js";

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first && first.type === "text" ? first.text : "";
}

function dataOf(result: CallToolResult): PnpmInstallResult | string {
  const text = textOf(result);
  try {
    return JSON.parse(text) as PnpmInstallResult;
  } catch {
    return text;
  }
}

function expectSetenv(args: string[], name: string, value: string) {
  const index = args.indexOf(name);
  expect(index).toBeGreaterThan(-1);
  expect(args[index - 1]).toBe("--setenv");
  expect(args[index + 1]).toBe(value);
}

describe("pnpm install MCP server", () => {
  const tempDirs: string[] = [];
  const originalHome = process.env.HOME;
  const originalNodeAuthToken = process.env.NODE_AUTH_TOKEN;
  const originalStampSecret = process.env.STAMP_SECRET;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalNodeAuthToken === undefined) {
      delete process.env.NODE_AUTH_TOKEN;
    } else {
      process.env.NODE_AUTH_TOKEN = originalNodeAuthToken;
    }
    if (originalStampSecret === undefined) {
      delete process.env.STAMP_SECRET;
    } else {
      process.env.STAMP_SECRET = originalStampSecret;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "mc-pnpm-install-mcp-"));
    tempDirs.push(root);
    const actorRoot = join(root, "workers", "actor-1");
    const repo = join(actorRoot, "repo");
    const storeDir = join(root, "pnpm-store", "v10");
    mkdirSync(repo, { recursive: true });
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"dependencies":{}}\n');
    const calls: Array<{ cwd: string; args: string[]; storeDir: string; pnpmVersion: string }> = [];
    const deps: PnpmInstallDeps = {
      actorRootFor: (actorId) => (actorId === "actor-1" ? actorRoot : null),
      storeDir,
      run: async (call) => {
        calls.push(call);
        return {
          cwd: call.cwd,
          command: ["pnpm", ...call.args],
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        };
      },
    };
    return { actorRoot, repo, root, storeDir, calls, deps };
  }

  it("runs a fixed pnpm install command and rebuilds better-sqlite3 for a project under the actor workdir", async () => {
    const { deps, repo, storeDir, calls } = fixture();
    const client = await connect(createPnpmInstallMcpServer(deps, "actor-1"));

    const result = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "repo", frozen_lockfile: true, prod: true },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([
      {
        cwd: repo,
        storeDir,
        args: [
          "install",
          "--ignore-scripts",
          "--package-import-method=hardlink",
          "--store-dir",
          storeDir,
          "--frozen-lockfile",
          "--prod",
        ],
        pnpmVersion: PNPM_INSTALL_PNPM_VERSION,
      },
      {
        cwd: repo,
        storeDir,
        args: ["rebuild", "-r", "better-sqlite3", "--store-dir", storeDir],
        pnpmVersion: PNPM_INSTALL_PNPM_VERSION,
      },
    ]);
    expect((dataOf(result) as PnpmInstallResult).command).toEqual(["pnpm", ...calls[0].args]);
  });

  it("builds pnpm rebuild args targeting better-sqlite3 with recursive flag and store-dir", () => {
    expect(buildPnpmRebuildArgs({ storeDir: "/store/v10" })).toEqual([
      "rebuild",
      "-r",
      "better-sqlite3",
      "--store-dir",
      "/store/v10",
    ]);
    expect(
      buildPnpmRebuildArgs({ storeDir: "/store/v10", packages: ["better-sqlite3", "esbuild"] })
    ).toEqual(["rebuild", "-r", "better-sqlite3", "esbuild", "--store-dir", "/store/v10"]);
  });

  it("allows --dev and --no-frozen-lockfile without exposing arbitrary args", async () => {
    const { deps, calls, storeDir } = fixture();
    const client = await connect(createPnpmInstallMcpServer(deps, "actor-1"));

    const result = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "repo", frozen_lockfile: false, dev: true },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(calls[0].args).toEqual([
      "install",
      "--ignore-scripts",
      "--package-import-method=hardlink",
      "--store-dir",
      storeDir,
      "--no-frozen-lockfile",
      "--dev",
    ]);
    expect(calls[1].args).toEqual(["rebuild", "-r", "better-sqlite3", "--store-dir", storeDir]);
  });

  it("pins the pnpm version used by installs and rebuilds so store layout stays stable", async () => {
    const { deps, calls } = fixture();
    const client = await connect(createPnpmInstallMcpServer(deps, "actor-1"));

    const result = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "repo" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(calls[0].pnpmVersion).toBe(PNPM_INSTALL_PNPM_VERSION);
    expect(calls[1].pnpmVersion).toBe(PNPM_INSTALL_PNPM_VERSION);
  });

  it("aligns host pnpm store paths to the install store version", async () => {
    expect(PNPM_INSTALL_STORE_VERSION).toBe("v10");
    expect(alignPnpmInstallStoreDir("/home/test/.local/share/pnpm/store/v11")).toBe(
      "/home/test/.local/share/pnpm/store/v10"
    );
    expect(alignPnpmInstallStoreDir("/home/test/.local/share/pnpm/store/v10")).toBe(
      "/home/test/.local/share/pnpm/store/v10"
    );
    expect(alignPnpmInstallStoreDir("/home/test/.local/share/pnpm/store")).toBe(
      "/home/test/.local/share/pnpm/store"
    );

    const root = mkdtempSync(join(tmpdir(), "mc-pnpm-install-store-align-"));
    tempDirs.push(root);
    const actorRoot = join(root, "workers", "actor-1");
    const repo = join(actorRoot, "repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"dependencies":{}}\n');
    const calls: Array<{ storeDir: string }> = [];
    const client = await connect(
      createPnpmInstallMcpServer(
        {
          actorRootFor: () => actorRoot,
          storeDir: join(root, "pnpm-store", "v11"),
          run: async (call) => {
            calls.push({ storeDir: call.storeDir });
            return {
              cwd: call.cwd,
              command: ["pnpm", ...call.args],
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          },
        },
        "actor-1"
      )
    );

    const result = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "repo" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(calls[0]?.storeDir).toBe(join(root, "pnpm-store", "v10"));
    expect(calls[1]?.storeDir).toBe(join(root, "pnpm-store", "v10"));
  });

  it("does not run rebuild if pnpm install fails", async () => {
    const { deps, calls } = fixture();
    deps.run = async (call) => {
      calls.push(call);
      return {
        cwd: call.cwd,
        command: ["pnpm", ...call.args],
        exitCode: 1,
        stdout: "",
        stderr: "install failed",
      };
    };
    const client = await connect(createPnpmInstallMcpServer(deps, "actor-1"));

    const result = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "repo" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(calls.length).toBe(1);
    const data = dataOf(result) as PnpmInstallResult;
    expect(data.exitCode).toBe(1);
    expect(data.stderr).toBe("install failed");
  });

  it("returns rebuild failure if pnpm rebuild fails", async () => {
    const { deps, calls } = fixture();
    let count = 0;
    deps.run = async (call) => {
      calls.push(call);
      count += 1;
      if (count === 1) {
        return {
          cwd: call.cwd,
          command: ["pnpm", ...call.args],
          exitCode: 0,
          stdout: "installed",
          stderr: "",
        };
      }
      return {
        cwd: call.cwd,
        command: ["pnpm", ...call.args],
        exitCode: 1,
        stdout: "",
        stderr: "rebuild failed",
      };
    };
    const client = await connect(createPnpmInstallMcpServer(deps, "actor-1"));

    const result = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "repo" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(calls.length).toBe(2);
    const data = dataOf(result) as PnpmInstallResult;
    expect(data.exitCode).toBe(1);
    expect(data.stderr).toBe("rebuild failed");
  });

  it("pins npm download cache inside the pnpm install bwrap tmpfs", () => {
    const root = mkdtempSync(join(process.cwd(), ".mc-pnpm-install-mcp-"));
    tempDirs.push(root);
    const repo = join(root, "workers", "actor-1", "repo");
    const storeDir = join(root, "pnpm-store", "v10");
    mkdirSync(repo, { recursive: true });
    mkdirSync(storeDir, { recursive: true });
    const args = buildPnpmInstallBwrapArgs({
      cwd: repo,
      pnpmArgs: ["install", "--ignore-scripts", "--store-dir", storeDir],
      storeDir,
      pnpmVersion: PNPM_INSTALL_PNPM_VERSION,
    });

    expectSetenv(args, "XDG_CACHE_HOME", "/tmp/cache");
    expectSetenv(args, "npm_config_cache", "/tmp/cache/npm");
  });

  it("injects a generated scoped npmrc into the pnpm install bwrap args", () => {
    process.env.NODE_AUTH_TOKEN = "pnpm-install-read-token";
    process.env.STAMP_SECRET = "pnpm-install-hmac-secret";
    const root = mkdtempSync(join(process.cwd(), ".mc-pnpm-install-auth-"));
    tempDirs.push(root);
    const repo = join(root, "workers", "actor-1", "repo");
    const storeDir = join(root, "pnpm-store", "v10");
    mkdirSync(repo, { recursive: true });
    mkdirSync(storeDir, { recursive: true });
    const tempPaths: string[] = [];

    const args = buildPnpmInstallBwrapArgs({
      cwd: repo,
      pnpmArgs: ["install", "--ignore-scripts", "--store-dir", storeDir],
      storeDir,
      pnpmVersion: PNPM_INSTALL_PNPM_VERSION,
      tempPaths,
    });

    const userconfig = args[args.indexOf("NPM_CONFIG_USERCONFIG") + 1];
    expectSetenv(args, "NPM_CONFIG_USERCONFIG", userconfig);
    expectSetenv(args, "npm_config_userconfig", userconfig);
    expect(userconfig).toBe("/tmp/rusa-npmrc");
    const targetIndex = args.indexOf(userconfig);
    expect(targetIndex).toBeGreaterThan(-1);
    expect(args[targetIndex - 2]).toBe("--ro-bind");
    const generatedNpmrc = args[targetIndex - 1];
    expect(generatedNpmrc).not.toBe(userconfig);
    expect(tempPaths).toContain(generatedNpmrc);
    const generated = readFileSync(generatedNpmrc, "utf-8");
    expect(generated).toContain("@thkp-eng:registry=https://registry.npmjs.org/");
    expect(generated).toContain("//registry.npmjs.org/:_authToken=pnpm-install-read-token");
    expect(args).not.toContain("pnpm-install-read-token");
    expect(args).not.toContain("STAMP_SECRET");
    expect(args).not.toContain("pnpm-install-hmac-secret");
    rmSync(generatedNpmrc, { force: true });
  });

  it("does not bind over a missing host npmrc when auth comes from NODE_AUTH_TOKEN", () => {
    const home = mkdtempSync(join(tmpdir(), "mc-pnpm-install-home-"));
    tempDirs.push(home);
    process.env.HOME = home;
    process.env.NODE_AUTH_TOKEN = "pnpm-install-env-token";
    const repo = join(home, "workers", "actor-1", "repo");
    const storeDir = join(home, "pnpm-store", "v10");
    mkdirSync(repo, { recursive: true });
    mkdirSync(storeDir, { recursive: true });
    const tempPaths: string[] = [];

    const args = buildPnpmInstallBwrapArgs({
      cwd: repo,
      pnpmArgs: ["install", "--ignore-scripts", "--store-dir", storeDir],
      storeDir,
      pnpmVersion: PNPM_INSTALL_PNPM_VERSION,
      tempPaths,
    });

    expectSetenv(args, "NPM_CONFIG_USERCONFIG", "/tmp/rusa-npmrc");
    expectSetenv(args, "npm_config_userconfig", "/tmp/rusa-npmrc");
    const targetIndex = args.indexOf("/tmp/rusa-npmrc");
    expect(targetIndex).toBeGreaterThan(-1);
    expect(args[targetIndex - 2]).toBe("--ro-bind");
    const generatedNpmrc = args[targetIndex - 1];
    expect(tempPaths).toContain(generatedNpmrc);
    expect(args).not.toContain(join(home, ".npmrc"));
    const generated = readFileSync(generatedNpmrc, "utf-8");
    expect(generated).toContain("//registry.npmjs.org/:_authToken=pnpm-install-env-token");
    expect(args).not.toContain("pnpm-install-env-token");
    rmSync(generatedNpmrc, { force: true });
  });

  it("rejects absolute paths and parent escapes", async () => {
    const { deps } = fixture();
    const client = await connect(createPnpmInstallMcpServer(deps, "actor-1"));

    const absolute = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "/tmp" },
    })) as CallToolResult;
    const parent = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "../actor-2/repo" },
    })) as CallToolResult;

    expect(absolute.isError).toBe(true);
    expect(textOf(absolute)).toContain("cwd must be relative");
    expect(parent.isError).toBe(true);
    expect(textOf(parent)).toContain("cwd escapes");
  });

  it("rejects symlink escapes out of the actor workdir", async () => {
    const { actorRoot, deps, root } = fixture();
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "package.json"), "{}\n");
    symlinkSync(outside, join(actorRoot, "outside-link"));
    const client = await connect(createPnpmInstallMcpServer(deps, "actor-1"));

    const result = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "outside-link" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cwd resolves outside");
  });

  it("rejects prod and dev together", async () => {
    const { deps } = fixture();
    const client = await connect(createPnpmInstallMcpServer(deps, "actor-1"));

    const result = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "repo", prod: true, dev: true },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("prod and dev are mutually exclusive");
  });

  it("requires a pnpm-looking project marker", async () => {
    const { actorRoot, deps } = fixture();
    mkdirSync(join(actorRoot, "empty"));
    const client = await connect(createPnpmInstallMcpServer(deps, "actor-1"));

    const result = (await client.callTool({
      name: "pnpm_install",
      arguments: { cwd: "empty" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cwd must contain");
  });
});
