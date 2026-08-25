/**
 * Git worktree operations for parallel task execution (an issue)
 *
 * Manages bare clones, worktree provisioning, and task branch lifecycle.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface BareCloneResult {
  success: boolean;
  path: string;
  isNew: boolean;
  error?: string;
}

export interface WorktreeAddResult {
  success: boolean;
  path: string;
  error?: string;
  isExisting?: boolean;
}

/**
 * Generate a stable repo key from host/org/repo.
 * Uses first 16 chars of SHA256 hash.
 */
export function generateRepoKey(repoId: string): string {
  // repoId is expected to be in format "host/org/repo"
  const normalized = repoId.toLowerCase().trim();
  const hash = createHash("sha256").update(normalized).digest("hex");
  return hash.slice(0, 16);
}

/**
 * Get the workspace root path for a repository.
 */
export function getWorkspaceRoot(mcHome: string, repoKey: string): string {
  return join(mcHome, "workspaces", repoKey);
}

/**
 * Get the bare clone path for a repository.
 */
export function getBareClonePath(mcHome: string, repoKey: string): string {
  return join(getWorkspaceRoot(mcHome, repoKey), "repo.git");
}

/**
 * Get the worktrees directory path.
 */
export function getWorktreesDir(mcHome: string, repoKey: string): string {
  return join(getWorkspaceRoot(mcHome, repoKey), "worktrees");
}

/**
 * Get the archive directory path for failed task snapshots.
 */
export function getArchiveDir(mcHome: string, repoKey: string): string {
  return join(getWorkspaceRoot(mcHome, repoKey), "archive");
}

/**
 * Execute a git command in a specific directory.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 50 * 1024 * 1024, // 50 MB
  }).trim();
}

const PRE_RECEIVE_HOOK = `#!/bin/sh
zero=0000000000000000000000000000000000000000

while read oldrev newrev refname; do
  case "$refname" in
    refs/heads/mc/*) ;;
    *)
      echo "git bridge rejects writes outside refs/heads/mc/*: $refname" >&2
      exit 1
      ;;
  esac

  if [ "$newrev" = "$zero" ]; then
    echo "git bridge rejects ref deletion: $refname" >&2
    exit 1
  fi

  if [ "$oldrev" != "$zero" ] && ! git merge-base --is-ancestor "$oldrev" "$newrev"; then
    echo "git bridge rejects non-fast-forward update: $refname" >&2
    exit 1
  fi
done
`;

/**
 * Install structural push protections for local git-bridge bare repositories.
 */
