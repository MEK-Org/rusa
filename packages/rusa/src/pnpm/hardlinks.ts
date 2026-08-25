import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolvePnpmStorePath } from "../providers/sandbox.js";

export interface PnpmHardlinkProblem {
  file: string;
  reason: "not-linked" | "missing-store-file" | "not-same-inode";
  links: number;
  storeFile?: string;
}

export interface PnpmHardlinkCheckResult {
  projectDir: string;
  storeDir: string;
  sampled: number;
  problems: PnpmHardlinkProblem[];
}

export interface PnpmRelinkResult {
  projectDir: string;
  storeDir: string;
  scanned: number;
  relinked: number;
  alreadyLinked: number;
  missingStoreFile: number;
  failed: number;
}

function sameFile(a: string, b: string): boolean {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

function sha512Hex(path: string): string {
  const hash = createHash("sha512");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

export function pnpmStoreFileForContent(file: string, storeDir: string): string {
  const hex = sha512Hex(file);
  return join(storeDir, "files", hex.slice(0, 2), hex.slice(2));
}

function collectPackageFiles(root: string, limit: number | null): string[] {
  const out: string[] = [];
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === ".bin") continue;
        stack.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(path);
      if (limit !== null && out.length >= limit) return out;
    }
  }

  return out;
}

export function virtualStoreDir(projectDir: string): string {
  return join(projectDir, "node_modules", ".pnpm");
}

export function readPnpmStoreDirFromModulesYaml(projectDir: string): string | null {
  const modulesYaml = join(projectDir, "node_modules", ".modules.yaml");
  if (!existsSync(modulesYaml)) return null;
  const match = /^storeDir:\s*(.+)\s*$/m.exec(readFileSync(modulesYaml, "utf8"));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

export function checkPnpmHardlinks(opts: {
  projectDir: string;
  storeDir: string;
  sampleLimit?: number;
}): PnpmHardlinkCheckResult {
  const sampleLimit = opts.sampleLimit ?? 64;
  const files = collectPackageFiles(virtualStoreDir(opts.projectDir), sampleLimit);
  const problems: PnpmHardlinkProblem[] = [];

  for (const file of files) {
    const stat = statSync(file);
    const storeFile = pnpmStoreFileForContent(file, opts.storeDir);
    if (!existsSync(storeFile)) {
      problems.push({ file, reason: "missing-store-file", links: stat.nlink });
      continue;
    }
    if (stat.nlink <= 1) {
      problems.push({ file, reason: "not-linked", links: stat.nlink, storeFile });
      continue;
    }
    if (!sameFile(file, storeFile)) {
      problems.push({ file, reason: "not-same-inode", links: stat.nlink, storeFile });
    }
  }

  return {
    projectDir: opts.projectDir,
    storeDir: opts.storeDir,
    sampled: files.length,
    problems,
  };
}

export function relinkPnpmProject(opts: {
  projectDir: string;
  storeDir: string;
  dryRun?: boolean;
}): PnpmRelinkResult {
  const files = collectPackageFiles(virtualStoreDir(opts.projectDir), null);
  const result: PnpmRelinkResult = {
    projectDir: opts.projectDir,
    storeDir: opts.storeDir,
    scanned: 0,
    relinked: 0,
    alreadyLinked: 0,
    missingStoreFile: 0,
    failed: 0,
  };

  for (const file of files) {
    result.scanned += 1;
    const stat = statSync(file);
    if (stat.nlink > 1) {
      result.alreadyLinked += 1;
      continue;
    }
    const storeFile = pnpmStoreFileForContent(file, opts.storeDir);
    if (!existsSync(storeFile)) {
      result.missingStoreFile += 1;
      continue;
    }
    if (sameFile(file, storeFile)) {
      result.alreadyLinked += 1;
      continue;
    }
    if (opts.dryRun) {
      result.relinked += 1;
      continue;
    }

    const tmp = join(dirname(file), `.${basename(file)}.rusa-hardlink-${process.pid}`);
    try {
      try {
        unlinkSync(tmp);
      } catch {
        /* absent */
      }
      linkSync(storeFile, tmp);
      renameSync(tmp, file);
      result.relinked += 1;
    } catch {
      result.failed += 1;
      try {
        unlinkSync(tmp);
      } catch {
        /* absent */
      }
    }
  }

  return result;
}

export function resolvePnpmStoreDir(projectDir: string, storeDir?: string): string {
  return (
    storeDir ??
    readPnpmStoreDirFromModulesYaml(projectDir) ??
    process.env.NPM_CONFIG_STORE_DIR ??
    process.env.npm_config_store_dir ??
    resolvePnpmStorePath()
  );
}

export function findPnpmProjects(root: string, maxDepth = 4): string[] {
  const projects: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const pnpmDir = virtualStoreDir(current.dir);
    if (existsSync(pnpmDir)) {
      projects.push(current.dir);
      continue;
    }
    if (current.depth >= maxDepth) continue;
    for (const entry of readdirSync(current.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      stack.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }

  return projects.sort();
}

export function ensurePnpmStoreDir(storeDir: string): void {
  mkdirSync(join(storeDir, "files"), { recursive: true });
}
