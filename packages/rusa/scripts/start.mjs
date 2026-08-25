#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureSubmodule } from "./ensure-submodule.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "../..");
const distDir = join(packageRoot, "dist");
const buildStampPath = join(distDir, ".build-ok");
const installStampPath = join(distDir, ".install-ok");

const INSTALL_SOURCES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "packages/rusa/package.json",
  "third_party/glass_goals/packages/goals-core/package.json",
  "third_party/glass_goals/packages/goals-types/package.json",
];

const SOURCE_ROOTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "packages/rusa/package.json",
  "packages/rusa/tsconfig.json",
  "packages/rusa/tsup.config.ts",
  "packages/rusa/src",
  "packages/rusa/assets",
  "packages/rusa/scripts/build-dashboard-ui.mjs",
  "packages/rusa/scripts/copy-assets.mjs",
  "packages/rusa/flutter_dashboard/lib",
  "packages/rusa/flutter_dashboard/web",
  "packages/rusa/flutter_dashboard/pubspec.yaml",
  "packages/rusa/flutter_dashboard/pubspec.lock",
];

const IGNORED_SOURCE_PATTERNS = [
  /(^|[/\\])node_modules([/\\]|$)/,
  /(^|[/\\])dist([/\\]|$)/,
  /(^|[/\\])\.git([/\\]|$)/,
  /(^|[/\\]).*\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|[/\\])__snapshots__([/\\]|$)/,
];

export function parseStartArgs(argv) {
  const forwardedArgs = [];
  let skipBuild = false;

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }
    forwardedArgs.push(arg);
  }

  return { skipBuild, forwardedArgs };
}

export function collectSourceFiles(root = repoRoot, sourceRoots = SOURCE_ROOTS) {
  const files = [];

  function visit(path) {
    const rel = relative(root, path);
    if (rel && IGNORED_SOURCE_PATTERNS.some((pattern) => pattern.test(rel))) {
      return;
    }

    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }

    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) {
        visit(join(path, entry));
      }
      return;
    }

    if (stat.isFile()) {
      files.push(path);
    }
  }

  for (const sourceRoot of sourceRoots) {
    visit(resolve(root, sourceRoot));
  }

  return files;
}

export function newestMtimeMs(paths) {
  let newest = 0;
  for (const path of paths) {
    const stat = statSync(path);
    newest = Math.max(newest, stat.mtimeMs);
  }
  return newest;
}

export function readStampMtimeMs(path = buildStampPath) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function getBuildState({
  root = repoRoot,
  sourceRoots = SOURCE_ROOTS,
  stampPath = buildStampPath,
} = {}) {
  const sourceFiles = collectSourceFiles(root, sourceRoots);
  const newestSourceMtimeMs = newestMtimeMs(sourceFiles);
  const stampMtimeMs = readStampMtimeMs(stampPath);

  return {
    sourceFiles,
    newestSourceMtimeMs,
    stampMtimeMs,
    stale: stampMtimeMs === null || newestSourceMtimeMs > stampMtimeMs,
  };
}

export function currentHeadSha(root = repoRoot) {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

export function writeBuildStamp({ root = repoRoot, stampPath = buildStampPath } = {}) {
  mkdirSync(dirname(stampPath), { recursive: true });
  let stamp;
  try {
    stamp = currentHeadSha(root);
  } catch {
    stamp = new Date().toISOString();
  }
  writeFileSync(stampPath, `${stamp}\n`, "utf8");
}

export function readInstallStampContent(path = installStampPath) {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

export function currentSubmoduleSha(root = repoRoot) {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", ":third_party/glass_goals"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function getInstallState({
  root = repoRoot,
  installSources = INSTALL_SOURCES,
  stampPath = installStampPath,
  getSubmoduleSha = currentSubmoduleSha,
} = {}) {
  let nodeModulesExists = false;
  try {
    nodeModulesExists = statSync(join(root, "node_modules")).isDirectory();
  } catch {
    nodeModulesExists = false;
  }

  const sourceFiles = collectSourceFiles(root, installSources);
  const newestSourceMtimeMs = newestMtimeMs(sourceFiles);
  const stampMtimeMs = readStampMtimeMs(stampPath);
  const stampContent = readInstallStampContent(stampPath);

  let submoduleSha = "";
  try {
    submoduleSha = getSubmoduleSha(root);
  } catch {
    // ignore
  }

  const submoduleChanged = submoduleSha !== "" && stampContent !== submoduleSha;

  return {
    nodeModulesExists,
    sourceFiles,
    newestSourceMtimeMs,
    stampMtimeMs,
    submoduleChanged,
    stale:
      !nodeModulesExists ||
      stampMtimeMs === null ||
      newestSourceMtimeMs > stampMtimeMs ||
      submoduleChanged,
  };
}

export function writeInstallStamp({
  root = repoRoot,
  stampPath = installStampPath,
  getSubmoduleSha = currentSubmoduleSha,
} = {}) {
  mkdirSync(dirname(stampPath), { recursive: true });
  let stamp;
  try {
    stamp = getSubmoduleSha(root);
  } catch {
    stamp = "";
  }
  writeFileSync(stampPath, `${stamp}\n`, "utf8");
}

const getInstallStateDefault = getInstallState;
const writeInstallStampDefault = writeInstallStamp;

function runCommand(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} exited on signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
        return;
      }
      resolvePromise();
    });
  });
}

function packageManagerCommand(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /(^|[/\\])pnpm[^/\\]*$/.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  return { command: "pnpm", args };
}

async function runPackageBuild() {
  const build = packageManagerCommand(["--filter", "./packages/rusa", "build"]);
  await runCommand(build.command, build.args, { cwd: repoRoot });
}

async function installPackages() {
  const build = packageManagerCommand(["install"]);
  await runCommand(build.command, build.args, { cwd: repoRoot });
}

export async function buildIfStale({
  skipBuild = false,
  getState = getBuildState,
  getInstallState = getInstallStateDefault,
  install = installPackages,
  writeInstallStamp = writeInstallStampDefault,
  runBuild = runPackageBuild,
  writeStamp = writeBuildStamp,
  log = console.error,
} = {}) {
  if (skipBuild) {
    log("[start] --skip-build set; bypassing build staleness check.");
    return { built: false, skipped: true };
  }

  const installState = getInstallState();
  if (installState.stale) {
    log("[start] dependencies are stale; running pnpm install.");
    await install();
    writeInstallStamp();
    log("[start] pnpm install finished; install stamp updated.");
  } else {
    log("[start] dependencies are current; bypassing install.");
  }

  const state = getState();
  if (!state.stale) {
    log("[start] build is current; starting without rebuild.");
    return { built: false, skipped: false };
  }

  const reason =
    state.stampMtimeMs === null ? "no build stamp found" : "source is newer than build stamp";
  log(`[start] build is stale (${reason}); running pnpm --filter ./packages/rusa build.`);
  await runBuild();
  writeStamp();
  log("[start] build finished; stamp updated.");
  return { built: true, skipped: false };
}

async function main() {
  const { skipBuild, forwardedArgs } = parseStartArgs(process.argv.slice(2));
  ensureSubmodule();
  await buildIfStale({ skipBuild });

  const env = { ...process.env };
  if (!env.RUSA_HOME) {
    env.RUSA_HOME = join(env.HOME ?? process.cwd(), ".rusa-test");
  }

  await runCommand(process.execPath, [join(distDir, "cli.js"), ...forwardedArgs], {
    cwd: repoRoot,
    env,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[start] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