export function hardenBareRepoForGitBridge(barePath: string): void {
  const hooksDir = join(barePath, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-receive");
  writeFileSync(hookPath, PRE_RECEIVE_HOOK, "utf8");
  chmodSync(hookPath, 0o755);

  git(barePath, "config", "http.receivepack", "true");
  git(barePath, "config", "receive.denyDeletes", "true");
  git(barePath, "config", "receive.denyNonFastForwards", "true");
}

/**
 * Initialize an empty bare repository for the git bridge for a configured target.
 * This is used for local-only targets where the user's local clone is not
 * accessible inside the container; they push to the bridge and the bare repo
 * receives the refs. No-op if a valid bare repo already exists.
 */
export function initEmptyBareRepo(mcHome: string, repoId: string): string {
  const repoKey = generateRepoKey(repoId);
  const barePath = getBareClonePath(mcHome, repoKey);
  if (existsSync(barePath)) {
    try {
      if (isValidBareRepo(barePath)) {
        hardenBareRepoForGitBridge(barePath);
        return barePath;
      }
    } catch {
      // Fall through to recreate
    }
  }

  mkdirSync(dirname(barePath), { recursive: true });
  if (existsSync(barePath)) {
    rmSync(barePath, { recursive: true, force: true });
  }
  execFileSync("git", ["init", "--bare", barePath], { encoding: "utf8", stdio: "pipe" });
  hardenBareRepoForGitBridge(barePath);
  return barePath;
}

/**
 * Seed or update a bare repository for the git bridge from a local filesystem git repository.
 */
export function seedBareRepoFromLocalPath(opts: {
  mcHome: string;
  repoId: string;
  localPath: string;
}): string {
  const repoKey = generateRepoKey(opts.repoId);
  const barePath = getBareClonePath(opts.mcHome, repoKey);

  const hasCommits = (path: string): boolean => {
    try {
      execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
      return true;
    } catch {
      return false;
    }
  };

  if (!existsSync(barePath) || !isValidBareRepo(barePath) || !hasCommits(barePath)) {
    mkdirSync(dirname(barePath), { recursive: true });
    if (existsSync(barePath)) {
      rmSync(barePath, { recursive: true, force: true });
    }
    execFileSync("git", ["clone", "--bare", opts.localPath, barePath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    hardenBareRepoForGitBridge(barePath);
  } else {
    try {
      execFileSync("git", ["-C", barePath, "fetch", opts.localPath, "*:*"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      /* best effort fetch */
    }
    hardenBareRepoForGitBridge(barePath);
  }

  return barePath;
}

/**
 * Check if a directory is a valid git bare repository.
 */
function isValidBareRepo(path: string): boolean {
  try {
    const result = execFileSync("git", ["-C", path, "rev-parse", "--is-bare-repository"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return result === "true";
  } catch {
    return false;
  }
}

/**
 * Ensure a bare clone exists for a repository.
 * If it doesn't exist, creates it from the provided remote URL.
 */
export function ensureBareClone(opts: {
  mcHome: string;
  repoKey: string;
  remoteUrl: string;
}): BareCloneResult {
  const barePath = getBareClonePath(opts.mcHome, opts.repoKey);

  // Check if valid bare repo already exists
  if (existsSync(barePath) && isValidBareRepo(barePath)) {
    try {
      hardenBareRepoForGitBridge(barePath);
    } catch (configError) {
      console.warn(`[worktree] Failed to harden bare repo for ${opts.repoKey}: ${configError}`);
    }

    // Self-healing: ensure standard tracking refspec to prevent fetch conflicts in worktrees
    try {
      git(barePath, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    } catch (configError) {
      console.warn(`[worktree] Failed to update refspec for ${opts.repoKey}: ${configError}`);
    }

    // Fetch updates
    try {
      git(barePath, "fetch", "origin", "--prune");
      return { success: true, path: barePath, isNew: false };
    } catch (error) {
      // Continue - we'll use the existing repo even if fetch fails
      return {
        success: true,
        path: barePath,
        isNew: false,
        error: `Fetch failed: ${error}`,
      };
    }
  }

  // Create bare clone
  try {
    // Ensure parent directory exists
    mkdirSync(dirname(barePath), { recursive: true });

    // Clone as bare repository
    execFileSync("git", ["clone", "--bare", opts.remoteUrl, barePath], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Set up remote for fetching with standard tracking refspec
    git(barePath, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    hardenBareRepoForGitBridge(barePath);

    return { success: true, path: barePath, isNew: true };
  } catch (error) {
    return {
      success: false,
      path: barePath,
      isNew: false,
      error: `Failed to create bare clone: ${error}`,
    };
  }
}

/**
 * Update the bare clone by fetching from origin.
 */
export function updateBareClone(barePath: string): { success: boolean; error?: string } {
  try {
    git(barePath, "fetch", "origin", "--prune");
    return { success: true };
  } catch (error) {
    return { success: false, error: `Fetch failed: ${error}` };
  }
}

/**
 * Find an existing worktree that has the specified branch checked out.
 */
function findWorktreeForBranch(
  mcHome: string,
  repoKey: string,
  branchName: string
): { path: string } | null {
  const worktrees = listWorktrees(mcHome, repoKey);
  const normalizedTarget = branchName.replace(/^refs\/heads\//, "");

  for (const wt of worktrees) {
    if (!wt.branch || wt.isBare) continue;

    const normalizedWtBranch = wt.branch.replace(/^refs\/heads\//, "");
    if (normalizedWtBranch === normalizedTarget) {
      // Verify the path actually exists on disk to avoid returning stale worktrees
      if (existsSync(wt.path)) {
        return { path: wt.path };
      }
    }
  }
  return null;
}

/**
 * Handle "already checked out" error from git worktree add.
 * Extracts the existing worktree path from the error message or find it via listWorktrees.
 */
function handleWorktreeAlreadyCheckedOut(
  opts: { mcHome: string; repoKey: string; branchName: string },
  errorMsg: string
): WorktreeAddResult | null {
  if (!errorMsg.includes("is already checked out at")) {
    return null;
  }

  // Try to find it via listWorktrees first (most reliable)
  const existing = findWorktreeForBranch(opts.mcHome, opts.repoKey, opts.branchName);
  if (existing) {
    return { success: true, path: existing.path, isExisting: true };
  }

  // Fallback to regex if listWorktrees didn't see it for some reason
  // Git error format: fatal: 'branch-name' is already checked out at '/path/to/worktree'
  // Or: fatal: "branch-name" is already checked out at "/path/to/worktree"
  // We match the path which can be quoted or not.
  const regex = /is already checked out at (['"]?)(.+?)\1(?:\s|$)/m;
  const match = errorMsg.match(regex);
  if (match) {
    const existingPath = match[2].trim();
    return { success: true, path: existingPath, isExisting: true };
  }

  return null;
}

/**
 * Add a worktree for a specific branch.
 *
 * If `createIfMissingFrom` is supplied and `baseBranch` exists neither on
 * origin nor locally, the base branch is created from `createIfMissingFrom`
 * and pushed to origin before the worktree is provisioned. This is the
 * bootstrap path for long-lived feature branches that don't yet exist.
 */
export function addWorktree(opts: {
  mcHome: string;
  repoKey: string;
  key: string;
  branchName: string;
  baseBranch: string;
  createIfMissingFrom?: string;
  sourceRepoPath?: string;
}): WorktreeAddResult {
  const barePath = getBareClonePath(opts.mcHome, opts.repoKey);
  const worktreePath = join(getWorktreesDir(opts.mcHome, opts.repoKey), opts.key);

  // Ensure worktrees directory exists
  mkdirSync(getWorktreesDir(opts.mcHome, opts.repoKey), { recursive: true });

  // Prune stale worktrees before checking
  try {
    git(barePath, "worktree", "prune");
  } catch {
    // Ignore prune errors
  }

  // Check if the branch is already checked out at another worktree
  const existingWorktree = findWorktreeForBranch(opts.mcHome, opts.repoKey, opts.branchName);
  if (existingWorktree) {
    // Branch is already checked out - return the existing worktree path
    // This handles the case where a branch is reused for a new task
    if (opts.sourceRepoPath) {
      copyEnvFiles(opts.sourceRepoPath, existingWorktree.path);
    }
    return { success: true, path: existingWorktree.path, isExisting: true };
  }

  // Remove existing worktree if present (only if not in use by another branch)
  if (existsSync(worktreePath)) {
    try {
      // First try to remove via git
      git(barePath, "worktree", "remove", "-f", worktreePath);
    } catch {
      // If git removal fails, force remove the directory
      try {
        rmSync(worktreePath, { recursive: true, force: true });
        // Prune after manual removal
        try {
          git(barePath, "worktree", "prune");
        } catch {
          // Ignore prune errors
        }
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  try {
    // Always fetch the base branch from remote to ensure we branch from the latest state.
    // Without this, new issue branches can be cut from a stale local base branch,
    // causing immediate merge conflicts with recently-merged PRs.
    try {
      git(barePath, "fetch", "origin", `${opts.baseBranch}:${opts.baseBranch}`);
    } catch (fetchError) {
      // Fetch failed - check if the base branch at least exists locally as a fallback
      try {
        git(barePath, "rev-parse", `--verify`, `refs/heads/${opts.baseBranch}`);
        console.warn(
          `[worktree] Failed to fetch latest ${opts.baseBranch} from remote, using local copy: ${fetchError}`
        );
      } catch {
        // Bootstrap path: base branch exists nowhere yet. If a fallback source
        // branch was supplied (e.g. defaultBranch for a not-yet-created
        // feature branch), create baseBranch from it and push to origin.
        if (opts.createIfMissingFrom) {
          try {
            // Ensure the source ref is present locally before branching from it.
            git(
              barePath,
              "fetch",
              "origin",
              `${opts.createIfMissingFrom}:${opts.createIfMissingFrom}`
            );
            git(barePath, "branch", opts.baseBranch, opts.createIfMissingFrom);
            git(barePath, "push", "origin", opts.baseBranch);
            console.log(
              `[worktree] Created feature branch ${opts.baseBranch} from ${opts.createIfMissingFrom}`
            );
          } catch (createError) {
            return {
              success: false,
              path: worktreePath,
              error: `Failed to bootstrap base branch ${opts.baseBranch} from ${opts.createIfMissingFrom}: ${createError}`,
            };
          }
        } else {
          return {
            success: false,
            path: worktreePath,
            error: `Base branch ${opts.baseBranch} not available locally or from remote: ${fetchError}`,
          };
        }
      }
    }

    // Check if branch exists (locally or remotely)
    const branchExists = branchExistsInBare(barePath, opts.branchName);

    if (branchExists) {
      // Checkout existing branch
      try {
        git(barePath, "worktree", "add", "--checkout", worktreePath, opts.branchName);
      } catch (error) {
        const errorObj = error as { stderr?: unknown; message?: string };
        const errorMsg =
          (typeof errorObj.stderr === "string"
            ? errorObj.stderr
            : errorObj.stderr instanceof Buffer
              ? errorObj.stderr.toString()
              : undefined) ||
          errorObj.message ||
          String(error);

        const recovered = handleWorktreeAlreadyCheckedOut(opts, errorMsg);
        if (recovered) return recovered;

        throw error; // Re-throw if it's a different error
      }
    } else {
      // Create new branch from base branch
      try {
        git(barePath, "worktree", "add", "-b", opts.branchName, worktreePath, opts.baseBranch);
      } catch (error) {
        const errorObj = error as { stderr?: unknown; message?: string };
        const errorMsg =
          (typeof errorObj.stderr === "string"
            ? errorObj.stderr
            : errorObj.stderr instanceof Buffer
              ? errorObj.stderr.toString()
              : undefined) ||
          errorObj.message ||
          String(error);

        const recovered = handleWorktreeAlreadyCheckedOut(opts, errorMsg);
        if (recovered) return recovered;

        throw error;
      }
    }

    // Configure worktree git settings
    git(worktreePath, "config", "user.email", "rusa@localhost");
    git(worktreePath, "config", "user.name", "Meta Coder");

    // Set safe directory (for modern git versions)
    try {
      git(worktreePath, "config", "--local", "safe.directory", "*");
    } catch {
      // Ignore safe.directory config errors
    }

    // Copy .env files from source repo if provided (an issue)
    if (opts.sourceRepoPath) {
      copyEnvFiles(opts.sourceRepoPath, worktreePath);
    }

    return { success: true, path: worktreePath };
  } catch (error) {
    return {
      success: false,
      path: worktreePath,
      error: `Failed to add worktree: ${error}`,
    };
  }
}

/**
 * Recursively find and copy .env files from source to target.
 * (an issue)
 */
function copyEnvFiles(sourceDir: string, targetDir: string): void {
  if (!existsSync(sourceDir)) return;

  try {
    // 1. Copy root .env
    const sourceRootEnv = join(sourceDir, ".env");
    if (existsSync(sourceRootEnv)) {
      console.log(`[worktree] Copying .env from ${sourceDir} to ${targetDir}`);
      copyFileSync(sourceRootEnv, join(targetDir, ".env"));
    }

    // 2. Recursively find other .env files (e.g. in monorepo apps)
    // We use a simple recursive traversal instead of 'find' for better portability.
    const walk = (relPath: string) => {
      const fullSourcePath = join(sourceDir, relPath);
      const fullTargetPath = join(targetDir, relPath);

      if (!existsSync(fullSourcePath)) return;

      const stat = statSync(fullSourcePath);
      if (stat.isDirectory()) {
        // Skip node_modules and .git
        if (relPath.endsWith("node_modules") || relPath.endsWith(".git")) return;

        const entries = readdirSync(fullSourcePath);
        for (const entry of entries) {
          walk(join(relPath, entry));
        }
      } else if (stat.isFile() && basename(relPath) === ".env") {
        // Already handled root .env above, but this handles it again if we are deep.
        // If it's the root .env, we already copied it.
        if (relPath === ".env") return;

        console.log(`[worktree] Copying recursive .env: ${relPath}`);
        const dir = dirname(fullTargetPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        copyFileSync(fullSourcePath, fullTargetPath);
      }
    };

    const rootEntries = readdirSync(sourceDir);
    for (const entry of rootEntries) {
      // Skip node_modules and .git at the root
      if (entry === "node_modules" || entry === ".git") continue;
      walk(entry);
    }
  } catch (error) {
    console.warn(`[worktree] Failed to copy .env files from ${sourceDir}: ${error}`);
  }
}

/**
 * Check if a branch exists in the bare repository (local or remote).
 */
function branchExistsInBare(barePath: string, branchName: string): boolean {
  try {
    // Check local branch
    git(barePath, "rev-parse", "--verify", `refs/heads/${branchName}`);
    return true;
  } catch {
    // Check remote tracking branch
    try {
      git(barePath, "rev-parse", "--verify", `refs/remotes/origin/${branchName}`);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * List all worktrees for a repository.
 */
export function listWorktrees(
  mcHome: string,
  repoKey: string
): Array<{
  path: string;
  branch: string | null;
  isBare: boolean;
  isCurrent: boolean;
}> {
  const barePath = getBareClonePath(mcHome, repoKey);

  try {
    const output = git(barePath, "worktree", "list", "--porcelain");
    const worktrees: Array<{
      path: string;
      branch: string | null;
      isBare: boolean;
      isCurrent: boolean;
    }> = [];

    let current: { path: string; branch: string | null; isBare: boolean; isCurrent: boolean } = {
      path: "",
      branch: null,
      isBare: false,
      isCurrent: false,
    };

    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) {
        if (current.path) {
          worktrees.push({ ...current });
        }
        current = {
          path: line.slice(9).trim(),
          branch: null,
          isBare: false,
          isCurrent: false,
        };
      } else if (line.startsWith("branch ")) {
        current.branch = line.slice(7).trim().replace("refs/heads/", "");
      } else if (line === "bare") {
        current.isBare = true;
      } else if (line === "detached") {
        current.branch = null;
      } else if (line.startsWith("HEAD")) {
        // HEAD line, can be used for detached HEAD detection
      } else if (line === "") {
        // Empty line indicates end of worktree record
        if (current.path) {
          worktrees.push({ ...current });
          current = { path: "", branch: null, isBare: false, isCurrent: false };
        }
      }
    }

    // Don't forget the last one
    if (current.path) {
      worktrees.push(current);
    }

    return worktrees;
  } catch {
    return [];
  }
}

/**
 * Get the remote URL for a repository.
 * First tries config, falls back to origin remote.
 */
export function getRemoteUrl(repoPath: string): string | null {
  try {
    return git(repoPath, "remote", "get-url", "origin");
  } catch {
    return null;
  }
}

/**
 * Initialize workspace structure for a repository.
 */
export function initializeWorkspace(opts: {
  mcHome: string;
  repoId: string;
  remoteUrl: string;
  slotCount: number;
}): {
  success: boolean;
  repoKey: string;
  barePath: string;
  error?: string;
} {
  const repoKey = generateRepoKey(opts.repoId);

  try {
    // Create workspace structure
    mkdirSync(getWorktreesDir(opts.mcHome, repoKey), { recursive: true });
    mkdirSync(getArchiveDir(opts.mcHome, repoKey), { recursive: true });

    // Ensure bare clone exists
    const bareResult = ensureBareClone({
      mcHome: opts.mcHome,
      repoKey,
      remoteUrl: opts.remoteUrl,
    });

    if (!bareResult.success) {
      return {
        success: false,
        repoKey,
        barePath: bareResult.path,
        error: bareResult.error,
      };
    }

    return {
      success: true,
      repoKey,
      barePath: bareResult.path,
    };
  } catch (error) {
    return {
      success: false,
      repoKey,
      barePath: getBareClonePath(opts.mcHome, repoKey),
      error: `Failed to initialize workspace: ${error}`,
    };
  }
}
