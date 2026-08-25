import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getCorepackPath,
  injectScopedNpmReadTokenEnv,
  resolvePnpmStorePath,
  SANDBOX_SCOPED_NPMRC_PATH,
} from "../providers/sandbox.js";
import { toolError, toolOk } from "./result.js";
import { createMcpServer } from "./strict-server.js";

export const PNPM_INSTALL_MCP_NAME = "pnpm-install";
export const PNPM_INSTALL_PNPM_VERSION = "10.29.3";
// Keep this aligned with the pinned pnpm major above; pnpm 10 uses store/v10.
export const PNPM_INSTALL_STORE_VERSION = "v10";

export interface PnpmInstallResult {
  cwd: string;
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PnpmInstallDeps {
  actorRootFor: (actorId: string) => string | null;
  storeDir?: string;
  pnpmVersion?: string;
  run?: (opts: {
    cwd: string;
    args: string[];
    storeDir: string;
    pnpmVersion: string;
  }) => Promise<PnpmInstallResult>;
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function commonAncestor(paths: string[]): string {
  const split = paths.map((p) => p.split(sep).filter(Boolean));
  const common: string[] = [];
  for (let i = 0; ; i += 1) {
    const part = split[0]?.[i];
    if (!part || split.some((parts) => parts[i] !== part)) break;
    common.push(part);
  }
  return `${sep}${common.join(sep)}`;
}

function resolveInstallCwd(actorRoot: string, cwd: string): string {
  if (isAbsolute(cwd)) {
    throw new Error("cwd must be relative to your actor workdir");
  }
  const realRoot = realpathSync(actorRoot);
  const target = resolve(realRoot, cwd);
  if (!isContained(realRoot, target)) {
    throw new Error("cwd escapes your actor workdir");
  }
  const realTarget = realpathSync(target);
  if (!isContained(realRoot, realTarget)) {
    throw new Error("cwd resolves outside your actor workdir");
  }
  return realTarget;
}

function assertLooksLikePnpmProject(cwd: string): void {
  if (
    existsSync(join(cwd, "package.json")) ||
    existsSync(join(cwd, "pnpm-lock.yaml")) ||
    existsSync(join(cwd, "pnpm-workspace.yaml"))
  ) {
    return;
  }
  throw new Error("cwd must contain package.json, pnpm-lock.yaml, or pnpm-workspace.yaml");
}

function buildPnpmArgs(opts: {
  frozenLockfile?: boolean;
  prod?: boolean;
  dev?: boolean;
  storeDir: string;
}): string[] {
  if (opts.prod && opts.dev) {
    throw new Error("prod and dev are mutually exclusive");
  }
  const args = [
    "install",
    "--ignore-scripts",
    "--package-import-method=hardlink",
    "--store-dir",
    opts.storeDir,
  ];
  if (opts.frozenLockfile === true) args.push("--frozen-lockfile");
  if (opts.frozenLockfile === false) args.push("--no-frozen-lockfile");
  if (opts.prod) args.push("--prod");
  if (opts.dev) args.push("--dev");
  return args;
}

export function buildPnpmRebuildArgs(opts: { storeDir: string; packages?: string[] }): string[] {
  const pkgs = opts.packages && opts.packages.length > 0 ? opts.packages : ["better-sqlite3"];
  return ["rebuild", "-r", ...pkgs, "--store-dir", opts.storeDir];
}

export function alignPnpmInstallStoreDir(storeDir: string): string {
  const last = basename(storeDir);
  if (last && /^v\d+$/.test(last) && last !== PNPM_INSTALL_STORE_VERSION) {
    return join(dirname(storeDir), PNPM_INSTALL_STORE_VERSION);
  }
  return storeDir;
}

export function buildPnpmInstallBwrapArgs(opts: {
  cwd: string;
  pnpmArgs: string[];
  storeDir: string;
  pnpmVersion: string;
  tempPaths?: string[];
}) {
  const common = commonAncestor([opts.cwd, opts.storeDir]);
  const home = realpathSync(homedir());
  if (common === "/" || !isContained(home, common)) {
    throw new Error(
      `cannot sandbox pnpm install: project and pnpm store do not share a safe writable parent (${opts.cwd}, ${opts.storeDir})`
    );
  }
  const corepackPath = getCorepackPath();
  const args = [
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--dir",
    "/tmp/cache",
    "--bind",
    common,
    common,
    "--setenv",
    "PATH",
    process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    "--setenv",
    "NPM_CONFIG_STORE_DIR",
    opts.storeDir,
    "--setenv",
    "npm_config_store_dir",
    opts.storeDir,
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "TMP",
    "/tmp",
    "--setenv",
    "TEMP",
    "/tmp",
    "--setenv",
    "XDG_CACHE_HOME",
    "/tmp/cache",
    "--setenv",
    "npm_config_cache",
    "/tmp/cache/npm",
  ];

  injectScopedNpmReadTokenEnv(args, opts.tempPaths ?? [], SANDBOX_SCOPED_NPMRC_PATH);

  args.push("--chdir", opts.cwd, "--", corepackPath, `pnpm@${opts.pnpmVersion}`, ...opts.pnpmArgs);

  return args;
}

function truncate(text: string): string {
  const max = 20_000;
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

async function defaultRunPnpmInstall(opts: {
  cwd: string;
  args: string[];
  storeDir: string;
  pnpmVersion: string;
}): Promise<PnpmInstallResult> {
  const tempPaths: string[] = [];
  const bwrapArgs = buildPnpmInstallBwrapArgs({
    cwd: opts.cwd,
    pnpmArgs: opts.args,
    storeDir: opts.storeDir,
    pnpmVersion: opts.pnpmVersion,
    tempPaths,
  });
  const cleanupTempPaths = () => {
    for (const p of tempPaths) {
      try {
        unlinkSync(p);
      } catch {
        /* best effort */
      }
    }
  };
  return new Promise((resolveRun, reject) => {
    execFile(
      "bwrap",
      bwrapArgs,
      {
        cwd: opts.cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          NPM_CONFIG_STORE_DIR: opts.storeDir,
          npm_config_store_dir: opts.storeDir,
        },
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10 * 60 * 1000,
      },
      (err, stdout, stderr) => {
        const result: PnpmInstallResult = {
          cwd: opts.cwd,
          command: [`pnpm@${opts.pnpmVersion}`, ...opts.args],
          exitCode:
            typeof (err as { code?: unknown } | null)?.code === "number"
              ? (err as { code: number }).code
              : 0,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
        };
        if (err && result.exitCode === 0) {
          cleanupTempPaths();
          reject(err);
          return;
        }
        cleanupTempPaths();
        resolveRun(result);
      }
    );
  });
}

export function createPnpmInstallMcpServer(
  deps: PnpmInstallDeps,
  selfId: string,
  options?: { isFenced?: () => boolean }
): McpServer {
  const server = createMcpServer(
    { name: PNPM_INSTALL_MCP_NAME, version: "0.1.0" },
    { isFenced: options?.isFenced }
  );

  server.registerTool(
    "pnpm_install",
    {
      title: "Install pnpm dependencies without lifecycle scripts",
      description:
        "Run a host-mediated `pnpm install` for a project under your actor workdir. This materializes node_modules with hardlinks to the shared pnpm store, but always disables lifecycle scripts. Only frozen_lockfile, prod, and dev flags are supported.",
      inputSchema: {
        cwd: z
          .string()
          .optional()
          .describe("Relative path from your actor workdir. Defaults to '.'."),
        frozen_lockfile: z
          .boolean()
          .optional()
          .describe("Pass --frozen-lockfile when true, or --no-frozen-lockfile when false."),
        prod: z.boolean().optional().describe("Pass --prod to omit devDependencies."),
        dev: z.boolean().optional().describe("Pass --dev to install only devDependencies."),
      },
    },
    async ({ cwd, frozen_lockfile, prod, dev }) => {
      try {
        const actorRoot = deps.actorRootFor(selfId);
        if (!actorRoot) throw new Error(`unknown actor: ${selfId}`);
        const installCwd = resolveInstallCwd(actorRoot, cwd ?? ".");
        assertLooksLikePnpmProject(installCwd);
        const configuredStoreDir = alignPnpmInstallStoreDir(
          deps.storeDir ?? resolvePnpmStorePath()
        );
        mkdirSync(join(configuredStoreDir, "files"), { recursive: true });
        const storeDir = realpathSync(configuredStoreDir);
        const pnpmVersion = deps.pnpmVersion ?? PNPM_INSTALL_PNPM_VERSION;
        const installArgs = buildPnpmArgs({ frozenLockfile: frozen_lockfile, prod, dev, storeDir });
        const run = deps.run ?? defaultRunPnpmInstall;
        const installResult = await run({
          cwd: installCwd,
          args: installArgs,
          storeDir,
          pnpmVersion,
        });
        if (installResult.exitCode !== 0) {
          return toolOk(installResult);
        }
        const rebuildArgs = buildPnpmRebuildArgs({ storeDir });
        const rebuildResult = await run({
          cwd: installCwd,
          args: rebuildArgs,
          storeDir,
          pnpmVersion,
        });
        if (rebuildResult.exitCode !== 0) {
          return toolOk({
            cwd: installCwd,
            command: rebuildResult.command,
            exitCode: rebuildResult.exitCode,
            stdout: [installResult.stdout, rebuildResult.stdout].filter(Boolean).join("\n"),
            stderr: [installResult.stderr, rebuildResult.stderr].filter(Boolean).join("\n"),
          });
        }
        return toolOk({
          cwd: installCwd,
          command: installResult.command,
          exitCode: 0,
          stdout: [installResult.stdout, rebuildResult.stdout].filter(Boolean).join("\n"),
          stderr: [installResult.stderr, rebuildResult.stderr].filter(Boolean).join("\n"),
        });
      } catch (err) {
        return toolError(err);
      }
    }
  );

  return server;
}
